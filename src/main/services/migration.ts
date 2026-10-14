/**
 * Bringing history over from QuickBooks (Online or Desktop) or Zoho Books.
 *
 * Use their "Journal" report export (CSV or Excel): one row per account line,
 * with Debit and Credit columns. Rows are grouped back into transactions,
 * accounts are matched by name or number, and anything unmatched must be
 * mapped before importing, so nothing lands in the wrong account silently.
 * A dry run shows what would happen without changing anything.
 *
 * The simpler alternative: enter opening balances from your last year-end
 * trial balance and start fresh from that date.
 */
import type { Db } from '../db/connection'
import { UserError } from '../errors'
import { isIsoDate } from '../../shared/dates'
import { parseMoney } from '../../shared/money'
import type { MigrationAnalysis, MigrationResult } from '../../shared/types'
import { listAccounts } from './accounts'
import { audit } from './audit'
import { parseCsv } from './csv'
import { postEntry, type NewLine } from './ledger'
import { readXlsxFirstSheet } from './xlsx'

const COLS = {
  date: /^(date|transaction date|txn date|journal date)$/i,
  txn: /^(trans #|transaction ?#|transaction id|txn id|journal ?#|entry ?#|no\.?|num|journal number|reference number)$/i,
  type: /^(transaction type|type|txn type)$/i,
  name: /^(name|contact|customer|vendor|payee|customer\/vendor)$/i,
  memo: /^(memo\/description|memo|description|transaction details|details|notes|line description)$/i,
  account: /^(account|account name|split|distribution account)$/i,
  debit: /^(debit|debit amount|debit \(cad\))$/i,
  credit: /^(credit|credit amount|credit \(cad\))$/i
}
type ColKey = keyof typeof COLS

interface Group {
  key: string
  date: string
  type: string
  memo: string
  lines: { account: string; amountCents: number; memo: string }[]
}

export function readTabular(fileName: string, bytes: Uint8Array): string[][] {
  if (/\.xlsx$/i.test(fileName)) return readXlsxFirstSheet(bytes)
  if (!/\.(csv|txt)$/i.test(fileName)) throw new UserError('Use the Journal report exported as CSV or Excel (.xlsx).')
  return parseCsv(new TextDecoder('utf-8').decode(bytes))
}

function parseDateLoose(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s)
  if (m) return norm(m[1], m[2], m[3])
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s) // QuickBooks: MM/DD/YYYY
  if (m) return norm(m[3], m[1], m[2])
  m = /^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -,]+(\d{4})$/.exec(s) // Zoho: 05 Jan 2026
  if (m) {
    const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].toLowerCase()) + 1
    if (mon) return norm(m[3], String(mon), m[1])
  }
  return null
}

function norm(y: string, mo: string, d: string): string | null {
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
  return isIsoDate(iso) ? iso : null
}

function parseJournal(rows: string[][]): Group[] {
  const headerIdx = rows.findIndex((r) => {
    const cells = r.map((c) => (c ?? '').trim())
    return cells.some((c) => COLS.account.test(c)) && cells.some((c) => COLS.debit.test(c)) && cells.some((c) => COLS.credit.test(c))
  })
  if (headerIdx < 0) throw new UserError('No header row with Account, Debit and Credit columns was found. Export the "Journal" report from QuickBooks or Zoho.')
  const header = rows[headerIdx].map((c) => (c ?? '').trim())
  const idx = Object.fromEntries((Object.keys(COLS) as ColKey[]).map((k) => [k, header.findIndex((h) => COLS[k].test(h))])) as Record<ColKey, number>
  if (idx.date < 0) throw new UserError('No Date column was found in the journal export.')

  const groups: Group[] = []
  let current: Group | null = null
  let lastDate: string | null = null
  const cell = (r: string[], k: ColKey) => (idx[k] >= 0 ? (r[idx[k]] ?? '').trim() : '')
  for (const r of rows.slice(headerIdx + 1)) {
    if (r.every((c) => !(c ?? '').trim())) {
      current = null
      continue
    }
    const account = cell(r, 'account')
    const debit = cell(r, 'debit')
    const credit = cell(r, 'credit')
    if (!account || (!debit && !credit)) {
      if (/^total/i.test(r.join(' ').trim())) current = null
      continue
    }
    const date = parseDateLoose(cell(r, 'date'))
    if (date) lastDate = date
    const txn = cell(r, 'txn')
    const key = txn ? `${cell(r, 'type')}|${txn}|${date ?? lastDate}` : null
    const balanced = current !== null && current.lines.length > 0 && current.lines.reduce((s, l) => s + l.amountCents, 0) === 0
    if (!current || (key !== null && key !== current.key) || (key === null && date !== null && balanced)) {
      current = { key: key ?? `row${groups.length + 1}`, date: date ?? lastDate ?? '', type: cell(r, 'type'), memo: cell(r, 'memo'), lines: [] }
      groups.push(current)
    }
    const d = debit ? parseMoney(debit) : 0
    const c = credit ? parseMoney(credit) : 0
    if (d === null || c === null) throw new UserError(`Could not read the amount on the line for "${account}".`)
    current.lines.push({ account, amountCents: d - c, memo: cell(r, 'memo') })
  }
  return groups.filter((g) => g.lines.length > 0)
}

/** QuickBooks/Zoho names often carry a parent ("Expenses:Office") or a number prefix. */
function cleanName(n: string): string {
  return n.replace(/^\d+\s+[-·]?\s*/, '').split(':').pop()!.trim().toLowerCase()
}

function autoMap(db: Db, names: string[]): Record<string, number | null> {
  const accounts = listAccounts(db, true)
  const map: Record<string, number | null> = {}
  for (const n of names) {
    const code = /^(\d{3,6})\b/.exec(n)?.[1]
    const hit =
      accounts.find((a) => a.name.toLowerCase() === n.toLowerCase()) ??
      accounts.find((a) => a.name.toLowerCase() === cleanName(n)) ??
      (code ? accounts.find((a) => a.code === code) : undefined)
    map[n] = hit?.id ?? null
  }
  return map
}

export function analyzeJournal(db: Db, fileName: string, bytes: Uint8Array): MigrationAnalysis {
  const groups = parseJournal(readTabular(fileName, bytes))
  const names = [...new Set(groups.flatMap((g) => g.lines.map((l) => l.account)))].sort()
  const dates = groups.map((g) => g.date).filter(Boolean).sort()
  return {
    transactions: groups.length,
    lines: groups.reduce((s, g) => s + g.lines.length, 0),
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
    accounts: names.map((name) => ({ name, accountId: autoMap(db, [name])[name] })),
    unbalanced: groups.filter((g) => g.lines.reduce((s, l) => s + l.amountCents, 0) !== 0).length
  }
}

export function importJournal(
  db: Db,
  fileName: string,
  bytes: Uint8Array,
  opts: { source: 'quickbooks' | 'zoho' | 'other'; mapping: Record<string, number>; from?: string; to?: string; dryRun?: boolean }
): MigrationResult {
  const groups = parseJournal(readTabular(fileName, bytes)).filter((g) => (!opts.from || g.date >= opts.from) && (!opts.to || g.date <= opts.to))
  const names = [...new Set(groups.flatMap((g) => g.lines.map((l) => l.account)))]
  const map = { ...autoMap(db, names), ...opts.mapping }
  const missing = names.filter((n) => !map[n])
  if (missing.length) throw new UserError(`Choose an account for: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '…' : ''}`)

  const skipped: { key: string; reason: string }[] = []
  let imported = 0
  const run = () => {
    for (const g of groups) {
      if (g.lines.reduce((s, l) => s + l.amountCents, 0) !== 0) {
        skipped.push({ key: g.key, reason: 'Debits and credits differ' })
        continue
      }
      if (!g.date) {
        skipped.push({ key: g.key, reason: 'No date' })
        continue
      }
      const lines: NewLine[] = g.lines
        .filter((l) => l.amountCents !== 0)
        .map((l) => ({ accountId: map[l.account]!, debit: Math.max(0, l.amountCents), credit: Math.max(0, -l.amountCents), memo: l.memo.slice(0, 200) }))
      if (lines.length < 2) {
        skipped.push({ key: g.key, reason: 'Fewer than two lines with amounts' })
        continue
      }
      if (!opts.dryRun) {
        postEntry(db, {
          date: g.date,
          memo: [g.type, g.memo].filter(Boolean).join(': ').slice(0, 300) || `Imported ${g.key}`,
          source: 'import',
          origin: opts.source,
          lines
        })
      }
      imported++
    }
  }
  if (opts.dryRun) run()
  else
    db.tx(() => {
      run()
      audit(db, 'import', 'migration', null, `${fileName}: ${imported} transactions from ${opts.source}`)
    })
  return { dryRun: opts.dryRun ?? false, imported, skipped }
}

/** Opening balances on a cut-over date, from the last year-end trial balance. Must balance. */
export function setOpeningBalances(db: Db, date: string, balances: { accountId: number; debitCents: number; creditCents: number }[]): number {
  if (db.get(`SELECT 1 FROM journal_entries WHERE origin = 'opening' AND posted = 1 AND id NOT IN (SELECT reverses_id FROM journal_entries WHERE reverses_id IS NOT NULL)`)) {
    throw new UserError('Opening balances were already entered. Reverse that entry in the Journal first to replace it.')
  }
  return postEntry(db, {
    date,
    memo: 'Opening balances',
    source: 'manual',
    origin: 'opening',
    lines: balances.map((b) => ({ accountId: b.accountId, debit: b.debitCents, credit: b.creditCents }))
  })
}
