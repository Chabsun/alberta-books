/**
 * Scans the books for mistakes, missing paperwork and coming deadlines.
 * Read-only: each issue says what to look at and where.
 */
import type { Db } from '../db/connection'
import { addDays, fiscalYearOf, monthEndAfter, todayIso } from '../../shared/dates'
import { formatMoney } from '../../shared/money'
import { taxRule } from '../../shared/taxRules'
import type { Issue } from '../../shared/types'
import { listExpenses } from './expenses'
import { trialBalance } from './reports'
import { getSettings } from './settings'
import { listVehicles } from './vehicles'

// Merchants that are often personal: only a prompt to double-check.
const PERSONAL_HINTS =
  /\b(NETFLIX|SPOTIFY|DISNEY|CRAVE|PLAYSTATION|XBOX|STEAM|SEPHORA|LULULEMON|LIQUOR|CINEPLEX|TICKETMASTER|SAFEWAY|SOBEYS|SUPERSTORE|NO FRILLS|WALMART|SHOPPERS DRUG|PETSMART|DAYCARE|GARDERIE)\b/i

export function findIssues(db: Db, today = todayIso()): Issue[] {
  const issues: Issue[] = []
  const push = (severity: Issue['severity'], code: string, message: string, link?: string, count?: number) =>
    issues.push({ severity, code, message, link, count })
  const settings = getSettings(db)
  const fy = fiscalYearOf(today, settings.fiscalYearEndMonth)

  const tb = trialBalance(db, today)
  if (tb.totalDebitCents !== tb.totalCreditCents) push('error', 'trial_balance', 'The trial balance does not balance. Please report this.')

  // Bank feed
  const stale = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bank_transactions WHERE status = 'unreviewed' AND date < ?`, addDays(today, -30))!.n
  if (stale) push('warning', 'stale_unreviewed', `${stale} bank transaction(s) older than 30 days are still waiting to be categorized.`, '/bank', stale)
  const queue = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bank_transactions WHERE status = 'unreviewed'`)!.n
  if (queue && !stale) push('info', 'unreviewed', `${queue} bank transaction(s) to categorize.`, '/bank', queue)

  // Expenses: what CRA asks for
  const active = listExpenses(db).filter((x) => !x.voided && x.date >= addDays(today, -400))
  const noGstNumber = active.filter((x) => x.warnings.some((w) => w.includes('GST number')))
  if (noGstNumber.length) {
    push('warning', 'itc_documentation', `${noGstNumber.length} expense(s) of $100 or more claim GST without the supplier’s GST number. CRA can deny those credits.`, '/expenses', noGstNumber.length)
  }
  const noPurpose = active.filter((x) => x.warnings.some((w) => w.includes('purpose') || w.includes('attended')))
  if (noPurpose.length) push('warning', 'missing_purpose', `${noPurpose.length} meal, travel or similar expense(s) have no business purpose or attendees recorded.`, '/expenses', noPurpose.length)
  const noReceipt = active.filter((x) => x.receiptCount === 0 && x.totalCents >= 30_00)
  if (noReceipt.length) push('info', 'missing_receipts', `${noReceipt.length} expense(s) of $30 or more have no receipt attached.`, '/expenses', noReceipt.length)

  const exemptItc = active.filter((x) => x.itcCents > 0 && taxRule(x.taxRule).gst === 'exempt')
  if (exemptItc.length) push('warning', 'itc_on_exempt', `GST was claimed back on ${exemptItc.length} expense(s) in normally GST-exempt categories (bank fees, insurance, interest). Check those receipts.`, '/expenses', exemptItc.length)

  const personal = active.filter((x) => x.businessPct === 100 && PERSONAL_HINTS.test(x.vendor))
  if (personal.length) push('info', 'possibly_personal', `${personal.length} expense(s) are at merchants that are often personal. Confirm the business purpose, or set a business-use %.`, '/expenses', personal.length)

  const capitalLooking = active.filter((x) => x.amountCents >= 500_00 && ['standard'].includes(x.taxRule ?? '') && /(computer|laptop|macbook|monitor|iphone|ipad|desk|chair|printer|camera)/i.test(`${x.vendor} ${x.description}`))
  if (capitalLooking.length) push('info', 'maybe_capital', `${capitalLooking.length} expense(s) over $500 look like equipment. Equipment is a capital asset (CCA), not an expense.`, '/expenses', capitalLooking.length)

  // Conventions: at most two a year
  const conventions = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM expenses WHERE tax_rule = 'conventions' AND void_entry_id IS NULL AND date BETWEEN ? AND ?`,
    fy.start,
    fy.end
  )!.n
  if (conventions > 2) push('warning', 'conventions_limit', `${conventions} convention expenses this fiscal year: CRA allows up to two conventions a year.`, '/expenses')

  // Shareholder loan: s.15(2) and s.80.4
  const sh = db.get<{ s: number }>(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS s FROM ledger l JOIN accounts a ON a.id = l.account_id WHERE a.role = 'shareholder_loan' AND l.date <= ?`,
    today
  )!.s
  if (sh > 0) {
    push(
      'warning',
      'shareholder_owes',
      `You owe the corporation ${formatMoney(sh)}. Repay it within one year after the end of the fiscal year it arose in, or it becomes your income (s.15(2)). Until then, interest at CRA’s prescribed rate may be a taxable benefit (s.80.4).`,
      '/journal'
    )
  }

  // Negative bank balances
  for (const b of db.all<{ name: string; s: number }>(
    `SELECT a.name, SUM(l.debit - l.credit) AS s FROM accounts a JOIN ledger l ON l.account_id = a.id WHERE a.is_bank = 1 AND a.type = 'asset' GROUP BY a.id HAVING s < 0`
  )) {
    push('warning', 'negative_bank', `${b.name} shows a negative balance of ${formatMoney(b.s)}: a deposit may be missing, or the opening balance isn’t entered.`, '/accounts')
  }

  // Overdue invoices
  const overdue = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM invoices i WHERE i.status = 'issued' AND i.due_date < ?
       AND i.total > COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id AND p.void_entry_id IS NULL), 0)`,
    today
  )!.n
  if (overdue) push('info', 'overdue_invoices', `${overdue} invoice(s) are past due.`, '/invoices', overdue)

  // GST registration
  const charging = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM invoices WHERE status = 'issued' AND gst > 0`)!.n
  if (charging && !settings.gstNumber) push('warning', 'gst_number_missing', 'You charge GST but your GST number is not in Settings. It must appear on your invoices.', '/settings')

  // Company vehicle: logbook and benefit deadlines
  const year = Number(today.slice(0, 4))
  for (const v of listVehicles(db).filter((x) => !x.archived)) {
    const trips = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM vehicle_trips WHERE vehicle_id = ? AND date >= ?', v.id, `${year}-01-01`)!.n
    if (trips === 0) push('warning', 'vehicle_logbook', `No trips logged for ${v.name} this year. Without a logbook CRA treats the driving as personal.`, '/vehicle')
    if (today.slice(5) <= '02-28') {
      push('info', 'vehicle_benefit_due', `Report your ${year - 1} company-car benefit for ${v.name} by the end of February, and remit its GST on the return covering that date.`, '/vehicle')
    }
  }

  // Dividends paid last calendar year: T5 slips due by the end of February
  const dividends = db.get<{ s: number }>(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS s FROM ledger l JOIN accounts a ON a.id = l.account_id
     WHERE a.role = 'dividends' AND l.date BETWEEN ? AND ?`,
    `${year - 1}-01-01`,
    `${year - 1}-12-31`
  )!.s
  if (dividends > 0 && today.slice(5) <= '03-31') {
    push('info', 't5_due', `Dividends of ${formatMoney(dividends)} were paid in ${year - 1}: file the T5 slips and summary by the end of February ${year} (usually non-eligible dividends for a small business).`, '/year-end')
  }

  // After year end: the tax balance is due in 3 months (a CCPC claiming the small business deduction,
  // 2 months otherwise) and the T2 by the end of the sixth month.
  const lastFyEnd = addDays(fy.start, -1)
  const balanceDue = monthEndAfter(lastFyEnd, 3)
  const t2Due = monthEndAfter(lastFyEnd, 6)
  if (today > lastFyEnd && today <= balanceDue) {
    push('warning', 'tax_balance_due', `Corporate income tax for the year ended ${lastFyEnd} must be paid by ${balanceDue} (3 months after year end for a CCPC claiming the small business deduction; 2 months otherwise), even though the T2 is due later.`, '/year-end')
  }
  if (today > lastFyEnd && today <= t2Due) {
    push('info', 't2_due', `Your T2 for the fiscal year ended ${lastFyEnd} is due by ${t2Due}. Export the accountant package from Year end.`, '/year-end')
  }

  if (settings.companyName === 'My Corporation Ltd.') push('info', 'setup_company', 'Add your company name and details in Settings.', '/settings')

  const order = { error: 0, warning: 1, info: 2 }
  return issues.sort((a, b) => order[a.severity] - order[b.severity])
}
