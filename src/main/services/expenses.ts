/**
 * Expenses (receipts and bills the company paid), with the CRA rules applied.
 *
 * Posts:  Dr Expense or asset account     cost (pre-tax + GST that can't be claimed back)
 *         Dr GST paid (input tax credit)  the claimable GST
 *         Dr Due to shareholder           the personal part, if any
 *         Cr Bank / credit card / Due to shareholder (if you paid personally)
 *
 * Capital purchases also create an asset for the CCA schedule.
 */
import type { Db } from '../db/connection'
import { UserError } from '../errors'
import { GST_NUMBER_RE, receiptRequirements, taxRule } from '../../shared/taxRules'
import type { Expense } from '../../shared/types'
import { accountIdByRole, getAccount, requireAccount } from './accounts'
import { audit } from './audit'
import { splitExpense } from './expenseMath'
import { postEntry, reverseEntry } from './ledger'

export interface ExpenseInput {
  date: string
  vendor: string
  description: string
  accountId: number
  /** Total before GST, for the whole receipt. */
  amountCents: number
  /** GST shown on the receipt. */
  gstCents: number
  paidFromAccountId: number
  businessPct?: number
  supplierGstNumber?: string
  purpose?: string
  attendees?: string
  vehicleId?: number | null
  /** Vehicle purchases: used more than 50% for business. */
  primarilyBusiness?: boolean
}

interface ExpenseRow {
  id: number
  date: string
  vendor: string
  description: string
  account_id: number
  account_name: string
  amount: number
  gst: number
  itc: number
  business_pct: number
  nondeductible: number
  tax_rule: string | null
  supplier_gst_number: string
  purpose: string
  attendees: string
  vehicle_id: number | null
  paid_from_account_id: number
  paid_from_name: string
  entry_id: number
  void_entry_id: number | null
  receipts: number
}

const SELECT = `
  SELECT x.id, x.date, x.vendor, x.description, x.account_id, a.name AS account_name, x.amount, x.gst, x.itc,
         x.business_pct, x.nondeductible, x.tax_rule, x.supplier_gst_number, x.purpose, x.attendees, x.vehicle_id,
         x.paid_from_account_id, p.name AS paid_from_name, x.entry_id, x.void_entry_id,
         (SELECT COUNT(*) FROM receipts r WHERE r.expense_id = x.id) AS receipts
  FROM expenses x
  JOIN accounts a ON a.id = x.account_id
  JOIN accounts p ON p.id = x.paid_from_account_id`

/** What is missing for CRA (receipt details, purpose, attendees). Empty when complete. */
export function expenseWarnings(r: Pick<ExpenseRow, 'amount' | 'gst' | 'itc' | 'tax_rule' | 'supplier_gst_number' | 'purpose' | 'attendees' | 'receipts'>): string[] {
  const rule = taxRule(r.tax_rule)
  const total = r.amount + r.gst
  const w: string[] = []
  if (r.itc > 0 && total >= 100_00 && !r.supplier_gst_number) {
    w.push('Add the supplier’s GST number: CRA requires it on receipts of $100 or more to claim the GST back.')
  }
  if (rule.needsPurpose && !r.purpose.trim()) w.push('Add the business purpose.')
  if (rule.needsAttendees && !r.attendees.trim()) w.push('Add who attended.')
  if (r.receipts === 0 && total >= 30_00) w.push('Attach the receipt.')
  return w
}

function toExpense(r: ExpenseRow): Expense {
  return {
    id: r.id,
    date: r.date,
    vendor: r.vendor,
    description: r.description,
    accountId: r.account_id,
    accountName: r.account_name,
    amountCents: r.amount,
    gstCents: r.gst,
    itcCents: r.itc,
    totalCents: r.amount + r.gst,
    businessPct: r.business_pct,
    nonDeductibleCents: r.nondeductible,
    taxRule: r.tax_rule,
    supplierGstNumber: r.supplier_gst_number,
    purpose: r.purpose,
    attendees: r.attendees,
    vehicleId: r.vehicle_id,
    paidFromAccountId: r.paid_from_account_id,
    paidFromName: r.paid_from_name,
    voided: r.void_entry_id !== null,
    entryId: r.entry_id,
    receiptCount: r.receipts,
    warnings: r.void_entry_id !== null ? [] : expenseWarnings(r)
  }
}

export function listExpenses(db: Db): Expense[] {
  return db.all<ExpenseRow>(`${SELECT} ORDER BY x.date DESC, x.id DESC`).map(toExpense)
}

export function getExpense(db: Db, id: number): Expense {
  const r = db.get<ExpenseRow>(`${SELECT} WHERE x.id = ?`, id)
  if (!r) throw new UserError('Expense not found.')
  return toExpense(r)
}

/** Shows how an expense would be treated, before saving it. */
export function previewExpense(db: Db, input: ExpenseInput) {
  const account = getAccount(db, input.accountId)
  const rule = taxRule(accountRule(db, input.accountId))
  const vehicle = input.vehicleId ? db.get<{ zero_emission: number }>('SELECT zero_emission FROM vehicles WHERE id = ?', input.vehicleId) : undefined
  const split = splitExpense({
    ruleId: rule.id,
    amountCents: input.amountCents,
    gstCents: input.gstCents,
    businessPct: input.businessPct ?? 100,
    date: input.date,
    zeroEmission: vehicle?.zero_emission === 1,
    primarilyBusiness: input.primarilyBusiness
  })
  return {
    account: account.name,
    rule: { id: rule.id, label: rule.label, guidance: rule.guidance, reference: rule.reference, deductiblePct: rule.deductiblePct, itcPct: rule.itcPct, gst: rule.gst },
    costCents: split.costCents,
    itcCents: split.itcCents,
    personalCents: split.personalCents,
    nonDeductibleCents: split.nonDeductibleCents,
    asset: split.asset,
    notes: split.notes,
    receiptMustShow: receiptRequirements(input.amountCents + input.gstCents)
  }
}

function accountRule(db: Db, accountId: number): string | null {
  return db.get<{ tax_rule: string | null }>('SELECT tax_rule FROM accounts WHERE id = ?', accountId)?.tax_rule ?? null
}

export function createExpense(db: Db, input: ExpenseInput): Expense {
  requireAccount(db, input.accountId, (a) => (a.type === 'expense' || a.type === 'asset') && !a.isBank && a.role === null, 'Category')
  requireAccount(db, input.paidFromAccountId, (a) => a.isBank || a.role === 'shareholder_loan', 'Paid from')
  if (input.gstCents > input.amountCents) throw new UserError('GST cannot be more than the amount before tax.')
  const businessPct = input.businessPct ?? 100
  const ruleId = accountRule(db, input.accountId)
  const rule = taxRule(ruleId)
  if (businessPct < 100 && (rule.ccaClass || rule.vehicle)) {
    throw new UserError('Company vehicle and capital asset costs are recorded at 100%. Personal use of a company vehicle is handled on the Vehicle page.')
  }
  const gstNumber = (input.supplierGstNumber ?? '').trim().toUpperCase()
  if (gstNumber && !GST_NUMBER_RE.test(gstNumber)) throw new UserError('The supplier’s GST number should look like 123456789 RT0001.')
  if (input.vehicleId != null && !db.get('SELECT 1 FROM vehicles WHERE id = ?', input.vehicleId)) throw new UserError('Vehicle not found.')
  if (rule.vehicle && input.vehicleId == null) {
    const only = db.all<{ id: number }>('SELECT id FROM vehicles WHERE archived = 0')
    if (only.length === 1) input = { ...input, vehicleId: only[0].id }
  }
  const vehicle = input.vehicleId ? db.get<{ zero_emission: number; cost: number }>('SELECT zero_emission, cost FROM vehicles WHERE id = ?', input.vehicleId) : undefined

  const split = splitExpense({
    ruleId,
    amountCents: input.amountCents,
    gstCents: input.gstCents,
    businessPct,
    date: input.date,
    zeroEmission: vehicle?.zero_emission === 1,
    primarilyBusiness: input.primarilyBusiness
  })

  return db.tx(() => {
    const memo = input.description ? `${input.vendor} – ${input.description}` : input.vendor
    const total = input.amountCents + input.gstCents
    const entryId = postEntry(db, {
      date: input.date,
      memo,
      source: 'expense',
      lines: [
        { accountId: input.accountId, debit: split.costCents, credit: 0 },
        { accountId: accountIdByRole(db, 'gst_itc'), debit: split.itcCents, credit: 0 },
        { accountId: accountIdByRole(db, 'shareholder_loan'), debit: split.personalCents, credit: 0 },
        { accountId: input.paidFromAccountId, debit: 0, credit: total }
      ]
    })
    const { lastInsertRowid: id } = db.run(
      `INSERT INTO expenses (date, vendor, description, account_id, amount, gst, itc, business_pct, nondeductible, tax_rule,
                             supplier_gst_number, purpose, attendees, vehicle_id, paid_from_account_id, entry_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.date,
      input.vendor,
      input.description,
      input.accountId,
      input.amountCents,
      input.gstCents,
      split.itcCents,
      businessPct,
      split.nonDeductibleCents,
      split.rule.id,
      gstNumber,
      input.purpose ?? '',
      input.attendees ?? '',
      input.vehicleId ?? null,
      input.paidFromAccountId,
      entryId
    )
    if (split.asset) {
      db.run(
        `INSERT INTO assets (description, cca_class, cost, acquired_date, available_date, account_id, vehicle_id, expense_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        memo,
        split.asset.ccaClass,
        split.asset.capitalCostCents,
        input.date,
        input.date,
        input.accountId,
        input.vehicleId ?? null,
        id
      )
      // A vehicle bought outright: its cost (with tax) is what the standby charge is based on.
      if (input.vehicleId && vehicle && vehicle.cost === 0 && split.rule.id === 'capital_vehicle') {
        db.run('UPDATE vehicles SET cost = ? WHERE id = ?', input.amountCents, input.vehicleId)
      }
    }
    audit(db, 'create', 'expense', id, `${memo}: ${(total / 100).toFixed(2)}`, entryId)
    return getExpense(db, id)
  })
}

export function voidExpense(db: Db, id: number, date: string): Expense {
  return db.tx(() => {
    const x = getExpense(db, id)
    if (x.voided) throw new UserError('This expense is already void.')
    const voidEntryId = reverseEntry(db, x.entryId, date, `Void expense – ${x.vendor}`)
    db.run('UPDATE expenses SET void_entry_id = ? WHERE id = ?', voidEntryId, id)
    // A voided capital purchase leaves the asset register too.
    db.run('UPDATE assets SET disposed_date = ?, proceeds = cost WHERE expense_id = ? AND disposed_date IS NULL', date, id)
    audit(db, 'void', 'expense', id, x.vendor, voidEntryId)
    return getExpense(db, id)
  })
}

/** Adds the details CRA asks for after the fact (GST number, purpose, attendees). Amounts never change. */
export function updateExpenseDetails(
  db: Db,
  id: number,
  details: { supplierGstNumber?: string; purpose?: string; attendees?: string; description?: string }
): Expense {
  const x = getExpense(db, id)
  const gstNumber = details.supplierGstNumber?.trim().toUpperCase()
  if (gstNumber && !GST_NUMBER_RE.test(gstNumber)) throw new UserError('The supplier’s GST number should look like 123456789 RT0001.')
  db.run(
    'UPDATE expenses SET supplier_gst_number = ?, purpose = ?, attendees = ?, description = ? WHERE id = ?',
    gstNumber ?? x.supplierGstNumber,
    details.purpose ?? x.purpose,
    details.attendees ?? x.attendees,
    details.description ?? x.description,
    id
  )
  audit(db, 'update', 'expense', id, 'Receipt details')
  return getExpense(db, id)
}
