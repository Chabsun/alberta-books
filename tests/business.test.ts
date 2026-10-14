import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deleteDraft,
  getInvoice,
  issueInvoice,
  recordPayment,
  saveDraft,
  voidInvoice,
  voidPayment
} from '../src/main/services/invoices'
import { createExpense, voidExpense } from '../src/main/services/expenses'
import { createManualEntry, getEntry } from '../src/main/services/ledger'
import { balanceSheet, dashboard, fileGstReturn, gifiReport, gstReturn, incomeStatement, trialBalance, accountLedger } from '../src/main/services/reports'
import { importRows } from '../src/main/services/bankImport'
import { getSettings, updateSettings } from '../src/main/services/settings'
import { backupTo, listBackups, pruneBackups, validateDatabaseFile } from '../src/main/services/backup'
import { parseCsv, toCsv } from '../src/main/services/csv'
import { Db } from '../src/main/db/connection'
import { todayIso } from '../src/shared/dates'
import { acct, balanceOf, client, issued, makeDb, role } from './helpers'

describe('invoices', () => {
  it('keeps drafts out of the books and posts on issue', () => {
    const db = makeDb()
    const c = client(db)
    const d = saveDraft(db, {
      clientId: c,
      issueDate: '2026-02-01',
      dueDate: '2026-03-03',
      notes: 'Thanks',
      lines: [
        { description: 'Design work', qtyMilli: 10_500, unitPriceCents: 12000, taxable: true, accountId: role(db, 'sales') },
        { description: 'Exempt item', qtyMilli: 1000, unitPriceCents: 5000, taxable: false, accountId: acct(db, '4100') }
      ]
    })
    expect(d.number).toBeNull()
    expect(d.subtotalCents).toBe(126000 + 5000)
    expect(d.gstCents).toBe(6300) // 5% of the taxable $1,260 only
    expect(d.totalCents).toBe(137300)
    expect(trialBalance(db, '2026-12-31').rows).toHaveLength(0)

    const inv = issueInvoice(db, d.id)
    expect(inv.number).toBe('INV-1001')
    expect(inv.displayStatus).toBe('overdue') // due date is in the past relative to today
    expect(balanceOf(db, role(db, 'ar'))).toBe(137300)
    expect(balanceOf(db, role(db, 'sales'))).toBe(126000)
    expect(balanceOf(db, acct(db, '4100'))).toBe(5000)
    expect(balanceOf(db, role(db, 'gst_collected'))).toBe(6300)

    // Numbers are sequential.
    expect(issued(db, 1000).number).toBe('INV-1002')
    expect(getSettings(db).nextInvoiceNumber).toBe(1003)
  })

  it('makes issued invoices final, including at the database level', () => {
    const db = makeDb()
    const inv = issued(db, 10000)
    expect(() => saveDraft(db, { id: inv.id, clientId: inv.clientId, issueDate: inv.issueDate, dueDate: inv.dueDate, notes: '', lines: [{ description: 'x', qtyMilli: 1000, unitPriceCents: 1, taxable: true, accountId: role(db, 'sales') }] })).toThrow(/Only draft/)
    expect(() => deleteDraft(db, inv.id)).toThrow()
    expect(() => db.exec(`UPDATE invoices SET total = 1 WHERE id = ${inv.id}`)).toThrow(/cannot be edited/)
    expect(() => db.exec(`DELETE FROM invoice_lines WHERE invoice_id = ${inv.id}`)).toThrow(/cannot be edited/)
    expect(() => db.exec(`DELETE FROM invoices WHERE id = ${inv.id}`)).toThrow(/cannot be deleted/)
  })

  it('tracks partial and full payment, and rejects overpayment', () => {
    const db = makeDb()
    const today = todayIso()
    const inv = issued(db, 10000, today) // total $105.00, due today so not overdue
    const bank = role(db, 'bank')
    let r = recordPayment(db, { invoiceId: inv.id, date: today, amountCents: 5000, accountId: bank })
    expect(r.displayStatus).toBe('partial')
    expect(r.balanceCents).toBe(5500)
    expect(() => recordPayment(db, { invoiceId: inv.id, date: today, amountCents: 5501, accountId: bank })).toThrow(/more than the balance/)
    r = recordPayment(db, { invoiceId: inv.id, date: today, amountCents: 5500, accountId: bank })
    expect(r.displayStatus).toBe('paid')
    expect(balanceOf(db, role(db, 'ar'))).toBe(0)
    expect(balanceOf(db, bank)).toBe(10500)
  })

  it('voids payments and invoices with reversals, keeping the audit trail', () => {
    const db = makeDb()
    const inv = issued(db, 10000)
    const bank = role(db, 'bank')
    const paid = recordPayment(db, { invoiceId: inv.id, date: '2026-03-15', amountCents: 10500, accountId: bank })
    expect(() => voidInvoice(db, inv.id, '2026-03-20')).toThrow(/payments/)
    voidPayment(db, paid.payments[0].id, '2026-03-20')
    const v = voidInvoice(db, inv.id, '2026-03-20')
    expect(v.displayStatus).toBe('void')
    expect(balanceOf(db, role(db, 'ar'))).toBe(0)
    expect(balanceOf(db, role(db, 'sales'))).toBe(0)
    expect(balanceOf(db, bank)).toBe(0)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM journal_entries')!.n).toBe(4)
    expect(() => voidInvoice(db, inv.id, '2026-03-21')).toThrow()
  })

  it('refuses a zero-total invoice and income-only line accounts', () => {
    const db = makeDb()
    const c = client(db)
    const d = saveDraft(db, { clientId: c, issueDate: '2026-01-01', dueDate: '2026-01-01', notes: '', lines: [{ description: 'Free', qtyMilli: 1000, unitPriceCents: 0, taxable: true, accountId: role(db, 'sales') }] })
    expect(() => issueInvoice(db, d.id)).toThrow(/greater than zero/)
    expect(() => saveDraft(db, { clientId: c, issueDate: '2026-01-01', dueDate: '2026-01-01', notes: '', lines: [{ description: 'x', qtyMilli: 1000, unitPriceCents: 100, taxable: true, accountId: role(db, 'bank') }] })).toThrow(/cannot be used here/)
  })
})

describe('expenses', () => {
  it('posts the expense, the input tax credit and the payment source', () => {
    const db = makeDb()
    const office = acct(db, '5160')
    const x = createExpense(db, {
      date: '2026-02-10',
      vendor: 'Staples',
      description: 'Printer paper',
      accountId: office,
      amountCents: 4000,
      gstCents: 200,
      paidFromAccountId: role(db, 'shareholder_loan') // paid with personal card
    })
    expect(x.totalCents).toBe(4200)
    expect(balanceOf(db, office)).toBe(4000)
    expect(balanceOf(db, role(db, 'gst_itc'))).toBe(-200) // debit balance in a liability account
    expect(balanceOf(db, role(db, 'shareholder_loan'))).toBe(4200) // the company owes you
    voidExpense(db, x.id, '2026-02-11')
    expect(balanceOf(db, office)).toBe(0)
    expect(() => createExpense(db, { date: '2026-02-10', vendor: 'x', description: '', accountId: office, amountCents: 100, gstCents: 101, paidFromAccountId: role(db, 'bank') })).toThrow()
    expect(() => createExpense(db, { date: '2026-02-10', vendor: 'x', description: '', accountId: office, amountCents: 100, gstCents: 0, paidFromAccountId: role(db, 'sales') })).toThrow(/cannot be used here/)
  })
})

describe('reports', () => {
  function sampleYear(db: Db) {
    const bank = role(db, 'bank')
    createManualEntry(db, {
      date: '2025-12-01',
      memo: 'Shares issued',
      lines: [
        { accountId: bank, debitCents: 100, creditCents: 0, memo: '' },
        { accountId: role(db, 'share_capital'), debitCents: 0, creditCents: 100, memo: '' }
      ]
    })
    // Prior year: $1,000 revenue
    const old = issued(db, 100000, '2025-12-15')
    recordPayment(db, { invoiceId: old.id, date: '2025-12-20', amountCents: 105000, accountId: bank })
    // This year
    const inv = issued(db, 200000, '2026-02-01')
    recordPayment(db, { invoiceId: inv.id, date: '2026-02-20', amountCents: 100000, accountId: bank })
    createExpense(db, { date: '2026-02-05', vendor: 'Rogers', description: '', accountId: acct(db, '5210'), amountCents: 10000, gstCents: 500, paidFromAccountId: bank })
    createManualEntry(db, {
      date: '2026-03-01',
      memo: 'Dividend paid',
      lines: [
        { accountId: role(db, 'dividends'), debitCents: 30000, creditCents: 0, memo: '' },
        { accountId: bank, debitCents: 0, creditCents: 30000, memo: '' }
      ]
    })
  }

  it('produces a balanced balance sheet that rolls prior earnings into retained earnings', () => {
    const db = makeDb()
    sampleYear(db)
    const bs = balanceSheet(db, '2026-06-30')
    expect(bs.balanced).toBe(true)
    expect(bs.fiscalYearStart).toBe('2026-01-01')
    const re = bs.equity.find((r) => r.accountId === role(db, 'retained_earnings'))!
    expect(re.amountCents).toBe(100000)
    const ni = bs.equity.find((r) => r.accountId === 0)!
    expect(ni.amountCents).toBe(200000 - 10000)
    const div = bs.equity.find((r) => r.accountId === role(db, 'dividends'))!
    expect(div.amountCents).toBe(-30000)
    const tb = trialBalance(db, '2026-06-30')
    expect(tb.totalDebitCents).toBe(tb.totalCreditCents)
  })

  it('computes the income statement for a period', () => {
    const db = makeDb()
    sampleYear(db)
    const is = incomeStatement(db, '2026-01-01', '2026-12-31')
    expect(is.totalIncomeCents).toBe(200000)
    expect(is.totalExpensesCents).toBe(10000)
    expect(is.netIncomeCents).toBe(190000)
  })

  it('computes the GST return and filing locks the period', () => {
    const db = makeDb()
    sampleYear(db)
    const r = gstReturn(db, '2026-01-01', '2026-03-31')
    expect(r.line101).toBe(200000)
    expect(r.line105).toBe(10000)
    expect(r.line108).toBe(500)
    expect(r.line109).toBe(9500)

    const filed = fileGstReturn(db, '2026-01-01', '2026-03-31')
    expect(filed.filed).not.toBeNull()
    expect(filed.line109).toBe(9500) // the closing entry is excluded from the computation
    expect(getSettings(db).lockDate).toBe('2026-03-31')
    expect(balanceOf(db, role(db, 'gst_owing'))).toBe(9500)
    expect(() => fileGstReturn(db, '2026-01-01', '2026-03-31')).toThrow()
    expect(() => issued(db, 100, '2026-03-15')).toThrow(/locked period/)
    expect(balanceSheet(db, '2026-12-31').balanced).toBe(true)
  })

  it('builds GIFI schedules whose totals agree', () => {
    const db = makeDb()
    sampleYear(db)
    const g = gifiReport(db, '2026-12-31')
    const line = (lines: { gifiCode: string; amountCents: number }[], code: string) => lines.find((l) => l.gifiCode === code)?.amountCents
    expect(line(g.schedule100, '2599')).toBe(line(g.schedule100, '3640'))
    expect(line(g.schedule125, '8299')).toBe(200000)
    expect(line(g.schedule125, '9999')).toBe(190000)
    expect(line(g.schedule100, '3660')).toBe(100000)
    expect(line(g.schedule100, '3849')).toBe(100000 + 190000 - 30000)
    expect(g.unmapped).toEqual([])
  })

  it('shows a running balance in the account ledger', () => {
    const db = makeDb()
    sampleYear(db)
    const l = accountLedger(db, role(db, 'bank'), '2026-01-01', '2026-12-31')
    expect(l.openingBalanceCents).toBe(105100)
    expect(l.closingBalanceCents).toBe(105100 + 100000 - 10500 - 30000)
    expect(l.rows.at(-1)!.runningBalanceCents).toBe(l.closingBalanceCents)
  })

  it('builds the dashboard', () => {
    const db = makeDb()
    sampleYear(db)
    const d = dashboard(db, null)
    expect(d.monthly).toHaveLength(12)
    expect(d.cashCents).toBe(balanceOf(db, role(db, 'bank')) + balanceOf(db, acct(db, '1010')))
  })

  it('stays balanced under a long random sequence of operations', () => {
    const db = makeDb()
    let seed = 42
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    const bank = role(db, 'bank')
    const c = client(db)
    const open: number[] = []
    for (let i = 0; i < 300; i++) {
      const date = `2026-${String(1 + rand(12)).padStart(2, '0')}-${String(1 + rand(28)).padStart(2, '0')}`
      const op = rand(3)
      if (op === 0) open.push(issued(db, 1 + rand(500000), date, c).id)
      else if (op === 1 && open.length) {
        const inv = getInvoice(db, open[rand(open.length)])
        if (inv.balanceCents > 0) recordPayment(db, { invoiceId: inv.id, date, amountCents: 1 + rand(inv.balanceCents), accountId: bank })
      } else {
        const amountCents = 1 + rand(100000)
        createExpense(db, { date, vendor: 'v', description: '', accountId: acct(db, '5160'), amountCents, gstCents: rand(Math.min(5000, amountCents)), paidFromAccountId: bank })
      }
    }
    const tb = trialBalance(db, '2026-12-31')
    expect(tb.totalDebitCents).toBe(tb.totalCreditCents)
    expect(balanceSheet(db, '2026-12-31').balanced).toBe(true)
    const totalBalances = db.all<{ open: number }>(
      "SELECT i.total - COALESCE((SELECT SUM(amount) FROM payments p WHERE p.invoice_id = i.id AND p.void_entry_id IS NULL), 0) AS open FROM invoices i WHERE status = 'issued'"
    ).reduce((s, r) => s + r.open, 0)
    expect(balanceOf(db, role(db, 'ar'))).toBe(totalBalances)
  })
})

describe('bank import', () => {
  it('posts categorized rows, matches invoices, and skips duplicates on re-import', () => {
    const db = makeDb()
    const bank = role(db, 'bank')
    const inv = issued(db, 10000, '2026-04-01')
    const rows = [
      { date: '2026-04-05', description: 'COFFEE SHOP', amountCents: -525, target: { kind: 'account' as const, accountId: acct(db, '5110'), gstIncluded: true } },
      { date: '2026-04-05', description: 'COFFEE SHOP', amountCents: -525, target: { kind: 'account' as const, accountId: acct(db, '5110'), gstIncluded: true } },
      { date: '2026-04-06', description: 'E-TRANSFER ACME', amountCents: 10500, target: { kind: 'invoice' as const, invoiceId: inv.id } },
      { date: '2026-04-07', description: 'MONTHLY FEE', amountCents: -1595, target: { kind: 'account' as const, accountId: acct(db, '5120'), gstIncluded: false } }
    ]
    expect(importRows(db, bank, rows)).toEqual({ posted: 4, skippedDuplicates: 0 })
    // Two coffees, $5.00 + $0.25 GST each. Meals rule: half the GST back (13¢), the rest is cost.
    expect(balanceOf(db, acct(db, '5110'))).toBe(1024)
    expect(balanceOf(db, role(db, 'gst_itc'))).toBe(-26)
    expect(getInvoice(db, inv.id).displayStatus).toBe('paid')
    expect(balanceOf(db, bank)).toBe(10500 - 1050 - 1595)
    expect(importRows(db, bank, rows)).toEqual({ posted: 0, skippedDuplicates: 4 })
  })

  it('imports nothing if any row fails', () => {
    const db = makeDb()
    const bank = role(db, 'bank')
    const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM journal_entries')!.n
    expect(() =>
      importRows(db, bank, [
        { date: '2026-04-05', description: 'OK', amountCents: -100, target: { kind: 'account', accountId: acct(db, '5120'), gstIncluded: false } },
        { date: '2026-04-05', description: 'BAD', amountCents: -100, target: { kind: 'account', accountId: bank, gstIncluded: false } }
      ])
    ).toThrow(/Row 2/)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM journal_entries')!.n).toBe(before)
  })

  it('records deposits and transfers as journal entries', () => {
    const db = makeDb()
    const bank = role(db, 'bank')
    importRows(db, bank, [
      { date: '2026-04-05', description: 'OWNER TRANSFER IN', amountCents: 50000, target: { kind: 'account', accountId: role(db, 'shareholder_loan'), gstIncluded: false } }
    ])
    expect(balanceOf(db, role(db, 'shareholder_loan'))).toBe(50000)
    const e = getEntry(db, 1)
    expect(e.source).toBe('import')
  })
})

describe('backups', () => {
  it('backs up, validates, and prunes old copies', () => {
    const db = makeDb()
    issued(db, 12345)
    const dir = mkdtempSync(join(tmpdir(), 'books-bk-'))
    const path = backupTo(db, dir, new Date(2026, 0, 1, 9, 0, 0))
    validateDatabaseFile(path)
    const copy = new Db(path)
    expect(copy.get<{ n: number }>('SELECT COUNT(*) AS n FROM invoices')!.n).toBe(1)
    copy.close()
    for (let i = 0; i < 5; i++) backupTo(db, dir, new Date(2026, 0, 2 + i))
    pruneBackups(dir, 3)
    const left = listBackups(dir)
    expect(left).toHaveLength(3)
    expect(left[0].name).toContain('2026-01-06')
    const junk = join(dir, 'junk.db')
    writeFileSync(junk, 'not a database at all')
    expect(() => validateDatabaseFile(junk)).toThrow()
    expect(listBackups(dir)).toHaveLength(3) // never lists or prunes foreign files
  })
})

describe('csv', () => {
  it('parses quoted fields and line breaks', () => {
    expect(parseCsv('﻿Date,Desc,Amount\r\n2026-01-01,"Smith, J ""Jr""",-5.00\n"a\nb",x,1\n')).toEqual([
      ['Date', 'Desc', 'Amount'],
      ['2026-01-01', 'Smith, J "Jr"', '-5.00'],
      ['a\nb', 'x', '1']
    ])
  })

  it('neutralizes spreadsheet formulas in exported text', () => {
    const out = toCsv([['=HYPERLINK("http://evil")', 'ok', -5]])
    expect(out).toContain(`"'=HYPERLINK(""http://evil"")"`)
    expect(out).toContain(',-5')
  })
})

describe('settings', () => {
  it('stores and clears values', () => {
    const db = makeDb()
    updateSettings(db, { companyName: 'Chabsun Consulting Ltd.', lockDate: '2026-01-31' })
    expect(getSettings(db).companyName).toBe('Chabsun Consulting Ltd.')
    updateSettings(db, { lockDate: null })
    expect(getSettings(db).lockDate).toBeNull()
  })
})
