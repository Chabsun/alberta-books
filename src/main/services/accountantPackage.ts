/**
 * Year-end package for your accountant, whatever software they use.
 *
 *   README.txt                        what's inside and how to import it
 *   01 Financial statements.pdf       balance sheet, income statement, tax adjustments
 *   02 Workbook.xlsx                  every schedule on its own sheet (Excel, Numbers, Google Sheets)
 *   csv/                              each sheet as CSV
 *   import/                           ready-to-import files:
 *     trial_balance_with_GIFI.csv       TaxCycle, Taxprep, CaseWare, Profile, Cantax (trial balance import)
 *     GIFI_schedule_100.csv / _125.csv  GIFI code + amount for T2 software
 *     journal_generic.csv               any accounting software (one row per journal line)
 *     quickbooks_online_journal.csv     QuickBooks Online "Import journal entries"
 *     xero_manual_journals.csv          Xero "Import manual journals"
 *   receipts/                         every receipt, named by date, vendor and amount
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../db/connection'
import { centsToPlain, formatMoney } from '../../shared/money'
import { fiscalYearOf, todayIso } from '../../shared/dates'
import { taxRule } from '../../shared/taxRules'
import { listAccounts } from './accounts'
import { listAssets, ccaSchedule } from './cca'
import { toCsv } from './csv'
import { listExpenses } from './expenses'
import { listInvoices } from './invoices'
import { findIssues } from './issues'
import { listEntriesBetween } from './ledger'
import { accountLedger, balanceSheet, gifiReport, gstReturn, incomeStatement, trialBalance } from './reports'
import { getSettings } from './settings'
import { taxAdjustments } from './taxAdjustments'
import { listTrips, listVehicles, vehicleBenefit, vehicleLimits } from './vehicles'
import { makeZip, writeXlsx, type Cell, type Sheet } from './xlsx'

const $ = (cents: number) => Number(centsToPlain(cents))

/** All schedules for the fiscal year ending `fiscalYearEnd`, as sheets. */
export function packageSheets(db: Db, fiscalYearEnd: string): Sheet[] {
  const s = getSettings(db)
  const fy = fiscalYearOf(fiscalYearEnd, s.fiscalYearEndMonth)
  const title = (t: string) => [s.companyName, t]
  const sheets: Sheet[] = []

  // Balance sheet
  const bs = balanceSheet(db, fy.end)
  const bsRows: Cell[][] = []
  const bsBold: number[] = []
  const section = (name: string, rows: typeof bs.assets, total: number) => {
    bsRows.push([name.toUpperCase(), '', '', null])
    for (const r of rows) bsRows.push([r.code, r.name, r.gifiCode ?? '', $(r.amountCents)])
    bsBold.push(bsRows.length)
    bsRows.push(['', `Total ${name.toLowerCase()}`, '', $(total)])
  }
  section('Assets', bs.assets, bs.totalAssetsCents)
  section('Liabilities', bs.liabilities, bs.totalLiabilitiesCents)
  section('Equity', bs.equity, bs.totalEquityCents)
  bsBold.push(bsRows.length)
  bsRows.push(['', 'Total liabilities and equity', '', $(bs.totalLiabilitiesCents + bs.totalEquityCents)])
  sheets.push({ name: 'Balance sheet', title: title(`Balance sheet as of ${fy.end}`), header: ['Code', 'Account', 'GIFI', 'Amount'], rows: bsRows, moneyColumns: [3], boldRows: bsBold })

  // Income statement
  const is = incomeStatement(db, fy.start, fy.end)
  const isRows: Cell[][] = [['INCOME', '', '', null], ...is.income.map((r) => [r.code, r.name, r.gifiCode ?? '', $(r.amountCents)])]
  const isBold: number[] = [isRows.length]
  isRows.push(['', 'Total income', '', $(is.totalIncomeCents)], ['EXPENSES', '', '', null], ...is.expenses.map((r) => [r.code, r.name, r.gifiCode ?? '', $(r.amountCents)]))
  isBold.push(isRows.length)
  isRows.push(['', 'Total expenses', '', $(is.totalExpensesCents)])
  isBold.push(isRows.length)
  isRows.push(['', 'Net income', '', $(is.netIncomeCents)])
  sheets.push({ name: 'Income statement', title: title(`Income statement ${fy.start} to ${fy.end}`), header: ['Code', 'Account', 'GIFI', 'Amount'], rows: isRows, moneyColumns: [3], boldRows: isBold })

  // Trial balance
  const tb = trialBalance(db, fy.end)
  const gifiById = new Map(listAccounts(db, true).map((a) => [a.id, a.gifiCode ?? '']))
  sheets.push({
    name: 'Trial balance',
    title: title(`Trial balance as of ${fy.end}`),
    header: ['Code', 'Account', 'Type', 'GIFI', 'Debit', 'Credit'],
    rows: [...tb.rows.map((r) => [r.code, r.name, r.type, gifiById.get(r.accountId) ?? '', r.debitCents ? $(r.debitCents) : null, r.creditCents ? $(r.creditCents) : null]), ['', 'Total', '', '', $(tb.totalDebitCents), $(tb.totalCreditCents)]],
    moneyColumns: [4, 5],
    boldRows: [tb.rows.length]
  })

  // Tax adjustments (Schedule 1 estimate)
  const ta = taxAdjustments(db, fy.end)
  const taRows: Cell[][] = [['Net income per books', $(ta.netIncomeBooksCents), '']]
  for (const a of ta.addBacks) taRows.push([`Add: ${a.label}`, $(a.amountCents), a.note ?? ''])
  for (const d of ta.deductions) taRows.push([`Deduct: ${d.label}`, -$(d.amountCents), d.note ?? ''])
  taRows.push(['Net income for tax purposes (estimate)', $(ta.netIncomeForTaxCents), ''])
  sheets.push({ name: 'Tax adjustments', title: title(`Tax adjustments (Schedule 1 estimate) ${fy.start} to ${fy.end}`), header: ['Item', 'Amount', 'Note'], rows: taRows, moneyColumns: [1], boldRows: [0, taRows.length - 1] })

  // CCA
  const cca = ccaSchedule(db, fy.end)
  sheets.push({
    name: 'CCA Schedule 8',
    title: title(`Capital cost allowance (Schedule 8) ${fy.start} to ${fy.end}`),
    header: ['Class', 'Description', 'Rate %', 'Opening UCC', 'Additions', 'Disposals', 'First-year adjustment', 'CCA', 'Recapture', 'Terminal loss', 'Closing UCC'],
    rows: cca.rows.map((r) => [r.ccaClass, r.label, r.ratePct, $(r.openingUccCents), $(r.additionsCents), $(r.disposalsCents), $(r.incentiveAdjustmentCents), $(r.ccaCents), $(r.recaptureCents), $(r.terminalLossCents), $(r.closingUccCents)]),
    moneyColumns: [3, 4, 5, 6, 7, 8, 9, 10]
  })
  sheets.push({
    name: 'Fixed assets',
    title: title('Fixed asset register'),
    header: ['Description', 'CCA class', 'Capital cost', 'Acquired', 'Available for use', 'Disposed', 'Proceeds'],
    rows: listAssets(db).map((a) => [a.description, a.ccaClass === '12T' ? '12' : a.ccaClass, $(a.costCents), a.acquiredDate, a.availableDate, a.disposedDate ?? '', a.proceedsCents !== null ? $(a.proceedsCents) : null]),
    moneyColumns: [2, 6]
  })

  // GIFI
  const g = gifiReport(db, fy.end)
  sheets.push({ name: 'GIFI Schedule 100', title: title(`GIFI Schedule 100 (balance sheet) as of ${fy.end}`), header: ['GIFI code', 'Description', 'Amount'], rows: g.schedule100.map((l) => [l.gifiCode, l.description, $(l.amountCents)]), moneyColumns: [2] })
  sheets.push({ name: 'GIFI Schedule 125', title: title(`GIFI Schedule 125 (income statement) ${fy.start} to ${fy.end}`), header: ['GIFI code', 'Description', 'Amount'], rows: g.schedule125.map((l) => [l.gifiCode, l.description, $(l.amountCents)]), moneyColumns: [2] })

  // GST: one line per calendar quarter of the fiscal year, plus the year
  const gstRows: Cell[][] = []
  let qStart = fy.start
  while (qStart <= fy.end) {
    const [y, m] = qStart.split('-').map(Number)
    const endMonth = new Date(Date.UTC(y, m - 1 + 3, 0))
    let qEnd = `${endMonth.getUTCFullYear()}-${String(endMonth.getUTCMonth() + 1).padStart(2, '0')}-${String(endMonth.getUTCDate()).padStart(2, '0')}`
    if (qEnd > fy.end) qEnd = fy.end
    const r = gstReturn(db, qStart, qEnd)
    gstRows.push([`${qStart} to ${qEnd}`, $(r.line101), $(r.line103), $(r.line104), $(r.line105), $(r.line108), $(r.line109), r.filed ? 'Filed' : ''])
    const next = new Date(Date.UTC(y, m - 1 + 3, 1))
    qStart = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01`
  }
  const yr = gstReturn(db, fy.start, fy.end)
  gstRows.push(['Fiscal year', $(yr.line101), $(yr.line103), $(yr.line104), $(yr.line105), $(yr.line108), $(yr.line109), ''])
  sheets.push({ name: 'GST', title: title('GST/HST return lines by quarter'), header: ['Period', 'Line 101 Sales', 'Line 103 GST collected', 'Line 104 Adjustments', 'Line 105 Total GST', 'Line 108 ITCs', 'Line 109 Net tax', 'Status'], rows: gstRows, moneyColumns: [1, 2, 3, 4, 5, 6], boldRows: [gstRows.length - 1] })

  // Expenses register with CRA treatment
  const receiptNames = new Map<number, string[]>()
  for (const r of db.all<{ expense_id: number; file_name: string }>('SELECT expense_id, file_name FROM receipts WHERE expense_id IS NOT NULL')) {
    receiptNames.set(r.expense_id, [...(receiptNames.get(r.expense_id) ?? []), r.file_name])
  }
  const expenses = listExpenses(db).filter((x) => x.date >= fy.start && x.date <= fy.end && !x.voided)
  sheets.push({
    name: 'Expenses',
    title: title(`Expenses ${fy.start} to ${fy.end}`),
    header: ['Date', 'Vendor', 'Description', 'Category', 'CRA rule', 'Before GST', 'GST paid', 'GST claimed (ITC)', 'Business %', 'Not deductible', 'Supplier GST no.', 'Purpose', 'Attendees', 'Paid from', 'Receipts', 'Missing'],
    rows: expenses.map((x) => [x.date, x.vendor, x.description, x.accountName, taxRule(x.taxRule).label, $(x.amountCents), $(x.gstCents), $(x.itcCents), x.businessPct, $(x.nonDeductibleCents), x.supplierGstNumber, x.purpose, x.attendees, x.paidFromName, (receiptNames.get(x.id) ?? []).join('; '), x.warnings.join(' ')]),
    moneyColumns: [5, 6, 7, 9]
  })

  // Shareholder loan and dividends
  const accounts = listAccounts(db, true)
  for (const roleName of ['shareholder_loan', 'dividends'] as const) {
    const acc = accounts.find((a) => a.role === roleName)
    if (!acc) continue
    const led = accountLedger(db, acc.id, fy.start, fy.end)
    sheets.push({
      name: roleName === 'shareholder_loan' ? 'Shareholder loan' : 'Dividends',
      title: title(`${acc.name}: ${fy.start} to ${fy.end}`),
      header: ['Date', 'Description', 'Debit', 'Credit', 'Balance'],
      rows: [['', 'Opening balance', null, null, $(led.openingBalanceCents)], ...led.rows.map((r) => [r.date, r.memo, r.debitCents ? $(r.debitCents) : null, r.creditCents ? $(r.creditCents) : null, $(r.runningBalanceCents)])],
      moneyColumns: [2, 3, 4]
    })
  }

  // Company vehicles: logbook, benefit, limits
  for (const v of listVehicles(db)) {
    const years = [...new Set([Number(fy.start.slice(0, 4)), Number(fy.end.slice(0, 4))])]
    const rows: Cell[][] = []
    for (const y of years) {
      const b = vehicleBenefit(db, v.id, y)
      rows.push([`Calendar ${y}: business km`, b.businessKm], [`Calendar ${y}: personal km`, b.personalKm], [`Calendar ${y}: business use %`, b.businessUsePct], [`Calendar ${y}: standby charge (benefit)`, $(b.standbyChargeCents)], [`Calendar ${y}: operating cost benefit`, $(b.operatingBenefitCents)], [`Calendar ${y}: GST to remit on benefit`, $(b.gstToRemitCents)])
    }
    const lim = vehicleLimits(db, v.id, fy.end)
    rows.push(['Fiscal year: lease cost', $(lim.leaseCostCents)], ['Fiscal year: lease deductible (CRA cap)', $(lim.leaseDeductibleCents)], ['Fiscal year: lease excess added back', $(lim.leaseExcessCents)], ['Fiscal year: loan interest', $(lim.interestCostCents)], ['Fiscal year: interest over cap added back', $(lim.interestExcessCents)])
    sheets.push({ name: `Vehicle ${v.name}`, title: title(`Company vehicle: ${v.name} (${v.ownership})`), header: ['Item', 'Value'], rows })
    sheets.push({
      name: `Logbook ${v.name}`,
      title: title(`Logbook: ${v.name}, ${fy.start} to ${fy.end}`),
      header: ['Date', 'Kilometres', 'Business or personal', 'Purpose', 'Route'],
      rows: listTrips(db, v.id, fy.start, fy.end).map((t) => [t.date, t.km, t.kind, t.purpose, t.route])
    })
  }

  // Invoices
  const invoices = listInvoices(db).filter((i) => i.status !== 'draft' && i.issueDate <= fy.end)
  sheets.push({
    name: 'Invoices',
    title: title(`Invoices to ${fy.end}`),
    header: ['Number', 'Client', 'Date', 'Due', 'Status', 'Subtotal', 'GST', 'Total', 'Paid', 'Balance'],
    rows: invoices.map((i) => [i.number, i.clientName, i.issueDate, i.dueDate, i.displayStatus, $(i.subtotalCents), $(i.gstCents), $(i.totalCents), $(i.paidCents), $(i.balanceCents)]),
    moneyColumns: [5, 6, 7, 8, 9]
  })

  // Journal: every line of the fiscal year
  const entries = listEntriesBetween(db, fy.start, fy.end)
  sheets.push({
    name: 'Journal',
    title: title(`General journal ${fy.start} to ${fy.end}`),
    header: ['Entry', 'Date', 'Description', 'Source', 'Recorded by', 'Account code', 'Account', 'Debit', 'Credit', 'Line memo'],
    rows: entries.flatMap((e) => e.lines.map((l) => [e.id, e.date, e.memo, e.source, e.actor, l.accountCode, l.accountName, l.debitCents ? $(l.debitCents) : null, l.creditCents ? $(l.creditCents) : null, l.memo])),
    moneyColumns: [7, 8]
  })

  // Chart of accounts
  sheets.push({
    name: 'Chart of accounts',
    title: title('Chart of accounts with GIFI codes and CRA rules'),
    header: ['Code', 'Account', 'Type', 'GIFI', 'CRA rule', 'Archived'],
    rows: accounts.map((a) => [a.code, a.name, a.type, a.gifiCode ?? '', a.taxRule ? taxRule(a.taxRule).label : '', a.archived ? 'yes' : ''])
  })

  const issues = findIssues(db, fy.end < todayIso() ? fy.end : todayIso())
  sheets.push({ name: 'Open items', title: title('Items flagged by the bookkeeping app'), header: ['Severity', 'Item'], rows: issues.map((i) => [i.severity, i.message]) })
  return sheets
}

/** Files your accountant can import directly into their software. */
export function importFiles(db: Db, fiscalYearEnd: string): Record<string, string> {
  const s = getSettings(db)
  const fy = fiscalYearOf(fiscalYearEnd, s.fiscalYearEndMonth)
  const accounts = listAccounts(db, true)
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const tb = trialBalance(db, fy.end)
  const g = gifiReport(db, fy.end)
  const entries = listEntriesBetween(db, fy.start, fy.end)
  const usDate = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`
  const money = (c: number) => centsToPlain(c)
  return {
    'trial_balance_with_GIFI.csv': toCsv([
      ['Account number', 'Account description', 'GIFI code', 'Debit', 'Credit'],
      ...tb.rows.map((r) => [r.code, r.name, byId.get(r.accountId)?.gifiCode ?? '', r.debitCents ? money(r.debitCents) : '', r.creditCents ? money(r.creditCents) : ''])
    ]),
    'GIFI_schedule_100.csv': toCsv([['GIFI code', 'Amount'], ...g.schedule100.map((l) => [l.gifiCode, money(l.amountCents)])]),
    'GIFI_schedule_125.csv': toCsv([['GIFI code', 'Amount'], ...g.schedule125.map((l) => [l.gifiCode, money(l.amountCents)])]),
    'journal_generic.csv': toCsv([
      ['Date', 'Entry number', 'Account code', 'Account name', 'Debit', 'Credit', 'Description'],
      ...entries.flatMap((e) => e.lines.map((l) => [e.date, String(e.id), l.accountCode, l.accountName, l.debitCents ? money(l.debitCents) : '', l.creditCents ? money(l.creditCents) : '', l.memo || e.memo]))
    ]),
    'quickbooks_online_journal.csv': toCsv([
      ['JournalNo', 'JournalDate', 'AccountName', 'Debits', 'Credits', 'Description', 'Memo'],
      ...entries.flatMap((e) => e.lines.map((l) => [String(e.id), usDate(e.date), l.accountName, l.debitCents ? money(l.debitCents) : '', l.creditCents ? money(l.creditCents) : '', l.memo || e.memo, e.memo]))
    ]),
    'xero_manual_journals.csv': toCsv([
      ['*Narration', '*Date', 'Description', '*AccountCode', '*TaxRate', '*Amount'],
      ...entries.flatMap((e) => e.lines.map((l) => [`#${e.id} ${e.memo}`, e.date, l.memo || e.memo, l.accountCode, 'Tax Exempt', money(l.debitCents - l.creditCents)]))
    ])
  }
}

function readme(db: Db, fiscalYearEnd: string, receiptCount: number): string {
  const s = getSettings(db)
  const fy = fiscalYearOf(fiscalYearEnd, s.fiscalYearEndMonth)
  const issues = findIssues(db, fy.end < todayIso() ? fy.end : todayIso())
  const bs = balanceSheet(db, fy.end)
  return [
    `${s.companyName}: accountant package`,
    `Fiscal year: ${fy.start} to ${fy.end}`,
    `Prepared: ${new Date().toISOString().slice(0, 10)} with Alberta Books`,
    `GST registration: ${s.gstNumber || '(not set)'}`,
    `Balance sheet balances: ${bs.balanced ? 'yes' : 'NO, please check'}`,
    '',
    'CONTENTS',
    '  01 Financial statements.pdf   Balance sheet, income statement and tax adjustments',
    '  02 Workbook.xlsx              Every schedule on its own sheet',
    '  csv/                          Each sheet as a CSV file',
    '  import/                       Files to import into other software:',
    '    trial_balance_with_GIFI.csv      Trial balance import (TaxCycle, Taxprep, CaseWare, Profile, Cantax)',
    '    GIFI_schedule_100.csv, _125.csv  GIFI code and amount for the T2',
    '    journal_generic.csv              Every journal line, for any accounting software',
    '    quickbooks_online_journal.csv    QuickBooks Online: Settings > Import data > Journal entries',
    '    xero_manual_journals.csv         Xero: Accounting > Manual journals > Import (set tax rates as needed)',
    `  receipts/                     ${receiptCount} receipt file(s), named by date, vendor and amount`,
    '',
    'NOTES',
    '  - Amounts are in Canadian dollars. GST only (Alberta, no PST).',
    '  - Meals and entertainment are recorded with 50% of the GST claimed; the other 50% is part of the cost.',
    '  - "Tax adjustments" is the bookkeeping estimate of Schedule 1; CCA follows the reinstated',
    '    Accelerated Investment Incentive (Bill C-15). Please confirm both.',
    '  - The company vehicle sheets show the shareholder standby charge and operating benefit by calendar year.',
    '  - GIFI codes were assigned by the bookkeeping app; please confirm the mapping.',
    '',
    'ITEMS FLAGGED BY THE APP',
    ...(issues.length ? issues.map((i) => `  [${i.severity}] ${i.message}`) : ['  none']),
    ''
  ].join('\r\n')
}

/** Statement HTML for the PDF (rendered by the main process with JavaScript off). */
export function statementsHtml(db: Db, fiscalYearEnd: string): string {
  const s = getSettings(db)
  const fy = fiscalYearOf(fiscalYearEnd, s.fiscalYearEndMonth)
  const bs = balanceSheet(db, fy.end)
  const is = incomeStatement(db, fy.start, fy.end)
  const ta = taxAdjustments(db, fy.end)
  const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
  const rows = (list: { name: string; amountCents: number }[]) => list.map((r) => `<tr><td>${esc(r.name)}</td><td class="n">${formatMoney(r.amountCents)}</td></tr>`).join('')
  const total = (label: string, cents: number) => `<tr class="t"><td>${esc(label)}</td><td class="n">${formatMoney(cents)}</td></tr>`
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
 @page { size: Letter; margin: 18mm 16mm; }
 body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #18181b; font-size: 10pt; }
 h1 { font-size: 15pt; margin: 0 0 2px; } h2 { font-size: 12pt; margin: 22px 0 6px; border-bottom: 1.5px solid #18181b; padding-bottom: 4px; }
 .sub { color: #71717a; font-size: 9pt; margin-bottom: 10px; }
 table { width: 100%; border-collapse: collapse; } td { padding: 4px 2px; border-bottom: 1px solid #e4e4e7; }
 .n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; } .t td { font-weight: 700; border-bottom: 1.5px solid #18181b; }
 .h td { font-weight: 600; color: #52525b; padding-top: 10px; border-bottom: none; }
 .page { page-break-after: always; } .note { color: #71717a; font-size: 8.5pt; margin-top: 8px; }
</style></head><body>
<div class="page">
<h1>${esc(s.companyName)}</h1><div class="sub">Balance sheet as of ${fy.end} · Prepared from the books, unaudited</div>
<h2>Assets</h2><table>${rows(bs.assets)}${total('Total assets', bs.totalAssetsCents)}</table>
<h2>Liabilities</h2><table>${rows(bs.liabilities)}${total('Total liabilities', bs.totalLiabilitiesCents)}</table>
<h2>Shareholder’s equity</h2><table>${rows(bs.equity)}${total('Total equity', bs.totalEquityCents)}${total('Total liabilities and equity', bs.totalLiabilitiesCents + bs.totalEquityCents)}</table>
</div>
<div class="page">
<h1>${esc(s.companyName)}</h1><div class="sub">Income statement, ${fy.start} to ${fy.end}</div>
<h2>Income</h2><table>${rows(is.income)}${total('Total income', is.totalIncomeCents)}</table>
<h2>Expenses</h2><table>${rows(is.expenses)}${total('Total expenses', is.totalExpensesCents)}</table>
<table>${total(is.netIncomeCents >= 0 ? 'Net income' : 'Net loss', is.netIncomeCents)}</table>
</div>
<div>
<h1>${esc(s.companyName)}</h1><div class="sub">Tax adjustments (Schedule 1 estimate), ${fy.start} to ${fy.end}</div>
<table><tr class="h"><td>Net income per books</td><td class="n">${formatMoney(ta.netIncomeBooksCents)}</td></tr>
${ta.addBacks.map((a) => `<tr><td>Add: ${esc(a.label)}</td><td class="n">${formatMoney(a.amountCents)}</td></tr>`).join('')}
${ta.deductions.map((d) => `<tr><td>Deduct: ${esc(d.label)}</td><td class="n">(${formatMoney(d.amountCents)})</td></tr>`).join('')}
${total('Net income for tax purposes (estimate)', ta.netIncomeForTaxCents)}</table>
<div class="note">${ta.notes.map(esc).join(' ')}</div>
</div>
</body></html>`
}

/** Builds the whole package as a zip. `renderPdf` turns HTML into PDF bytes. */
export async function buildAccountantPackage(
  db: Db,
  receiptsDir: string,
  fiscalYearEnd: string,
  renderPdf: (html: string) => Promise<Uint8Array>
): Promise<{ zip: Uint8Array; fileName: string; receipts: number }> {
  const s = getSettings(db)
  const fy = fiscalYearOf(fiscalYearEnd, s.fiscalYearEndMonth)
  const sheets = packageSheets(db, fy.end)
  const files: Record<string, Uint8Array | string> = {}
  files['01 Financial statements.pdf'] = await renderPdf(statementsHtml(db, fy.end))
  files['02 Workbook.xlsx'] = writeXlsx(sheets)
  for (const sh of sheets) {
    files[`csv/${sh.name.replace(/[^\w\- ]+/g, '').trim()}.csv`] = toCsv([sh.header, ...sh.rows.map((r) => r.map((c) => (c === null ? '' : c)))])
  }
  for (const [name, content] of Object.entries(importFiles(db, fy.end))) files[`import/${name}`] = content

  const receipts = db.all<{ id: number; stored_name: string; file_name: string; date: string | null; vendor: string | null; total: number | null }>(
    `SELECT r.id, r.stored_name, r.file_name,
            COALESCE(x.date, b.date) AS date, COALESCE(x.vendor, b.payee, b.description) AS vendor,
            COALESCE(x.amount + x.gst, ABS(b.amount)) AS total
     FROM receipts r
     LEFT JOIN expenses x ON x.id = r.expense_id
     LEFT JOIN bank_transactions b ON b.id = r.bank_transaction_id
     WHERE COALESCE(x.date, b.date, substr(r.created_at, 1, 10)) BETWEEN ? AND ?`,
    fy.start,
    fy.end
  )
  let count = 0
  for (const r of receipts) {
    const path = join(receiptsDir, r.stored_name)
    if (!/^[0-9a-f]{64}\.\w+$/.test(r.stored_name) || !existsSync(path)) continue
    const ext = r.stored_name.split('.').pop()
    const label = r.date ? `${r.date} ${r.vendor ?? ''} ${r.total !== null ? centsToPlain(r.total) : ''}` : r.file_name.replace(/\.\w+$/, '')
    files[`receipts/${label.replace(/[\\/:*?"<>|]/g, '-').trim()} (receipt ${r.id}).${ext}`] = new Uint8Array(readFileSync(path))
    count++
  }
  files['README.txt'] = readme(db, fy.end, count)
  const safe = s.companyName.replace(/[\\/:*?"<>|]/g, '-')
  return { zip: makeZip(files), fileName: `${safe} – accountant package FY ${fy.end}.zip`, receipts: count }
}
