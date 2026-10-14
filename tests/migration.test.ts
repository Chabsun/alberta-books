import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeJournal, importJournal, setOpeningBalances } from '../src/main/services/migration'
import { addReceipt, listReceipts, receiptPath } from '../src/main/services/receipts'
import { createExpense, getExpense } from '../src/main/services/expenses'
import { findIssues } from '../src/main/services/issues'
import { trialBalance } from '../src/main/services/reports'
import { writeXlsx } from '../src/main/services/xlsx'
import { acct, balanceOf, makeDb, role } from './helpers'

const enc = (s: string) => new TextEncoder().encode(s)

// QuickBooks Online "Journal" report export: title rows, then grouped lines.
const QBO = `Chabsun Consulting Ltd.
Journal
"January 1 - March 31, 2026"

Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit
01/05/2026,Invoice,1001,Acme Energy,Consulting,Accounts Receivable (A/R),"1,050.00",
,,,,Consulting,Consulting Income,,"1,000.00"
,,,,GST,GST/HST Payable,,50.00
,,,,,,"$1,050.00","$1,050.00"

01/09/2026,Expense,,Staples,Paper,Office Supplies,40.00,
,,,,,GST/HST Payable,2.00,
,,,,,Chequing,,42.00
,,,,,,$42.00,$42.00
TOTAL,,,,,,"$1,092.00","$1,092.00"
`

// Zoho Books "Journal Report" export: dates like 05 Jan 2026, an entry number column.
const ZOHO = `Date,Journal Number,Account,Debit,Credit,Description
05 Jan 2026,JE-1,Petty Cash,100.00,,Float
05 Jan 2026,JE-1,Owner's Equity,,100.00,Float
`

describe('QuickBooks and Zoho history import', () => {
  it('analyzes a QuickBooks journal export and asks for unmatched accounts', () => {
    const db = makeDb()
    const a = analyzeJournal(db, 'journal.csv', enc(QBO))
    expect(a).toMatchObject({ transactions: 2, lines: 6, from: '2026-01-05', to: '2026-01-09', unbalanced: 0 })
    expect(a.accounts.find((x) => x.name === 'Chequing')).toBeDefined()
    expect(() => importJournal(db, 'journal.csv', enc(QBO), { source: 'quickbooks', mapping: {} })).toThrow(/Choose an account/)
  })

  it('imports with a mapping, and a dry run changes nothing', () => {
    const db = makeDb()
    const mapping = {
      'Accounts Receivable (A/R)': role(db, 'ar'),
      'Consulting Income': role(db, 'sales'),
      'GST/HST Payable': role(db, 'gst_collected'),
      'Office Supplies': acct(db, '5160'),
      Chequing: role(db, 'bank')
    }
    const dry = importJournal(db, 'journal.csv', enc(QBO), { source: 'quickbooks', mapping, dryRun: true })
    expect(dry).toEqual({ dryRun: true, imported: 2, skipped: [] })
    expect(trialBalance(db, '2026-12-31').rows).toHaveLength(0)
    importJournal(db, 'journal.csv', enc(QBO), { source: 'quickbooks', mapping })
    expect(balanceOf(db, role(db, 'sales'))).toBe(1000_00)
    expect(balanceOf(db, role(db, 'gst_collected'))).toBe(48_00)
    expect(balanceOf(db, role(db, 'bank'))).toBe(-42_00)
  })

  it('reads Zoho exports and Excel files', () => {
    const db = makeDb()
    const xlsx = writeXlsx([
      {
        name: 'Journal',
        header: ['Date', 'Journal Number', 'Account', 'Debit', 'Credit', 'Description'],
        rows: [
          ['05 Jan 2026', 'JE-1', 'Petty Cash', 100, null, 'Float'],
          ['05 Jan 2026', 'JE-1', "Owner's Equity", null, 100, 'Float']
        ]
      }
    ])
    for (const [name, bytes] of [['zoho.csv', enc(ZOHO)], ['zoho.xlsx', xlsx]] as const) {
      const a = analyzeJournal(db, name, bytes)
      expect(a).toMatchObject({ transactions: 1, from: '2026-01-05' })
    }
    const r = importJournal(db, 'zoho.csv', enc(ZOHO), { source: 'zoho', mapping: { 'Petty Cash': role(db, 'bank'), "Owner's Equity": role(db, 'share_capital') } })
    expect(r.imported).toBe(1)
  })

  it('enters opening balances once', () => {
    const db = makeDb()
    setOpeningBalances(db, '2025-08-31', [
      { accountId: role(db, 'bank'), debitCents: 25_000_00, creditCents: 0 },
      { accountId: role(db, 'shareholder_loan'), debitCents: 0, creditCents: 5_000_00 },
      { accountId: role(db, 'retained_earnings'), debitCents: 0, creditCents: 20_000_00 }
    ])
    expect(balanceOf(db, role(db, 'bank'))).toBe(25_000_00)
    expect(() => setOpeningBalances(db, '2025-08-31', [])).toThrow(/already entered/)
  })
})

describe('receipts', () => {
  const pdf = enc('%PDF-1.4\n% fake but valid header\n')
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1])

  it('stores photos and PDFs by content, attached to an expense', () => {
    const db = makeDb()
    const dir = mkdtempSync(join(tmpdir(), 'books-receipts-'))
    const x = createExpense(db, { date: '2026-02-01', vendor: 'Staples', description: '', accountId: acct(db, '5160'), amountCents: 40_00, gstCents: 2_00, paidFromAccountId: role(db, 'bank') })
    expect(x.warnings).toContain('Attach the receipt.')
    const r = addReceipt(db, dir, { fileName: '../../evil name.pdf', bytes: pdf, expenseId: x.id })
    expect(r.fileName).toBe('.._.._evil name.pdf')
    expect(readFileSync(receiptPath(db, dir, r.id))).toEqual(Buffer.from(pdf))
    addReceipt(db, dir, { fileName: 'photo.jpg', bytes: jpg, expenseId: x.id })
    expect(listReceipts(db, { expenseId: x.id })).toHaveLength(2)
    expect(getExpense(db, x.id).warnings).not.toContain('Attach the receipt.')
  })

  it('rejects anything that is not a photo or PDF', () => {
    const db = makeDb()
    const dir = mkdtempSync(join(tmpdir(), 'books-receipts-'))
    expect(() => addReceipt(db, dir, { fileName: 'receipt.pdf', bytes: enc('MZ\x90\x00 this is an exe file') })).toThrow(/photo/)
  })
})

describe('issues scanner', () => {
  it('flags missing GST numbers, purposes and the shareholder owing the company', () => {
    const db = makeDb()
    createExpense(db, { date: '2026-02-01', vendor: 'Keg', description: '', accountId: acct(db, '5110'), amountCents: 150_00, gstCents: 7_50, paidFromAccountId: role(db, 'bank') })
    createExpense(db, { date: '2026-02-02', vendor: 'Netflix', description: '', accountId: acct(db, '5200'), amountCents: 20_00, gstCents: 1_00, paidFromAccountId: role(db, 'bank'), businessPct: 0 })
    const codes = findIssues(db, '2026-03-01').map((i) => i.code)
    expect(codes).toEqual(expect.arrayContaining(['itc_documentation', 'missing_purpose', 'shareholder_owes', 'negative_bank', 'setup_company']))
  })
})
