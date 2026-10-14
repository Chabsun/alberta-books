/**
 * Bank and credit card statement parsing: OFX / QFX / QBO (what National
 * Bank, RBC, TD and most Canadian banks export for QuickBooks) and CSV with
 * English and French column names.
 */
import { UserError } from '../errors'
import { parseCsvDate, type CsvDateFormat } from '../../shared/dates'
import { parseMoney } from '../../shared/money'
import { parseCsv } from './csv'

export interface ParsedTransaction {
  date: string
  /** Signed cents: positive = money in, negative = money out. */
  amountCents: number
  description: string
  payee: string | null
  /** Bank's own unique id (OFX FITID), when present. */
  externalId: string | null
}

export interface ParsedStatement {
  format: 'ofx' | 'csv'
  /** Closing balance reported by the bank, when present. */
  balance?: { amountCents: number; date: string }
  transactions: ParsedTransaction[]
  warnings: string[]
}

export interface CsvMapping {
  date: number
  description: number
  /** One signed amount column... */
  amount?: number
  /** ...or separate money-out / money-in columns. */
  debit?: number
  credit?: number
  dateFormat: CsvDateFormat
  hasHeader: boolean
  /** The file shows money out as positive numbers (common on credit cards). */
  flipSigns?: boolean
}

// ---------------------------------------------------------------- OFX

/** Decodes OFX bytes, honouring CHARSET:1252 which banks often use. */
export function decodeStatement(bytes: Uint8Array): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 512))
  if (/CHARSET:\s*1252/i.test(head) || /encoding="(windows-1252|iso-8859-1)"/i.test(head)) {
    return new TextDecoder('windows-1252').decode(bytes)
  }
  return new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '')
}

export function looksLikeOfx(text: string): boolean {
  return /OFXHEADER|<OFX>/i.test(text.slice(0, 2000))
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
}

/** One tag value from SGML (OFX 1.x, unclosed tags) or XML (OFX 2.x). */
function tag(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([^<\\r\\n]*)`, 'i').exec(block)
  const v = m?.[1]?.trim()
  return v ? decodeEntities(v) : undefined
}

function ofxDate(raw: string | undefined): string | undefined {
  const m = raw ? /^(\d{4})(\d{2})(\d{2})/.exec(raw) : null
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined
}

export function parseOfx(text: string): ParsedStatement {
  const warnings: string[] = []
  const blocks = text.match(/<STMTTRN>[\s\S]*?(?=<STMTTRN>|<\/BANKTRANLIST>|<\/STMTTRN>|$)/gi) ?? []
  const transactions: ParsedTransaction[] = []
  for (const b of blocks) {
    const date = ofxDate(tag(b, 'DTPOSTED') ?? tag(b, 'DTUSER'))
    const amount = parseMoney(tag(b, 'TRNAMT') ?? '')
    if (!date || amount === null) {
      warnings.push(`Skipped a transaction without a date or amount: ${b.slice(0, 80).replace(/\s+/g, ' ')}`)
      continue
    }
    if (amount === 0) continue
    const name = tag(b, 'NAME')
    const memo = tag(b, 'MEMO')
    const checkNum = tag(b, 'CHECKNUM')
    const description = [name, memo && memo !== name ? memo : null, checkNum ? `Cheque #${checkNum}` : null].filter(Boolean).join(' – ')
    transactions.push({
      date,
      amountCents: amount,
      description: (description || tag(b, 'TRNTYPE') || 'Transaction').slice(0, 300),
      payee: name ?? null,
      externalId: tag(b, 'FITID') ?? null
    })
  }
  const ledger = /<LEDGERBAL>[\s\S]*?(?=<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>|<\/CCSTMTRS>|$)/i.exec(text)?.[0]
  const balAmt = ledger ? parseMoney(tag(ledger, 'BALAMT') ?? '') : null
  const balDate = ledger ? ofxDate(tag(ledger, 'DTASOF')) : undefined
  if (!transactions.length) warnings.push('No transactions found in the file.')
  return {
    format: 'ofx',
    balance: balAmt !== null && balDate ? { amountCents: balAmt, date: balDate } : undefined,
    transactions,
    warnings
  }
}

// ---------------------------------------------------------------- CSV

const SYNONYMS: Record<'date' | 'description' | 'amount' | 'debit' | 'credit', RegExp> = {
  date: /^(transaction date|date de transaction|date of transaction|posted date|posting date|date|date d'opération|date de l'opération)$/i,
  description: /^(description|details|détails|transaction details|libellé|memo|narrative|payee|bénéficiaire|merchant|marchand)$/i,
  amount: /^(amount|montant|cad\$|cad|transaction amount|montant \(\$\))$/i,
  debit: /^(debit|débit|withdrawals?|retraits?|money out|paid out|sorties?)$/i,
  credit: /^(credit|crédit|deposits?|dépôts?|money in|paid in|entrées?)$/i
}

export function readCsvFile(text: string): string[][] {
  return parseCsv(text.replace(/^﻿/, ''))
}

/** Guesses columns, header presence and date format from the first rows. */
export function guessMapping(rows: string[][]): CsvMapping {
  const first = rows[0] ?? []
  const hasHeader = first.some((c) => /[a-zà-ÿ]{3,}/i.test(c)) && !first.some((c) => parseCsvDate(c, 'ymd') || parseCsvDate(c, 'mdy'))
  const find = (re: RegExp) => (hasHeader ? first.findIndex((h) => re.test(h.trim().replace(/\s*\(.*\)$/, ''))) : -1)
  let date = find(SYNONYMS.date)
  let description = find(SYNONYMS.description)
  const amount = find(SYNONYMS.amount)
  const debit = find(SYNONYMS.debit)
  const credit = find(SYNONYMS.credit)
  const data = hasHeader ? rows.slice(1) : rows
  if (date < 0) date = Math.max(0, (data[0] ?? []).findIndex((c) => parseCsvDate(c, 'ymd') || parseCsvDate(c, 'mdy') || parseCsvDate(c, 'dmy')))
  if (description < 0) description = (data[0] ?? []).findIndex((c, i) => i !== date && /[a-z]{3,}/i.test(c))
  if (description < 0) description = date === 0 ? 1 : 0
  const samples = data.slice(0, 60).map((r) => r[date] ?? '')
  const dateFormat: CsvDateFormat =
    (['ymd', 'mdy', 'dmy'] as CsvDateFormat[]).find((f) => samples.every((s) => parseCsvDate(s, f) !== null)) ?? 'mdy'
  if (amount >= 0) return { date, description, amount, dateFormat, hasHeader }
  if (debit >= 0 || credit >= 0) return { date, description, debit: debit >= 0 ? debit : undefined, credit: credit >= 0 ? credit : undefined, dateFormat, hasHeader }
  // No header: the first numeric columns after the description are out / in (TD, RBC exports).
  const numeric = (data[0] ?? []).map((c, i) => (i !== date && i !== description && /^-?[\d,$().]+$/.test(c.trim() || '0') ? i : -1)).filter((i) => i >= 0)
  if (numeric.length >= 2) return { date, description, debit: numeric[0], credit: numeric[1], dateFormat, hasHeader }
  return { date, description, amount: numeric[0] ?? 2, dateFormat, hasHeader }
}

export function parseCsvStatement(rows: string[][], m: CsvMapping): ParsedStatement {
  const warnings: string[] = []
  const transactions: ParsedTransaction[] = []
  const data = m.hasHeader ? rows.slice(1) : rows
  data.forEach((r, i) => {
    const line = i + (m.hasHeader ? 2 : 1)
    const date = parseCsvDate(r[m.date] ?? '', m.dateFormat)
    let amount: number | null
    if (m.amount !== undefined) amount = parseMoney(r[m.amount] ?? '')
    else {
      const outRaw = m.debit !== undefined ? (r[m.debit] ?? '').trim() : ''
      const inRaw = m.credit !== undefined ? (r[m.credit] ?? '').trim() : ''
      const out = outRaw ? parseMoney(outRaw) : 0
      const inn = inRaw ? parseMoney(inRaw) : 0
      amount = out === null || inn === null ? null : Math.abs(inn) - Math.abs(out)
    }
    const description = (r[m.description] ?? '').trim()
    if (!date || amount === null) {
      if (r.some((c) => c.trim())) warnings.push(`Line ${line} skipped: the date or amount could not be read.`)
      return
    }
    if (amount === 0) return
    transactions.push({
      date,
      amountCents: m.flipSigns ? -amount : amount,
      description: (description || '(no description)').slice(0, 300),
      payee: null,
      externalId: null
    })
  })
  if (!transactions.length) warnings.push('No transactions could be read with these column settings.')
  return { format: 'csv', transactions, warnings }
}

/** Parses any supported statement. CSV uses `mapping` or a guess. */
export function parseStatement(fileName: string, bytes: Uint8Array, mapping?: CsvMapping): ParsedStatement {
  const text = decodeStatement(bytes)
  if (looksLikeOfx(text) || /\.(ofx|qfx|qbo)$/i.test(fileName)) return parseOfx(text)
  if (!/\.(csv|txt)$/i.test(fileName) && !text.includes(',')) throw new UserError('Unsupported file. Use an OFX, QFX, QBO or CSV statement.')
  const rows = readCsvFile(text)
  if (rows.length === 0) throw new UserError('The file is empty.')
  return parseCsvStatement(rows, mapping ?? guessMapping(rows))
}
