/**
 * The general ledger. Every financial event (invoice, payment, expense, GST
 * filing, manual adjustment) becomes one balanced journal entry posted here.
 *
 * Entries are append-only. A mistake is corrected by posting a reversal
 * (the same lines with debits and credits swapped), which keeps a complete
 * audit trail. The database triggers enforce this independently.
 */
import type { Db } from '../db/connection'
import { UserError } from '../errors'
import { isIsoDate } from '../../shared/dates'
import { isCents } from '../../shared/money'
import type { EntrySource, JournalEntry, JournalLine } from '../../shared/types'

export interface NewLine {
  accountId: number
  debit: number
  credit: number
  memo?: string
}

export interface NewEntry {
  date: string
  memo: string
  source: EntrySource
  lines: NewLine[]
  reversesId?: number
}

/** Drops zero lines and merges nothing else; validates the entry balances. */
function checkLines(lines: NewLine[]): NewLine[] {
  const kept = lines.filter((l) => l.debit !== 0 || l.credit !== 0)
  for (const l of kept) {
    if (!isCents(l.debit) || !isCents(l.credit) || l.debit < 0 || l.credit < 0) {
      throw new UserError('Amounts must be positive and in whole cents.')
    }
    if (l.debit > 0 && l.credit > 0) throw new UserError('Each line needs a debit or a credit, not both.')
  }
  if (kept.length < 2) throw new UserError('A journal entry needs at least two lines with amounts.')
  const debits = kept.reduce((s, l) => s + l.debit, 0)
  const credits = kept.reduce((s, l) => s + l.credit, 0)
  if (debits !== credits) throw new UserError('Debits and credits must be equal.')
  return kept
}

export function postEntry(db: Db, entry: NewEntry): number {
  if (!isIsoDate(entry.date)) throw new UserError('Enter a valid date.')
  const lines = checkLines(entry.lines)

  return db.tx(() => {
    for (const l of lines) {
      const a = db.get<{ archived: number }>('SELECT archived FROM accounts WHERE id = ?', l.accountId)
      if (!a) throw new UserError('Account not found.')
      if (a.archived === 1 && entry.source !== 'reversal') throw new UserError('Archived accounts cannot be used.')
    }
    const { lastInsertRowid: id } = db.run(
      'INSERT INTO journal_entries (date, memo, source, reverses_id) VALUES (?, ?, ?, ?)',
      entry.date,
      entry.memo,
      entry.source,
      entry.reversesId ?? null
    )
    for (const l of lines) {
      db.run(
        'INSERT INTO journal_lines (entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?)',
        id,
        l.accountId,
        l.debit,
        l.credit,
        l.memo ?? ''
      )
    }
    db.run('UPDATE journal_entries SET posted = 1 WHERE id = ?', id)
    return id
  })
}

/** Posts the mirror image of an entry. Each entry can be reversed once. */
export function reverseEntry(db: Db, entryId: number, date: string, memo?: string): number {
  const original = getEntry(db, entryId)
  if (original.reversedById !== null) throw new UserError('This entry has already been reversed.')
  if (original.source === 'reversal') throw new UserError('A reversal cannot itself be reversed.')
  if (date < original.date) throw new UserError('A reversal cannot be dated before the original entry.')
  return postEntry(db, {
    date,
    memo: memo ?? `Reversal of #${original.id}: ${original.memo}`,
    source: 'reversal',
    reversesId: original.id,
    lines: original.lines.map((l) => ({
      accountId: l.accountId,
      debit: l.creditCents,
      credit: l.debitCents,
      memo: l.memo
    }))
  })
}

interface EntryRow {
  id: number
  date: string
  memo: string
  source: EntrySource
  reverses_id: number | null
  reversed_by_id: number | null
}

interface LineRow {
  entry_id: number
  account_id: number
  code: string
  name: string
  debit: number
  credit: number
  memo: string
}

const ENTRY_SELECT = `
  SELECT e.id, e.date, e.memo, e.source, e.reverses_id,
         (SELECT r.id FROM journal_entries r WHERE r.reverses_id = e.id AND r.posted = 1) AS reversed_by_id
  FROM journal_entries e
  WHERE e.posted = 1`

function attachLines(db: Db, rows: EntryRow[]): JournalEntry[] {
  if (rows.length === 0) return []
  const byId = new Map<number, JournalLine[]>()
  // Fetch lines for all entries in one query (chunked to stay under SQLite's parameter limit).
  for (let i = 0; i < rows.length; i += 500) {
    const ids = rows.slice(i, i + 500).map((r) => r.id)
    const lines = db.all<LineRow>(
      `SELECT l.entry_id, l.account_id, a.code, a.name, l.debit, l.credit, l.memo
       FROM journal_lines l JOIN accounts a ON a.id = l.account_id
       WHERE l.entry_id IN (${ids.map(() => '?').join(',')})
       ORDER BY l.entry_id, l.credit > 0, l.id`,
      ...ids
    )
    for (const l of lines) {
      const list = byId.get(l.entry_id) ?? []
      list.push({
        accountId: l.account_id,
        accountCode: l.code,
        accountName: l.name,
        debitCents: l.debit,
        creditCents: l.credit,
        memo: l.memo
      })
      byId.set(l.entry_id, list)
    }
  }
  return rows.map((r) => {
    const lines = byId.get(r.id) ?? []
    return {
      id: r.id,
      date: r.date,
      memo: r.memo,
      source: r.source,
      reversesId: r.reverses_id,
      reversedById: r.reversed_by_id,
      totalCents: lines.reduce((s, l) => s + l.debitCents, 0),
      lines
    }
  })
}

export function getEntry(db: Db, id: number): JournalEntry {
  const row = db.get<EntryRow>(`${ENTRY_SELECT} AND e.id = ?`, id)
  if (!row) throw new UserError('Journal entry not found.')
  return attachLines(db, [row])[0]
}

export function listEntries(db: Db, limit = 500): JournalEntry[] {
  const rows = db.all<EntryRow>(`${ENTRY_SELECT} ORDER BY e.date DESC, e.id DESC LIMIT ?`, limit)
  return attachLines(db, rows)
}

export function listEntriesBetween(db: Db, from: string, to: string): JournalEntry[] {
  const rows = db.all<EntryRow>(`${ENTRY_SELECT} AND e.date BETWEEN ? AND ? ORDER BY e.date, e.id`, from, to)
  return attachLines(db, rows)
}

export interface ManualEntryInput {
  date: string
  memo: string
  lines: { accountId: number; debitCents: number; creditCents: number; memo: string }[]
}

export function createManualEntry(db: Db, input: ManualEntryInput): JournalEntry {
  const id = postEntry(db, {
    date: input.date,
    memo: input.memo,
    source: 'manual',
    lines: input.lines.map((l) => ({ accountId: l.accountId, debit: l.debitCents, credit: l.creditCents, memo: l.memo }))
  })
  return getEntry(db, id)
}

/**
 * Reverses a manual or imported entry. Entries created by invoices, payments,
 * expenses and GST filings must be voided from their own screen so the
 * document and the books stay in step.
 */
export function reverseManualEntry(db: Db, id: number, date: string): JournalEntry {
  const entry = getEntry(db, id)
  if (entry.source !== 'manual' && entry.source !== 'import') {
    const where: Record<string, string> = {
      invoice: 'Void the invoice from the Invoices page.',
      payment: 'Void the payment from its invoice.',
      expense: 'Void the expense from the Expenses page.',
      gst_return: 'Filed GST returns cannot be reversed.',
      reversal: 'A reversal cannot itself be reversed.'
    }
    throw new UserError(where[entry.source] ?? 'This entry cannot be reversed here.')
  }
  return getEntry(db, reverseEntry(db, id, date))
}
