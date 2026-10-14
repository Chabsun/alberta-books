/**
 * Bank statement import. The UI maps CSV columns and assigns each row a
 * category; this posts the rows in a single transaction (all or nothing) and
 * skips rows that were already imported.
 *
 *   Withdrawal to an expense/asset category -> recorded as an Expense
 *   Deposit matched to an invoice           -> recorded as a Payment
 *   Anything else                           -> a journal entry (source "import")
 */
import { createHash } from 'node:crypto'
import type { Db } from '../db/connection'
import { UserError } from '../errors'
import { gstIncluded } from '../../shared/money'
import type { ImportResult } from '../../shared/types'
import { accountIdByRole, requireAccount } from './accounts'
import { createExpense } from './expenses'
import { recordPayment } from './invoices'
import { postEntry, type NewLine } from './ledger'

export interface ImportRow {
  date: string
  description: string
  amountCents: number
  target: { kind: 'account'; accountId: number; gstIncluded: boolean } | { kind: 'invoice'; invoiceId: number }
}

function fingerprint(bankAccountId: number, r: ImportRow, occurrence: number): string {
  const key = [bankAccountId, r.date, r.amountCents, r.description.trim().toLowerCase(), occurrence].join('|')
  return createHash('sha256').update(key).digest('hex')
}

export function importRows(db: Db, bankAccountId: number, rows: ImportRow[]): ImportResult {
  const bank = requireAccount(db, bankAccountId, (a) => a.isBank, 'Bank account')
  let posted = 0
  let skipped = 0

  db.tx(() => {
    // Two identical rows in one statement (e.g. two $5 coffees) are distinct:
    // the occurrence number keeps them apart while still matching re-imports.
    const seen = new Map<string, number>()
    rows.forEach((r, index) => {
      const label = `Row ${index + 1} (${r.date}, ${r.description})`
      const baseKey = [r.date, r.amountCents, r.description.trim().toLowerCase()].join('|')
      const occurrence = (seen.get(baseKey) ?? 0) + 1
      seen.set(baseKey, occurrence)
      const fp = fingerprint(bank.id, r, occurrence)
      if (db.get('SELECT 1 FROM bank_import_rows WHERE fingerprint = ?', fp)) {
        skipped++
        return
      }

      let entryId: number
      try {
        entryId = postRow(db, bank.id, bank.type, r)
      } catch (err) {
        if (err instanceof UserError) throw new UserError(`${label}: ${err.message}`)
        throw err
      }
      db.run(
        'INSERT INTO bank_import_rows (account_id, fingerprint, date, description, amount, entry_id) VALUES (?, ?, ?, ?, ?, ?)',
        bank.id,
        fp,
        r.date,
        r.description,
        r.amountCents,
        entryId
      )
      posted++
    })
  })
  return { posted, skippedDuplicates: skipped }
}

function postRow(db: Db, bankId: number, bankType: string, r: ImportRow): number {
  const gross = Math.abs(r.amountCents)
  // For a credit card (a liability), a purchase shows as money out the same way.
  const deposit = r.amountCents > 0

  if (r.target.kind === 'invoice') {
    if (!deposit) throw new UserError('Only deposits can be matched to an invoice.')
    if (bankType !== 'asset') throw new UserError('Invoice payments must go to a bank account.')
    const inv = recordPayment(db, { invoiceId: r.target.invoiceId, date: r.date, amountCents: gross, accountId: bankId })
    const p = inv.payments[inv.payments.length - 1]
    return db.get<{ entry_id: number }>('SELECT entry_id FROM payments WHERE id = ?', p.id)!.entry_id
  }

  const target = requireAccount(db, r.target.accountId, (a) => a.id !== bankId, 'Category')
  const gst = r.target.gstIncluded ? gstIncluded(gross) : 0
  const net = gross - gst

  if (!deposit && (target.type === 'expense' || (target.type === 'asset' && !target.isBank))) {
    return createExpense(db, {
      date: r.date,
      vendor: r.description,
      description: 'Imported from bank statement',
      accountId: target.id,
      amountCents: net,
      gstCents: gst,
      paidFromAccountId: bankId
    }).entryId
  }

  const lines: NewLine[] = deposit
    ? [
        { accountId: bankId, debit: gross, credit: 0 },
        { accountId: target.id, debit: 0, credit: net },
        { accountId: accountIdByRole(db, 'gst_collected'), debit: 0, credit: gst }
      ]
    : [
        { accountId: target.id, debit: net, credit: 0 },
        { accountId: accountIdByRole(db, 'gst_itc'), debit: gst, credit: 0 },
        { accountId: bankId, debit: 0, credit: gross }
      ]
  return postEntry(db, { date: r.date, memo: r.description, source: 'import', lines })
}

