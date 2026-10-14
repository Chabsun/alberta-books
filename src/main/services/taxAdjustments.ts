/**
 * From book profit to taxable income (T2 Schedule 1 style), for a fiscal year:
 *   + the non-deductible part of every expense account, by its CRA rule
 *     (50% of meals and entertainment, club dues, fines, life insurance,
 *     income tax, book amortization, donations)
 *   + vehicle lease and interest costs over the CRA caps
 *   − capital cost allowance (Schedule 8)
 * An estimate for planning and for your accountant; the T2 is final.
 */
import type { Db } from '../db/connection'
import { fiscalYearOf } from '../../shared/dates'
import { mulDivRound } from '../../shared/money'
import { taxRule } from '../../shared/taxRules'
import type { TaxAdjustments, TaxAdjustmentLine } from '../../shared/types'
import { ccaSchedule } from './cca'
import { incomeStatement } from './reports'
import { getSettings } from './settings'
import { listVehicles, vehicleLimits } from './vehicles'

export function taxAdjustments(db: Db, fiscalYearEnd: string): TaxAdjustments {
  const { fiscalYearEndMonth } = getSettings(db)
  const fy = fiscalYearOf(fiscalYearEnd, fiscalYearEndMonth)
  const is = incomeStatement(db, fy.start, fy.end)
  const notes: string[] = []

  const accounts = db.all<{ id: number; name: string; tax_rule: string | null; balance: number }>(
    `SELECT a.id, a.name, a.tax_rule, COALESCE(SUM(l.debit - l.credit), 0) AS balance
     FROM accounts a JOIN ledger l ON l.account_id = a.id
     WHERE a.type = 'expense' AND l.date BETWEEN ? AND ?
     GROUP BY a.id`,
    fy.start,
    fy.end
  )

  const addBacks: TaxAdjustmentLine[] = []
  let donations = 0
  for (const a of accounts) {
    const rule = taxRule(a.tax_rule)
    if (rule.deductiblePct >= 100 || a.balance === 0) continue
    const amount = mulDivRound(a.balance, 100 - rule.deductiblePct, 100)
    if (rule.id === 'donations') donations += a.balance
    addBacks.push({
      label: rule.deductiblePct === 50 ? `50% of ${a.name}` : a.name,
      amountCents: amount,
      note: rule.id === 'donations' ? 'Deducted instead on Schedule 2 (charitable donations).' : rule.id === 'amortization' ? 'Replaced by CCA below.' : undefined
    })
  }

  for (const v of listVehicles(db)) {
    const lim = vehicleLimits(db, v.id, fy.end)
    if (lim.leaseExcessCents > 0) {
      addBacks.push({ label: `Lease cost over the CRA cap – ${v.name}`, amountCents: lim.leaseExcessCents })
    }
    if (lim.interestExcessCents > 0) {
      addBacks.push({ label: `Loan interest over the CRA cap – ${v.name}`, amountCents: lim.interestExcessCents })
    }
  }

  const cca = ccaSchedule(db, fy.end)
  const deductions: TaxAdjustmentLine[] = []
  if (cca.totalCcaCents > 0) deductions.push({ label: 'Capital cost allowance (Schedule 8)', amountCents: cca.totalCcaCents })
  const terminal = cca.rows.reduce((s, r) => s + r.terminalLossCents, 0)
  if (terminal > 0) deductions.push({ label: 'Terminal loss', amountCents: terminal })
  const recapture = cca.rows.reduce((s, r) => s + r.recaptureCents, 0)
  if (recapture > 0) addBacks.push({ label: 'Recapture of CCA', amountCents: recapture })

  const totalAdd = addBacks.reduce((s, l) => s + l.amountCents, 0)
  const totalDeduct = deductions.reduce((s, l) => s + l.amountCents, 0)
  notes.push('Estimate for planning. Your accountant prepares the final Schedule 1 with the T2.')
  if (donations > 0) notes.push('Charitable donations reduce taxable income on Schedule 2, up to 75% of net income.')

  return {
    fiscalYearStart: fy.start,
    fiscalYearEnd: fy.end,
    netIncomeBooksCents: is.netIncomeCents,
    addBacks,
    deductions,
    netIncomeForTaxCents: is.netIncomeCents + totalAdd - totalDeduct,
    donationsCents: donations,
    notes
  }
}
