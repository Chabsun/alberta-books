/**
 * Financial reports. Everything is computed from posted journal lines, so the
 * reports can never disagree with the ledger.
 */
import type { Db } from '../db/connection'
import { UserError } from '../errors'
import { fiscalYearOf, lastMonths, todayIso, addDays, monthEnd } from '../../shared/dates'
import type {
  AccountLedger,
  AccountType,
  BalanceSheet,
  Dashboard,
  FiledGstReturn,
  GifiLine,
  GifiReport,
  GstReturn,
  IncomeStatement,
  ReportRow,
  TrialBalance
} from '../../shared/types'
import { accountIdByRole, getAccount, normalBalance } from './accounts'
import { listInvoices } from './invoices'
import { listEntries, postEntry, type NewLine } from './ledger'
import { getSettings, updateSettings } from './settings'
import { listVehicles, vehicleBenefit, vehicleLimits } from './vehicles'

interface Totals {
  id: number
  code: string
  name: string
  type: AccountType
  gifi_code: string | null
  role: string | null
  debit: number
  credit: number
}

/** Debit/credit totals per account for posted lines dated in [from, to]. `from` null = since the beginning. */
function totals(db: Db, from: string | null, to: string, excludeSource?: string): Totals[] {
  return db.all<Totals>(
    `SELECT a.id, a.code, a.name, a.type, a.gifi_code, a.role,
            COALESCE(SUM(l.debit), 0) AS debit, COALESCE(SUM(l.credit), 0) AS credit
     FROM accounts a
     JOIN ledger l ON l.account_id = a.id
     WHERE l.date <= ? AND l.date >= ? AND l.source <> ?
     GROUP BY a.id
     ORDER BY a.code`,
    to,
    from ?? '0000-00-00',
    excludeSource ?? ''
  )
}

function row(t: Totals, amount: number): ReportRow {
  return { accountId: t.id, code: t.code, name: t.name, gifiCode: t.gifi_code, amountCents: amount }
}

const sum = (rows: ReportRow[]) => rows.reduce((s, r) => s + r.amountCents, 0)

export function incomeStatement(db: Db, from: string, to: string): IncomeStatement {
  const t = totals(db, from, to)
  const income = t.filter((x) => x.type === 'income').map((x) => row(x, normalBalance(x.type, x.debit, x.credit)))
  const expenses = t.filter((x) => x.type === 'expense').map((x) => row(x, normalBalance(x.type, x.debit, x.credit)))
  const nonZero = (r: ReportRow) => r.amountCents !== 0
  const totalIncome = sum(income)
  const totalExpenses = sum(expenses)
  return {
    from,
    to,
    income: income.filter(nonZero),
    expenses: expenses.filter(nonZero),
    totalIncomeCents: totalIncome,
    totalExpensesCents: totalExpenses,
    netIncomeCents: totalIncome - totalExpenses
  }
}

function netIncome(db: Db, from: string | null, to: string): number {
  if (from !== null && from > to) return 0
  const t = totals(db, from, to)
  return t.reduce((s, x) => {
    if (x.type === 'income') return s + (x.credit - x.debit)
    if (x.type === 'expense') return s - (x.debit - x.credit)
    return s
  }, 0)
}

export function balanceSheet(db: Db, asOf: string): BalanceSheet {
  const { fiscalYearEndMonth } = getSettings(db)
  const fy = fiscalYearOf(asOf, fiscalYearEndMonth)
  const beforeYear = addDays(fy.start, -1)
  const t = totals(db, null, asOf)

  const assets = t.filter((x) => x.type === 'asset').map((x) => row(x, normalBalance(x.type, x.debit, x.credit)))
  const liabilities = t
    .filter((x) => x.type === 'liability')
    .map((x) => row(x, normalBalance(x.type, x.debit, x.credit)))

  // Earnings and dividends of earlier fiscal years roll into retained earnings.
  const priorEarnings = netIncome(db, null, beforeYear)
  const currentEarnings = netIncome(db, fy.start, asOf)
  const dividendsId = accountIdByRole(db, 'dividends')
  const retainedId = accountIdByRole(db, 'retained_earnings')
  const dividendsBalance = (from: string | null, to: string) => {
    if (from !== null && from > to) return 0
    const d = totals(db, from, to).find((x) => x.id === dividendsId)
    return d ? d.debit - d.credit : 0
  }
  const priorDividends = dividendsBalance(null, beforeYear)
  const currentDividends = dividendsBalance(fy.start, asOf)

  const equity: ReportRow[] = []
  for (const x of t.filter((a) => a.type === 'equity')) {
    if (x.id === dividendsId) continue
    let amount = normalBalance(x.type, x.debit, x.credit)
    if (x.id === retainedId) amount += priorEarnings - priorDividends
    equity.push(row(x, amount))
  }
  if (!equity.some((r) => r.accountId === retainedId) && priorEarnings - priorDividends !== 0) {
    const re = getAccount(db, retainedId)
    equity.push({ accountId: re.id, code: re.code, name: re.name, gifiCode: re.gifiCode, amountCents: priorEarnings - priorDividends })
  }
  if (currentDividends !== 0) {
    const d = getAccount(db, dividendsId)
    equity.push({ accountId: d.id, code: d.code, name: d.name, gifiCode: d.gifiCode, amountCents: -currentDividends })
  }
  equity.push({ accountId: 0, code: '', name: 'Net income for the year to date', gifiCode: null, amountCents: currentEarnings })

  const nonZero = (r: ReportRow) => r.amountCents !== 0 || r.accountId === 0
  const totalAssets = sum(assets)
  const totalLiabilities = sum(liabilities)
  const totalEquity = sum(equity)
  return {
    asOf,
    fiscalYearStart: fy.start,
    assets: assets.filter(nonZero),
    liabilities: liabilities.filter(nonZero),
    equity: equity.filter(nonZero),
    totalAssetsCents: totalAssets,
    totalLiabilitiesCents: totalLiabilities,
    totalEquityCents: totalEquity,
    balanced: totalAssets === totalLiabilities + totalEquity
  }
}

export function trialBalance(db: Db, asOf: string): TrialBalance {
  const rows = totals(db, null, asOf)
    .map((x) => {
      const net = x.debit - x.credit
      return {
        accountId: x.id,
        code: x.code,
        name: x.name,
        type: x.type,
        debitCents: net > 0 ? net : 0,
        creditCents: net < 0 ? -net : 0
      }
    })
    .filter((r) => r.debitCents !== 0 || r.creditCents !== 0)
  return {
    asOf,
    rows,
    totalDebitCents: rows.reduce((s, r) => s + r.debitCents, 0),
    totalCreditCents: rows.reduce((s, r) => s + r.creditCents, 0)
  }
}

// ---------------------------------------------------------------------------
// GST/HST return (GST34 lines). Alberta has no PST, so only GST applies.
// ---------------------------------------------------------------------------

interface GstAdjustment {
  label: string
  amountCents: number
  /** Expense account the adjustment is charged to when the return is filed. */
  accountCode: string
}

/**
 * Line 104 adjustments that fall in this period:
 *  - GST on the shareholder's company-car benefit for calendar year Y, due in
 *    the return covering the last day of February of Y+1 (ETA s.173);
 *  - GST claimed on vehicle lease costs above the cap, repaid in the return
 *    covering the fiscal year end (ETA s.235).
 */
function gstAdjustments(db: Db, from: string, to: string): GstAdjustment[] {
  const out: GstAdjustment[] = []
  const vehicles = listVehicles(db)
  if (vehicles.length === 0) return out
  const { fiscalYearEndMonth } = getSettings(db)
  for (let y = Number(from.slice(0, 4)) - 1; y <= Number(to.slice(0, 4)); y++) {
    const febEnd = monthEnd(`${y + 1}-02-01`)
    if (febEnd < from || febEnd > to) continue
    for (const v of vehicles) {
      const b = vehicleBenefit(db, v.id, y)
      if (b.gstToRemitCents > 0) out.push({ label: `GST on ${y} company-car benefit – ${v.name}`, amountCents: b.gstToRemitCents, accountCode: '5231' })
    }
  }
  const fyEnd = fiscalYearOf(to, fiscalYearEndMonth).end
  const prevFyEnd = fiscalYearOf(addDays(fiscalYearOf(to, fiscalYearEndMonth).start, -1), fiscalYearEndMonth).end
  for (const end of [fyEnd, prevFyEnd]) {
    if (end < from || end > to) continue
    for (const v of vehicles) {
      const lim = vehicleLimits(db, v.id, end)
      if (lim.leaseItcRepayCents > 0) out.push({ label: `GST on lease cost over the cap (FY ending ${end}) – ${v.name}`, amountCents: lim.leaseItcRepayCents, accountCode: '5233' })
    }
  }
  return out
}

export function gstReturn(db: Db, from: string, to: string): GstReturn {
  const t = totals(db, from, to, 'gst_return')
  const collectedId = accountIdByRole(db, 'gst_collected')
  const itcId = accountIdByRole(db, 'gst_itc')
  const collected = t.find((x) => x.id === collectedId)
  const itc = t.find((x) => x.id === itcId)
  const line103 = collected ? collected.credit - collected.debit : 0
  const adjustments = gstAdjustments(db, from, to)
  const line104 = adjustments.reduce((s, a) => s + a.amountCents, 0)
  const line106 = itc ? itc.debit - itc.credit : 0
  const line101 = t.filter((x) => x.type === 'income').reduce((s, x) => s + (x.credit - x.debit), 0)
  const filedRow = db.get<{ id: number; filed_at: string }>(
    'SELECT id, filed_at FROM gst_returns WHERE period_start = ? AND period_end = ?',
    from,
    to
  )
  const { lockDate } = getSettings(db)
  return {
    from,
    to,
    line101,
    line103,
    line104,
    line105: line103 + line104,
    line106,
    line108: line106,
    line109: line103 + line104 - line106,
    adjustments: adjustments.map((a) => ({ label: a.label, amountCents: a.amountCents })),
    filed: filedRow ? { id: filedRow.id, filedAt: filedRow.filed_at } : null,
    locked: lockDate !== null && from <= lockDate
  }
}

/**
 * Records that the return was filed with CRA:
 *  - moves the period's GST collected and ITCs into "GST owing to CRA"
 *    (pay it with a journal entry or a bank import: Dr GST owing, Cr Bank),
 *  - locks the period so nothing can be posted into it afterwards.
 */
export function fileGstReturn(db: Db, from: string, to: string): GstReturn {
  return db.tx(() => {
    const r = gstReturn(db, from, to)
    if (r.filed) throw new UserError('This return has already been filed.')
    if (r.locked) throw new UserError('Part of this period is already locked. Choose a period after the lock date.')
    const overlap = db.get('SELECT 1 FROM gst_returns WHERE period_start <= ? AND period_end >= ?', to, from)
    if (overlap) throw new UserError('This period overlaps a return that was already filed.')

    let entryId: number | null = null
    if (r.line105 !== 0 || r.line108 !== 0) {
      const lines: NewLine[] = []
      const collectedId = accountIdByRole(db, 'gst_collected')
      const itcId = accountIdByRole(db, 'gst_itc')
      const owingId = accountIdByRole(db, 'gst_owing')
      // Zero out the period's activity in the two working accounts...
      lines.push(r.line103 >= 0 ? { accountId: collectedId, debit: r.line103, credit: 0 } : { accountId: collectedId, debit: 0, credit: -r.line103 })
      // Line 104 adjustments are a cost to the corporation.
      for (const a of gstAdjustments(db, from, to)) {
        const acc = db.get<{ id: number }>('SELECT id FROM accounts WHERE code = ?', a.accountCode)
        lines.push({ accountId: acc?.id ?? accountIdByRole(db, 'gst_owing'), debit: a.amountCents, credit: 0, memo: a.label })
      }
      lines.push(r.line108 >= 0 ? { accountId: itcId, debit: 0, credit: r.line108 } : { accountId: itcId, debit: -r.line108, credit: 0 })
      // ...and put the net into the amount owing to (or refundable from) CRA.
      lines.push(r.line109 >= 0 ? { accountId: owingId, debit: 0, credit: r.line109 } : { accountId: owingId, debit: -r.line109, credit: 0 })
      entryId = postEntry(db, { date: to, memo: `GST return filed ${from} to ${to}`, source: 'gst_return', lines })
    }
    db.run(
      `INSERT INTO gst_returns (period_start, period_end, line101, line105, line108, line109, entry_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      from,
      to,
      r.line101,
      r.line105,
      r.line108,
      r.line109,
      entryId
    )
    const { lockDate } = getSettings(db)
    if (lockDate === null || lockDate < to) updateSettings(db, { lockDate: to })
    return gstReturn(db, from, to)
  })
}

export function gstFilings(db: Db): FiledGstReturn[] {
  return db
    .all<{ id: number; period_start: string; period_end: string; line109: number; filed_at: string }>(
      'SELECT id, period_start, period_end, line109, filed_at FROM gst_returns ORDER BY period_end DESC'
    )
    .map((r) => ({ id: r.id, periodStart: r.period_start, periodEnd: r.period_end, line109: r.line109, filedAt: r.filed_at }))
}

// ---------------------------------------------------------------------------

export function accountLedger(db: Db, accountId: number, from: string, to: string): AccountLedger {
  const account = getAccount(db, accountId)
  const before = db.get<{ d: number; c: number }>(
    'SELECT COALESCE(SUM(debit), 0) AS d, COALESCE(SUM(credit), 0) AS c FROM ledger WHERE account_id = ? AND date < ?',
    accountId,
    from
  )!
  const opening = normalBalance(account.type, before.d, before.c)
  const lines = db.all<{ entry_id: number; date: string; entry_memo: string; memo: string; source: string; debit: number; credit: number }>(
    `SELECT entry_id, date, entry_memo, memo, source, debit, credit FROM ledger
     WHERE account_id = ? AND date BETWEEN ? AND ? ORDER BY date, entry_id, id`,
    accountId,
    from,
    to
  )
  let running = opening
  const rows = lines.map((l) => {
    running += normalBalance(account.type, l.debit, l.credit)
    return {
      entryId: l.entry_id,
      date: l.date,
      memo: l.memo || l.entry_memo,
      source: l.source as AccountLedger['rows'][number]['source'],
      debitCents: l.debit,
      creditCents: l.credit,
      runningBalanceCents: running
    }
  })
  return { account, from, to, openingBalanceCents: opening, rows, closingBalanceCents: running }
}

// ---------------------------------------------------------------------------
// GIFI (T2 Schedule 100 balance sheet and Schedule 125 income statement)
// ---------------------------------------------------------------------------

export function gifiReport(db: Db, fiscalYearEnd: string): GifiReport {
  const { fiscalYearEndMonth } = getSettings(db)
  const fy = fiscalYearOf(fiscalYearEnd, fiscalYearEndMonth)
  const t = totals(db, null, fy.end)
  const unmapped = new Set<string>()
  const group = (types: AccountType[], from: string | null, skip: Set<number> = new Set()) => {
    const map = new Map<string, { names: string[]; amount: number }>()
    const source = from === null ? t : totals(db, from, fy.end)
    for (const x of source) {
      if (!types.includes(x.type) || skip.has(x.id)) continue
      const amount = normalBalance(x.type, x.debit, x.credit)
      if (amount === 0) continue
      if (!x.gifi_code) {
        unmapped.add(`${x.code} ${x.name}`)
        continue
      }
      const g = map.get(x.gifi_code) ?? { names: [], amount: 0 }
      g.names.push(x.name)
      g.amount += amount
      map.set(x.gifi_code, g)
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([gifiCode, g]): GifiLine => ({ gifiCode, description: g.names.join('; '), amountCents: g.amount }))
  }

  const bs = balanceSheet(db, fy.end)
  const retainedId = accountIdByRole(db, 'retained_earnings')
  const dividendsId = accountIdByRole(db, 'dividends')
  const assets = group(['asset'], null)
  const liabilities = group(['liability'], null)
  const equity = group(['equity'], null, new Set([retainedId, dividendsId]))
  const reRow = bs.equity.find((r) => r.accountId === retainedId)?.amountCents ?? 0
  const divRow = -(bs.equity.find((r) => r.accountId === dividendsId)?.amountCents ?? 0) || 0
  const ni = bs.equity.find((r) => r.accountId === 0)?.amountCents ?? 0
  const reEnd = reRow + ni - divRow

  const s100: GifiLine[] = [
    ...assets,
    { gifiCode: '2599', description: 'Total assets', amountCents: bs.totalAssetsCents },
    ...liabilities,
    { gifiCode: '3499', description: 'Total liabilities', amountCents: bs.totalLiabilitiesCents },
    ...equity,
    { gifiCode: '3600', description: 'Retained earnings/deficit', amountCents: reEnd },
    { gifiCode: '3620', description: "Total shareholder equity", amountCents: bs.totalEquityCents },
    { gifiCode: '3640', description: "Total liabilities and shareholder equity", amountCents: bs.totalLiabilitiesCents + bs.totalEquityCents },
    { gifiCode: '3660', description: 'Retained earnings/deficit – start', amountCents: reRow },
    { gifiCode: '3680', description: 'Net income/loss', amountCents: ni },
    { gifiCode: '3700', description: 'Dividends declared', amountCents: divRow },
    { gifiCode: '3849', description: 'Retained earnings/deficit – end', amountCents: reEnd }
  ]

  const revenue = group(['income'], fy.start)
  const allExpenses = group(['expense'], fy.start)
  const taxes = allExpenses.filter((l) => l.gifiCode >= '9990')
  const expenses = allExpenses.filter((l) => l.gifiCode < '9990')
  const totalRevenue = revenue.reduce((s, l) => s + l.amountCents, 0)
  const totalExpenses = expenses.reduce((s, l) => s + l.amountCents, 0)
  const totalTaxes = taxes.reduce((s, l) => s + l.amountCents, 0)
  const s125: GifiLine[] = [
    ...revenue,
    { gifiCode: '8299', description: 'Total revenue', amountCents: totalRevenue },
    ...expenses,
    { gifiCode: '9368', description: 'Total expenses', amountCents: totalExpenses },
    { gifiCode: '9970', description: 'Net income/loss before taxes', amountCents: totalRevenue - totalExpenses },
    ...taxes,
    { gifiCode: '9999', description: 'Net income/loss after taxes', amountCents: totalRevenue - totalExpenses - totalTaxes }
  ]

  return { fiscalYearStart: fy.start, fiscalYearEnd: fy.end, schedule100: s100, schedule125: s125, unmapped: [...unmapped] }
}

// ---------------------------------------------------------------------------

export function dashboard(db: Db, lastBackupAt: string | null): Dashboard {
  const today = todayIso()
  const { fiscalYearEndMonth } = getSettings(db)
  const fy = fiscalYearOf(today, fiscalYearEndMonth)
  const all = totals(db, null, today)
  const balanceOf = (pred: (x: Totals) => boolean) =>
    all.filter(pred).reduce((s, x) => s + normalBalance(x.type, x.debit, x.credit), 0)

  const bankIds = new Set(
    db.all<{ id: number }>("SELECT id FROM accounts WHERE is_bank = 1 AND type = 'asset'").map((r) => r.id)
  )
  const gstRoles = new Set(['gst_collected', 'gst_itc', 'gst_owing'])

  const months = lastMonths(today, 12)
  const monthly = db.all<{ month: string; income: number; expense: number }>(
    `SELECT substr(l.date, 1, 7) AS month,
            SUM(CASE WHEN a.type = 'income' THEN l.credit - l.debit ELSE 0 END) AS income,
            SUM(CASE WHEN a.type = 'expense' THEN l.debit - l.credit ELSE 0 END) AS expense
     FROM ledger l JOIN accounts a ON a.id = l.account_id
     WHERE l.date >= ? AND l.date <= ? AND a.type IN ('income', 'expense')
     GROUP BY month`,
    `${months[0]}-01`,
    today
  )
  const byMonth = new Map(monthly.map((m) => [m.month, m]))

  const invoices = listInvoices(db)
  const open = invoices.filter((i) => i.status === 'issued' && i.balanceCents > 0)
  const overdue = open.filter((i) => i.displayStatus === 'overdue')
  const ytd = incomeStatement(db, fy.start, today)

  return {
    today,
    fiscalYearStart: fy.start,
    cashCents: balanceOf((x) => bankIds.has(x.id)),
    receivableCents: balanceOf((x) => x.role === 'ar'),
    overdueCents: overdue.reduce((s, i) => s + i.balanceCents, 0),
    overdueCount: overdue.length,
    gstOwingCents: balanceOf((x) => x.role !== null && gstRoles.has(x.role)),
    netIncomeYtdCents: ytd.netIncomeCents,
    revenueYtdCents: ytd.totalIncomeCents,
    expensesYtdCents: ytd.totalExpensesCents,
    shareholderLoanCents: balanceOf((x) => x.role === 'shareholder_loan'),
    monthly: months.map((m) => ({
      month: m,
      incomeCents: byMonth.get(m)?.income ?? 0,
      expenseCents: byMonth.get(m)?.expense ?? 0
    })),
    openInvoices: open.slice(0, 6),
    recentEntries: listEntries(db, 8),
    lastBackupAt
  }
}

