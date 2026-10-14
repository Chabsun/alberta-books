/**
 * Bank feed: statements are imported into a review queue. Each transaction
 * gets a suggested category (your rules first, then what you chose last time
 * for the same payee, matching invoices for deposits, and transfers between
 * your own accounts). Nothing reaches the books until it is categorized.
 *
 *   money out → an expense category  → an Expense (CRA rules apply)
 *   money in  → an unpaid invoice    → a Payment
 *   another of your accounts         → a transfer (both sides linked)
 *   anything else                    → a journal entry
 * Undoing a categorization posts a reversal; nothing is deleted.
 */
import { createHash } from 'node:crypto'
import type { Db } from '../db/connection'
import { UserError } from '../errors'
import { todayIso } from '../../shared/dates'
import { gstIncluded as gstInGross } from '../../shared/money'
import { taxRule } from '../../shared/taxRules'
import type { BankRule, BankTransaction, StatementImportResult } from '../../shared/types'
import { accountIdByRole, getAccount, requireAccount } from './accounts'
import { audit } from './audit'
import { createExpense, voidExpense } from './expenses'
import { getInvoice, recordPayment, voidPayment } from './invoices'
import { postEntry, reverseEntry, type NewLine } from './ledger'
import { parseStatement, type CsvMapping } from './statements'

interface TxRow {
  id: number
  account_id: number
  account_name: string
  date: string
  amount: number
  description: string
  payee: string | null
  status: 'unreviewed' | 'posted' | 'excluded'
  entry_id: number | null
  link_kind: 'expense' | 'payment' | 'entry' | 'transfer' | null
  link_id: number | null
  suggested_account_id: number | null
  suggested_account_name: string | null
  suggested_invoice_id: number | null
  suggestion_source: string | null
  note: string
  category: string | null
}

const SELECT = `
  SELECT t.id, t.account_id, a.name AS account_name, t.date, t.amount, t.description, t.payee, t.status, t.entry_id,
         t.link_kind, t.link_id, t.suggested_account_id, sa.name AS suggested_account_name, t.suggested_invoice_id,
         t.suggestion_source, t.note,
         (SELECT group_concat(ca.name, ', ') FROM journal_lines jl JOIN accounts ca ON ca.id = jl.account_id
            WHERE jl.entry_id = t.entry_id AND jl.account_id <> t.account_id AND ca.role IS NULL) AS category
  FROM bank_transactions t
  JOIN accounts a ON a.id = t.account_id
  LEFT JOIN accounts sa ON sa.id = t.suggested_account_id`

function toTx(r: TxRow): BankTransaction {
  return {
    id: r.id,
    accountId: r.account_id,
    accountName: r.account_name,
    date: r.date,
    amountCents: r.amount,
    description: r.description,
    payee: r.payee,
    status: r.status,
    entryId: r.entry_id,
    linkKind: r.link_kind,
    linkId: r.link_id,
    category: r.category,
    suggestedAccountId: r.suggested_account_id,
    suggestedAccountName: r.suggested_account_name,
    suggestedInvoiceId: r.suggested_invoice_id,
    suggestionSource: r.suggestion_source,
    note: r.note
  }
}

export function getBankTransaction(db: Db, id: number): BankTransaction {
  const r = db.get<TxRow>(`${SELECT} WHERE t.id = ?`, id)
  if (!r) throw new UserError('Bank transaction not found.')
  return toTx(r)
}

export function listBankTransactions(
  db: Db,
  f: { status?: string; accountId?: number; from?: string; to?: string; search?: string; limit?: number } = {}
): BankTransaction[] {
  const where: string[] = []
  const p: (string | number)[] = []
  if (f.status) (where.push('t.status = ?'), p.push(f.status))
  if (f.accountId) (where.push('t.account_id = ?'), p.push(f.accountId))
  if (f.from) (where.push('t.date >= ?'), p.push(f.from))
  if (f.to) (where.push('t.date <= ?'), p.push(f.to))
  if (f.search) (where.push('(t.description LIKE ? OR t.payee LIKE ?)'), p.push(`%${f.search}%`, `%${f.search}%`))
  return db
    .all<TxRow>(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.date DESC, t.id DESC LIMIT ?`, ...p, f.limit ?? 500)
    .map(toTx)
}

// ---------------------------------------------------------------- import

/** Uppercase payee without card numbers, references and noise words, used to learn categories. */
export function normalizePayee(text: string): string {
  return text
    .toUpperCase()
    .replace(/\b(POS|ACHAT|PURCHASE|PAIEMENT|PAYMENT|DEBIT|INTERAC|VISA|MC|PREAUTHORIZED|PRE-AUTH|PPA|DD|E-TRANSFER|VIREMENT|RETRAIT|DEPOT)\b/g, ' ')
    .replace(/[#*]?\d[\d\-*#/]{2,}/g, ' ')
    .replace(/[^A-ZÀ-Ÿ&' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
}

export function importStatement(
  db: Db,
  input: { bankAccountId: number; fileName: string; bytes: Uint8Array; mapping?: CsvMapping }
): StatementImportResult {
  const bank = requireAccount(db, input.bankAccountId, (a) => a.isBank, 'Account')
  if (input.bytes.length > 10 * 1024 * 1024) throw new UserError('The file is larger than 10 MB. Export a shorter date range.')
  const parsed = parseStatement(input.fileName, input.bytes, input.mapping)
  if (parsed.transactions.length > 10_000) throw new UserError('The file has more than 10,000 transactions. Export a shorter date range.')
  const sha = createHash('sha256').update(input.bytes).digest('hex')

  return db.tx(() => {
    const { lastInsertRowid: batchId } = db.run(
      'INSERT INTO import_batches (account_id, file_name, format, sha256, rows, inserted, actor) VALUES (?, ?, ?, ?, ?, 0, ?)',
      bank.id,
      input.fileName.slice(0, 200),
      parsed.format,
      sha,
      parsed.transactions.length,
      db.actor
    )
    // Identical rows in one file (two $5 coffees the same day) stay distinct
    // through their occurrence number, which is stable across re-imports.
    const seen = new Map<string, number>()
    const newIds: number[] = []
    for (const t of parsed.transactions) {
      let key: string
      if (t.externalId) key = `fitid:${t.externalId}`
      else {
        const base = `${t.date}|${t.amountCents}|${t.description.toUpperCase().replace(/\s+/g, ' ')}`
        const n = (seen.get(base) ?? 0) + 1
        seen.set(base, n)
        key = 'h:' + createHash('sha1').update(`${base}|${n}`).digest('hex')
      }
      const r = db.run(
        `INSERT OR IGNORE INTO bank_transactions (account_id, date, amount, description, payee, external_id, dedupe_key, batch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        bank.id,
        t.date,
        t.amountCents,
        t.description,
        t.payee,
        t.externalId,
        key,
        batchId
      )
      if (r.changes) newIds.push(r.lastInsertRowid)
    }
    db.run('UPDATE import_batches SET inserted = ? WHERE id = ?', newIds.length, batchId)
    audit(db, 'import', 'import_batch', batchId, `${input.fileName}: ${newIds.length} new of ${parsed.transactions.length}`)

    // Refresh the whole queue: a new file can complete a transfer imported earlier.
    const autoPosted = newIds.length ? refreshSuggestions(db) : 0

    let balanceCheck: StatementImportResult['balanceCheck']
    if (parsed.balance) {
      const ledger = db.get<{ s: number }>(
        'SELECT COALESCE(SUM(debit - credit), 0) AS s FROM ledger WHERE account_id = ? AND date <= ?',
        bank.id,
        parsed.balance.date
      )!.s
      const ledgerNormal = bank.type === 'asset' ? ledger : -ledger
      balanceCheck = { bankCents: parsed.balance.amountCents, booksCents: ledgerNormal, asOf: parsed.balance.date }
    }
    return {
      format: parsed.format,
      rowsInFile: parsed.transactions.length,
      inserted: newIds.length,
      duplicates: parsed.transactions.length - newIds.length,
      autoPosted,
      warnings: parsed.warnings,
      balanceCheck
    }
  })
}

// ---------------------------------------------------------------- rules & suggestions

interface RuleRow {
  id: number
  pattern: string
  match_type: 'contains' | 'equals' | 'starts'
  direction: 'any' | 'in' | 'out'
  account_id: number
  account_name: string
  gst_included: number
  business_pct: number
  auto_post: number
}

export function listRules(db: Db): BankRule[] {
  return db
    .all<RuleRow>('SELECT r.*, a.name AS account_name FROM bank_rules r JOIN accounts a ON a.id = r.account_id ORDER BY r.id')
    .map((r) => ({
      id: r.id,
      pattern: r.pattern,
      matchType: r.match_type,
      direction: r.direction,
      accountId: r.account_id,
      accountName: r.account_name,
      gstIncluded: r.gst_included === 1,
      businessPct: r.business_pct,
      autoPost: r.auto_post === 1
    }))
}

export function saveRule(
  db: Db,
  r: { pattern: string; matchType?: 'contains' | 'equals' | 'starts'; direction?: 'any' | 'in' | 'out'; accountId: number; gstIncluded?: boolean; businessPct?: number; autoPost?: boolean }
): BankRule {
  const pattern = r.pattern.trim()
  if (pattern.length < 2) throw new UserError('The rule needs at least 2 characters of text to match.')
  getAccount(db, r.accountId)
  const { lastInsertRowid } = db.run(
    `INSERT INTO bank_rules (pattern, match_type, direction, account_id, gst_included, business_pct, auto_post) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    pattern,
    r.matchType ?? 'contains',
    r.direction ?? 'any',
    r.accountId,
    r.gstIncluded === false ? 0 : 1,
    r.businessPct ?? 100,
    r.autoPost ? 1 : 0
  )
  audit(db, 'create', 'bank_rule', lastInsertRowid, pattern)
  return listRules(db).find((x) => x.id === lastInsertRowid)!
}

export function deleteRule(db: Db, id: number): void {
  db.run('DELETE FROM bank_rules WHERE id = ?', id)
  audit(db, 'delete', 'bank_rule', id, '')
}

function ruleMatches(r: BankRule, t: BankTransaction): boolean {
  if (r.direction === 'in' && t.amountCents < 0) return false
  if (r.direction === 'out' && t.amountCents > 0) return false
  const hay = `${t.description} ${t.payee ?? ''}`.toLowerCase()
  const pat = r.pattern.toLowerCase()
  if (r.matchType === 'equals') return t.description.trim().toLowerCase() === pat
  if (r.matchType === 'starts') return hay.startsWith(pat)
  return hay.includes(pat)
}

/** Recomputes suggestions for unreviewed transactions; posts those whose rule says so. Returns how many were posted. */
export function refreshSuggestions(db: Db, ids?: number[]): number {
  const rules = listRules(db)
  const txs = (ids ? ids.map((id) => getBankTransaction(db, id)) : listBankTransactions(db, { status: 'unreviewed', limit: 5000 })).filter(
    (t) => t.status === 'unreviewed'
  )
  let posted = 0
  for (const t of txs) {
    let accountId: number | null = null
    let invoiceId: number | null = null
    let source: string | null = null
    const rule = rules.find((r) => ruleMatches(r, t))
    if (rule) {
      accountId = rule.accountId
      source = `rule:${rule.id}`
    }
    if (!accountId && t.amountCents > 0) {
      const inv = db.get<{ id: number }>(
        `SELECT i.id FROM invoices i WHERE i.status = 'issued'
           AND i.total - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id AND p.void_entry_id IS NULL), 0) = ?
         ORDER BY abs(julianday(i.due_date) - julianday(?)) LIMIT 1`,
        t.amountCents,
        t.date
      )
      if (inv) {
        invoiceId = inv.id
        source = 'invoice'
      }
    }
    if (!accountId && !invoiceId) {
      const other = db.get<{ account_id: number }>(
        `SELECT account_id FROM bank_transactions WHERE account_id <> ? AND amount = ? AND abs(julianday(date) - julianday(?)) <= 5 LIMIT 1`,
        t.accountId,
        -t.amountCents,
        t.date
      )
      if (other) {
        accountId = other.account_id
        source = 'transfer'
      }
    }
    if (!accountId && !invoiceId) {
      const key = normalizePayee(t.payee || t.description)
      if (key) {
        const history = db.all<{ description: string; payee: string | null; entry_id: number; account_id: number }>(
          `SELECT bt.description, bt.payee, bt.entry_id, bt.account_id FROM bank_transactions bt
           WHERE bt.status = 'posted' AND bt.entry_id IS NOT NULL AND (bt.amount < 0) = (? < 0)
           ORDER BY bt.date DESC LIMIT 1000`,
          t.amountCents
        )
        for (const h of history) {
          if (normalizePayee(h.payee || h.description) !== key) continue
          const cat = db.get<{ account_id: number }>(
            `SELECT l.account_id FROM journal_lines l JOIN accounts a ON a.id = l.account_id
             WHERE l.entry_id = ? AND l.account_id <> ? AND a.role IS NULL ORDER BY l.id LIMIT 1`,
            h.entry_id,
            h.account_id
          )
          if (cat) {
            accountId = cat.account_id
            source = 'history'
            break
          }
        }
      }
    }
    db.run(
      'UPDATE bank_transactions SET suggested_account_id = ?, suggested_invoice_id = ?, suggestion_source = ? WHERE id = ?',
      accountId,
      invoiceId,
      source,
      t.id
    )
    if (rule?.autoPost) {
      try {
        categorize(db, t.id, { kind: 'account', accountId: rule.accountId, gstIncluded: rule.gstIncluded, businessPct: rule.businessPct })
        posted++
      } catch {
        // Stays in the queue (e.g. locked period, or details CRA needs); the suggestion is saved.
      }
    }
  }
  return posted
}

// ---------------------------------------------------------------- categorize

export type CategorizeTarget =
  | {
      kind: 'account'
      accountId: number
      /** The amount includes GST at 5% (split out automatically). */
      gstIncluded?: boolean
      businessPct?: number
      purpose?: string
      attendees?: string
      supplierGstNumber?: string
      memo?: string
    }
  | { kind: 'invoice'; invoiceId: number }

export function categorize(db: Db, id: number, target: CategorizeTarget, remember = false): BankTransaction {
  return db.tx(() => {
    const t = getBankTransaction(db, id)
    if (t.status !== 'unreviewed') throw new UserError('This transaction is already handled. Undo it first to change it.')
    const bank = getAccount(db, t.accountId)
    const gross = Math.abs(t.amountCents)
    const moneyIn = t.amountCents > 0

    if (target.kind === 'invoice') {
      if (!moneyIn) throw new UserError('Only money coming in can pay an invoice.')
      if (bank.type !== 'asset') throw new UserError('Invoice payments must go to a bank account.')
      const inv = recordPayment(db, { invoiceId: target.invoiceId, date: t.date, amountCents: gross, accountId: bank.id })
      const p = inv.payments[inv.payments.length - 1]
      const entryId = db.get<{ entry_id: number }>('SELECT entry_id FROM payments WHERE id = ?', p.id)!.entry_id
      link(db, id, entryId, 'payment', p.id)
      audit(db, 'categorize', 'bank_transaction', id, `Payment for ${inv.number}`, entryId)
      return getBankTransaction(db, id)
    }

    const cat = requireAccount(db, target.accountId, (a) => a.id !== bank.id && a.role !== 'ar', 'Category')
    const rule = taxRule(cat.taxRule)

    // Transfer between two of your own accounts.
    if (cat.isBank) {
      const entryId = postEntry(db, {
        date: t.date,
        memo: target.memo ?? t.description,
        source: 'import',
        origin: 'bank',
        lines: moneyIn
          ? [
              { accountId: bank.id, debit: gross, credit: 0 },
              { accountId: cat.id, debit: 0, credit: gross }
            ]
          : [
              { accountId: cat.id, debit: gross, credit: 0 },
              { accountId: bank.id, debit: 0, credit: gross }
            ]
      })
      link(db, id, entryId, 'transfer', null)
      const other = db.get<{ id: number }>(
        `SELECT id FROM bank_transactions WHERE account_id = ? AND status = 'unreviewed' AND amount = ?
         AND abs(julianday(date) - julianday(?)) <= 7 ORDER BY abs(julianday(date) - julianday(?)) LIMIT 1`,
        cat.id,
        -t.amountCents,
        t.date,
        t.date
      )
      if (other) link(db, other.id, entryId, 'transfer', null)
      audit(db, 'categorize', 'bank_transaction', id, `Transfer to/from ${cat.name}`, entryId)
      return getBankTransaction(db, id)
    }

    const gst = target.gstIncluded && rule.gst !== 'exempt' ? gstInGross(gross) : 0

    // Money out to an expense or capital category: an Expense, so the CRA rules apply.
    if (!moneyIn && (cat.type === 'expense' || (cat.type === 'asset' && rule.ccaClass))) {
      const x = createExpense(db, {
        date: t.date,
        vendor: (t.payee || t.description).slice(0, 150),
        description: target.memo ?? 'From bank statement',
        accountId: cat.id,
        amountCents: gross - gst,
        gstCents: gst,
        paidFromAccountId: bank.id,
        businessPct: target.businessPct,
        purpose: target.purpose,
        attendees: target.attendees,
        supplierGstNumber: target.supplierGstNumber
      })
      link(db, id, x.entryId, 'expense', x.id)
    } else {
      // Anything else: income, shareholder loan, dividends, GST payments, loans...
      const net = gross - (moneyIn && cat.type === 'income' ? gst : 0)
      const salesGst = moneyIn && cat.type === 'income' ? gst : 0
      const lines: NewLine[] = moneyIn
        ? [
            { accountId: bank.id, debit: gross, credit: 0 },
            { accountId: cat.id, debit: 0, credit: net },
            { accountId: accountIdByRole(db, 'gst_collected'), debit: 0, credit: salesGst }
          ]
        : [
            { accountId: cat.id, debit: gross, credit: 0 },
            { accountId: bank.id, debit: 0, credit: gross }
          ]
      const entryId = postEntry(db, { date: t.date, memo: target.memo ?? t.description, source: 'import', origin: 'bank', lines })
      link(db, id, entryId, 'entry', entryId)
    }
    if (remember) {
      const pattern = normalizePayee(t.payee || t.description)
      if (pattern.length >= 2 && !listRules(db).some((r) => r.pattern.toLowerCase() === pattern.toLowerCase())) {
        saveRule(db, { pattern, accountId: cat.id, gstIncluded: target.gstIncluded ?? false, businessPct: target.businessPct ?? 100, direction: moneyIn ? 'in' : 'out' })
      }
    }
    const done = getBankTransaction(db, id)
    audit(db, 'categorize', 'bank_transaction', id, `${t.description} → ${cat.name}`, done.entryId)
    return done
  })
}

function link(db: Db, id: number, entryId: number, kind: 'expense' | 'payment' | 'entry' | 'transfer', linkId: number | null) {
  db.run(`UPDATE bank_transactions SET status = 'posted', entry_id = ?, link_kind = ?, link_id = ? WHERE id = ?`, entryId, kind, linkId, id)
}

/** Takes a transaction back to the queue, reversing what it posted. */
export function uncategorize(db: Db, id: number, date = todayIso()): BankTransaction {
  return db.tx(() => {
    const t = getBankTransaction(db, id)
    if (t.status === 'excluded') {
      db.run(`UPDATE bank_transactions SET status = 'unreviewed', note = '' WHERE id = ?`, id)
      return getBankTransaction(db, id)
    }
    if (t.status !== 'posted' || t.entryId === null) throw new UserError('This transaction is not categorized.')
    const when = date < t.date ? t.date : date
    if (t.linkKind === 'expense' && t.linkId) voidExpense(db, t.linkId, when)
    else if (t.linkKind === 'payment' && t.linkId) voidPayment(db, t.linkId, when)
    else reverseEntry(db, t.entryId, when, `Undo bank categorization: ${t.description}`)
    db.run(
      `UPDATE bank_transactions SET status = 'unreviewed', entry_id = NULL, link_kind = NULL, link_id = NULL WHERE entry_id = ?`,
      t.entryId
    )
    audit(db, 'uncategorize', 'bank_transaction', id, t.description)
    return getBankTransaction(db, id)
  })
}

export function excludeTransaction(db: Db, id: number, reason: string): BankTransaction {
  const t = getBankTransaction(db, id)
  if (t.status !== 'unreviewed') throw new UserError('Undo the categorization first.')
  db.run(`UPDATE bank_transactions SET status = 'excluded', note = ? WHERE id = ?`, reason.slice(0, 300), id)
  audit(db, 'exclude', 'bank_transaction', id, reason)
  return getBankTransaction(db, id)
}

export function invoiceTitle(db: Db, id: number): string {
  const i = getInvoice(db, id)
  return `${i.number} – ${i.clientName}`
}
