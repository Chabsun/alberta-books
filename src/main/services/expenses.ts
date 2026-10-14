/**
 * Expenses (receipts and bills paid).
 *
 * Posts:  Dr Expense (or asset, for equipment)  amount before GST
 *         Dr GST paid (input tax credit)         GST on the receipt
 *         Cr Bank / credit card / Due to shareholder (if you paid personally)
 */
import type { Db } from '../db/connection'
import { UserError } from '../errors'
import type { Expense } from '../../shared/types'
import { accountIdByRole, requireAccount } from './accounts'
import { postEntry, reverseEntry } from './ledger'

export interface ExpenseInput {
  date: string
  vendor: string
  description: string
  accountId: number
  amountCents: number
  gstCents: number
  paidFromAccountId: number
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
  paid_from_account_id: number
  paid_from_name: string
  entry_id: number
  void_entry_id: number | null
}

const SELECT = `
  SELECT x.id, x.date, x.vendor, x.description, x.account_id, a.name AS account_name, x.amount, x.gst,
         x.paid_from_account_id, p.name AS paid_from_name, x.entry_id, x.void_entry_id
  FROM expenses x
  JOIN accounts a ON a.id = x.account_id
  JOIN accounts p ON p.id = x.paid_from_account_id`

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
    totalCents: r.amount + r.gst,
    paidFromAccountId: r.paid_from_account_id,
    paidFromName: r.paid_from_name,
    voided: r.void_entry_id !== null,
    entryId: r.entry_id
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

export function createExpense(db: Db, input: ExpenseInput): Expense {
  requireAccount(db, input.accountId, (a) => (a.type === 'expense' || a.type === 'asset') && !a.isBank, 'Category')
  requireAccount(
    db,
    input.paidFromAccountId,
    (a) => a.isBank || a.role === 'shareholder_loan',
    'Paid from'
  )
  if (input.gstCents > input.amountCents) throw new UserError('GST cannot be more than the amount before tax.')

  return db.tx(() => {
    const memo = input.description ? `${input.vendor} – ${input.description}` : input.vendor
    const entryId = postEntry(db, {
      date: input.date,
      memo,
      source: 'expense',
      lines: [
        { accountId: input.accountId, debit: input.amountCents, credit: 0 },
        { accountId: accountIdByRole(db, 'gst_itc'), debit: input.gstCents, credit: 0 },
        { accountId: input.paidFromAccountId, debit: 0, credit: input.amountCents + input.gstCents }
      ]
    })
    const { lastInsertRowid } = db.run(
      `INSERT INTO expenses (date, vendor, description, account_id, amount, gst, paid_from_account_id, entry_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.date,
      input.vendor,
      input.description,
      input.accountId,
      input.amountCents,
      input.gstCents,
      input.paidFromAccountId,
      entryId
    )
    return getExpense(db, lastInsertRowid)
  })
}

export function voidExpense(db: Db, id: number, date: string): Expense {
  return db.tx(() => {
    const x = getExpense(db, id)
    if (x.voided) throw new UserError('This expense is already void.')
    const voidEntryId = reverseEntry(db, x.entryId, date, `Void expense – ${x.vendor}`)
    db.run('UPDATE expenses SET void_entry_id = ? WHERE id = ?', voidEntryId, id)
    return getExpense(db, id)
  })
}
