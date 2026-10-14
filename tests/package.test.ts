import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { buildAccountantPackage, importFiles, statementsHtml } from '../src/main/services/accountantPackage'
import { parseCsv } from '../src/main/services/csv'
import { createExpense } from '../src/main/services/expenses'
import { addReceipt } from '../src/main/services/receipts'
import { updateSettings } from '../src/main/services/settings'
import { readXlsxFirstSheet } from '../src/main/services/xlsx'
import { acct, issued, makeDb, role } from './helpers'

const enc = (s: string) => new TextEncoder().encode(s)

function books() {
  const db = makeDb()
  updateSettings(db, { companyName: 'Chabsun <Consulting> Ltd.', fiscalYearEndMonth: 8 })
  issued(db, 10_000_00, '2025-10-01')
  const x = createExpense(db, {
    date: '2025-11-15',
    vendor: 'Staples',
    description: 'Paper',
    accountId: acct(db, '5160'),
    amountCents: 40_00,
    gstCents: 2_00,
    paidFromAccountId: role(db, 'bank')
  })
  // Outside the fiscal year: must not be in the package.
  const old = createExpense(db, { date: '2025-08-01', vendor: 'Old', description: '', accountId: acct(db, '5160'), amountCents: 10_00, gstCents: 0, paidFromAccountId: role(db, 'bank') })
  const dir = mkdtempSync(join(tmpdir(), 'books-pkg-'))
  addReceipt(db, dir, { fileName: 'staples.pdf', bytes: enc('%PDF-1.4\n% receipt one\n'), expenseId: x.id })
  addReceipt(db, dir, { fileName: 'old.pdf', bytes: enc('%PDF-1.4\n% receipt two\n'), expenseId: old.id })
  return { db, dir }
}

describe('accountant package', () => {
  it('zips statements, workbook, CSVs, import files and the year’s receipts', async () => {
    const { db, dir } = books()
    let html = ''
    const pkg = await buildAccountantPackage(db, dir, '2026-08-31', async (h) => {
      html = h
      return enc('%PDF-1.7 stub')
    })
    expect(pkg.fileName).toBe('Chabsun <Consulting> Ltd. – accountant package FY 2026-08-31.zip'.replace(/[<>]/g, '-'))
    expect(pkg.receipts).toBe(1)
    const files = unzipSync(pkg.zip)
    const names = Object.keys(files)
    expect(names).toEqual(
      expect.arrayContaining([
        'README.txt',
        '01 Financial statements.pdf',
        '02 Workbook.xlsx',
        'csv/Balance sheet.csv',
        'csv/Income statement.csv',
        'csv/Tax adjustments.csv',
        'import/trial_balance_with_GIFI.csv',
        'import/GIFI_schedule_100.csv',
        'import/GIFI_schedule_125.csv',
        'import/journal_generic.csv',
        'import/quickbooks_online_journal.csv',
        'import/xero_manual_journals.csv'
      ])
    )
    const receipts = names.filter((n) => n.startsWith('receipts/'))
    expect(receipts).toEqual([expect.stringMatching(/^receipts\/2025-11-15 Staples 42\.00 \(receipt \d+\)\.pdf$/)])
    expect(strFromU8(files['README.txt'])).toContain('Fiscal year: 2025-09-01 to 2026-08-31')
    expect(readXlsxFirstSheet(files['02 Workbook.xlsx']).length).toBeGreaterThan(2)
    // Company name is escaped in the statements.
    expect(html).toContain('Chabsun &lt;Consulting&gt; Ltd.')
    expect(html).not.toContain('<Consulting>')
  })

  it('import files balance and use each software’s format', () => {
    const { db } = books()
    const f = importFiles(db, '2026-08-31')
    const rows = (csv: string) => parseCsv(csv).slice(1)
    const sum = (list: string[][], col: number) => list.reduce((s, r) => s + Math.round(Number(r[col] || 0) * 100), 0)

    const tb = rows(f['trial_balance_with_GIFI.csv'])
    expect(sum(tb, 3)).toBe(sum(tb, 4))
    expect(tb.every((r) => /^\d{4}$/.test(r[2]))).toBe(true)

    const qbo = rows(f['quickbooks_online_journal.csv'])
    expect(qbo[0][1]).toMatch(/^\d{2}\/\d{2}\/\d{4}$/)
    expect(sum(qbo, 3)).toBe(sum(qbo, 4))

    const xero = rows(f['xero_manual_journals.csv'])
    expect(sum(xero, 5)).toBe(0)
    expect(xero.every((r) => r[4] === 'Tax Exempt')).toBe(true)

    // Only entries inside the fiscal year.
    const generic = rows(f['journal_generic.csv'])
    expect(generic.every((r) => r[0] >= '2025-09-01' && r[0] <= '2026-08-31')).toBe(true)
  })

  it('statement HTML has no scripts', () => {
    const { db } = books()
    const html = statementsHtml(db, '2026-08-31')
    expect(html).not.toMatch(/<script/i)
    expect(html).toContain("default-src 'none'")
  })
})
