/**
 * End-to-end smoke run: launches the built app with a throwaway data folder,
 * fills it with a realistic year through the real IPC bridge, visits every
 * screen and saves screenshots (light and dark) to e2e/screenshots.
 *
 *   npm run build && node e2e/screens.mjs
 *
 * Fails if any screen shows an error or the console reports one.
 */
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'
import { unzipSync, strFromU8 } from 'fflate'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shots = join(root, 'e2e', 'screenshots')
mkdirSync(shots, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'alberta-books-e2e-'))

const app = await electron.launch({
  args: [join(root, 'out/main/index.js'), ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])],
  env: { ...process.env, ALBERTA_BOOKS_DATA_DIR: dataDir, ...(process.getuid?.() === 0 ? { ALBERTA_BOOKS_TEST_ROOT: '1' } : {}) },
  cwd: root
})
const page = await app.firstWindow()
const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(String(e)))
await page.setViewportSize({ width: 1360, height: 880 })
await page.waitForSelector('text=Overview')

const rpc = (method, input) =>
  page.evaluate(
    async ([m, i]) => {
      const r = await window.books.call(m, i)
      if (!r.ok) throw new Error(`${m}: ${r.error}`)
      return r.data
    },
    [method, input]
  )

// The bridge rejects unknown operations and bad input.
const unknown = await page.evaluate(() => window.books.call('db.exec', 'DROP TABLE accounts'))
if (unknown.ok) throw new Error('Unknown operation was accepted')
const bad = await page.evaluate(() => window.books.call('expenses.create', { date: 'nope' }))
if (bad.ok) throw new Error('Invalid input was accepted')
const noNode = await page.evaluate(() => typeof window.require === 'undefined' && typeof window.process === 'undefined')
if (!noNode) throw new Error('Node.js is exposed to the page')

// ---- seed a realistic year ------------------------------------------------
const y = new Date().getFullYear()
const pad = (n) => String(n).padStart(2, '0')
const today = `${y}-${pad(new Date().getMonth() + 1)}-${pad(new Date().getDate())}`
const thisMonth = new Date().getMonth() + 1
const d = (m, day) => `${y}-${pad(m)}-${pad(day)}`

await rpc('settings.update', {
  companyName: 'Chabsun Consulting Ltd.',
  gstNumber: '123456789 RT0001',
  address: '400 – 330 5 Ave SW\nCalgary, AB  T2P 0L4',
  email: 'billing@chabsun.ca',
  phone: '403-555-0142',
  fiscalYearEndMonth: 8
})
const accounts = await rpc('accounts.list')
const acc = (code) => accounts.find((a) => a.code === code).id
const role = (r) => accounts.find((a) => a.role === r).id

await rpc('journal.create', {
  date: d(1, 2),
  memo: 'Opening balance',
  lines: [
    { accountId: role('bank'), debitCents: 1850000, creditCents: 0, memo: '' },
    { accountId: role('retained_earnings'), debitCents: 0, creditCents: 1850000, memo: '' }
  ]
})

const clients = []
for (const [name, email] of [
  ['Prairie Pipeline Engineering', 'ap@prairiepipe.ca'],
  ['Bow River Analytics Inc.', 'accounts@bowriver.io'],
  ['Chinook Health Services', 'finance@chinookhealth.ca']
]) {
  clients.push(await rpc('clients.save', { name, email, phone: '', address: 'Calgary, AB' }))
}

const months = Math.max(1, thisMonth)
for (let m = 1; m <= months; m++) {
  const client = clients[m % 3]
  const hours = 40 + ((m * 7) % 25)
  const draft = await rpc('invoices.saveDraft', {
    clientId: client.id,
    issueDate: d(m, 1),
    dueDate: d(m, 28),
    notes: 'Payment by e-Transfer to billing@chabsun.ca. Thank you!',
    lines: [
      { description: `Data engineering consulting – ${m}/${y}`, qtyMilli: hours * 1000, unitPriceCents: 14500, taxable: true, accountId: role('sales') },
      { description: 'Cloud hosting pass-through', qtyMilli: 1000, unitPriceCents: 21000 + m * 500, taxable: true, accountId: role('sales') }
    ]
  })
  const inv = await rpc('invoices.issue', { id: draft.id })
  if (m < months - 1) await rpc('invoices.recordPayment', { invoiceId: inv.id, date: d(m, 20), amountCents: inv.totalCents, accountId: role('bank') })
  else if (m === months - 1) await rpc('invoices.recordPayment', { invoiceId: inv.id, date: d(m, 25), amountCents: Math.round(inv.totalCents / 2), accountId: role('bank') })

  await rpc('expenses.create', { date: d(m, 5), vendor: 'Telus', description: 'Mobile and internet', accountId: acc('5210'), amountCents: 14500, gstCents: 725, paidFromAccountId: role('bank') })
  await rpc('expenses.create', { date: d(m, 9), vendor: 'Amazon Web Services', description: '', accountId: acc('5200'), amountCents: 19000 + m * 450, gstCents: 950 + m * 22, paidFromAccountId: acc('2100') })
  if (m % 3 === 0) await rpc('expenses.create', { date: d(m, 14), vendor: 'WestJet', description: 'Client visit – Edmonton', accountId: acc('5220'), amountCents: 42000, gstCents: 2100, paidFromAccountId: role('shareholder_loan') })
  if (m % 2 === 0) await rpc('expenses.create', { date: d(m, 18), vendor: 'Monogram Coffee', description: 'Client meeting', accountId: acc('5110'), amountCents: 3800, gstCents: 190, paidFromAccountId: acc('2100') })
}
// CRA rules: a laptop is a capital asset, meals need purpose and attendees, a leased company car.
await rpc('expenses.create', { date: d(1, 20), vendor: 'Apple Store', description: 'MacBook Pro', accountId: acc('1500'), amountCents: 289900, gstCents: 14495, paidFromAccountId: acc('2100') })
await rpc('expenses.create', {
  date: d(Math.max(1, thisMonth - 1), 12),
  vendor: 'Ruth’s Chris',
  description: '',
  accountId: acc('5110'),
  amountCents: 31000,
  gstCents: 1550,
  paidFromAccountId: acc('2100'),
  supplierGstNumber: '987654321 RT0001',
  purpose: 'Contract renewal',
  attendees: 'K. Chen (Prairie Pipeline)'
})
const car = await rpc('vehicles.save', { name: '2025 Toyota RAV4 Hybrid', ownership: 'leased', startDate: d(1, 1), monthlyLeaseCents: 68000, msrpCents: 4250000 })
for (let m = 1; m <= months; m++) {
  await rpc('expenses.create', { date: d(m, 3), vendor: 'Toyota Financial', description: 'Lease', accountId: acc('5233'), amountCents: 68000, gstCents: 3400, paidFromAccountId: role('bank'), vehicleId: car.id })
  await rpc('vehicles.addTrip', { vehicleId: car.id, date: d(m, 28), km: 1400, kind: 'business', purpose: 'Client sites (monthly total)', route: 'Calgary area' })
  await rpc('vehicles.addTrip', { vehicleId: car.id, date: d(m, 28), km: 350, kind: 'personal' })
}
await rpc('journal.create', {
  date: d(Math.max(1, thisMonth - 1), 15),
  memo: 'Dividend paid',
  lines: [
    { accountId: role('dividends'), debitCents: 1500000, creditCents: 0, memo: '' },
    { accountId: role('bank'), debitCents: 0, creditCents: 1500000, memo: '' }
  ]
})
await rpc('invoices.saveDraft', {
  clientId: clients[1].id,
  issueDate: today,
  dueDate: today,
  notes: '',
  lines: [{ description: 'Dashboard prototype – phase 2', qtyMilli: 12000, unitPriceCents: 14500, taxable: true, accountId: role('sales') }]
})

const bs = await rpc('reports.balanceSheet', { asOf: today })
if (!bs.balanced) throw new Error('Balance sheet does not balance')
const tb = await rpc('reports.trialBalance', { asOf: today })
if (tb.totalDebitCents !== tb.totalCreditCents) throw new Error('Trial balance does not balance')

// Seeding went straight through the bridge, so reload to show it.
await page.reload()
await page.waitForSelector('text=Overview')

// ---- visit every screen ------------------------------------------------------
const screens = [
  ['/', 'overview'],
  ['/invoices', 'invoices'],
  ['/invoices/new', 'invoice-new'],
  ['/invoices/2', 'invoice-detail'],
  ['/clients', 'clients'],
  ['/expenses', 'expenses'],
  ['/bank', 'bank-feed'],
  ['/vehicle', 'vehicle'],
  ['/journal', 'journal'],
  ['/accounts', 'accounts'],
  [`/accounts/${role('bank')}`, 'account-ledger'],
  ['/reports', 'reports'],
  ['/gst', 'gst'],
  ['/year-end', 'year-end'],
  ['/ai', 'ai'],
  ['/migrate', 'migrate'],
  ['/settings', 'settings']
]

async function visit(theme) {
  await page.evaluate((t) => {
    localStorage.setItem('alberta-books-theme', t)
    document.documentElement.classList.toggle('dark', t === 'dark')
  }, theme)
  for (const [path, name] of screens) {
    await page.evaluate((p) => (window.location.hash = p), path)
    await page.waitForTimeout(350)
    const errorBox = await page.locator('.text-danger.bg-danger-soft, [class*="bg-danger-soft"][class*="text-danger"]').count()
    if (errorBox > 0) errors.push(`Error shown on ${path}`)
    await page.screenshot({ path: join(shots, `${theme}-${name}.png`) })
  }
}
await visit('light')
await visit('dark')

// Interactions: open the expense dialog and the journal entry dialog.
await page.evaluate(() => (window.location.hash = '/expenses?new=1'))
await page.waitForTimeout(300)
await page.screenshot({ path: join(shots, 'dark-expense-dialog.png') })
await page.keyboard.press('Escape')
await page.evaluate(() => (window.location.hash = '/journal?preset=dividend'))
await page.waitForTimeout(300)
await page.screenshot({ path: join(shots, 'dark-journal-dialog.png') })
await page.keyboard.press('Escape')

// Reports tabs
await page.evaluate(() => {
  localStorage.setItem('alberta-books-theme', 'light')
  document.documentElement.classList.remove('dark')
  window.location.hash = '/reports'
})
for (const [label, name] of [['Balance sheet', 'balance-sheet'], ['Trial balance', 'trial-balance'], ['T2 (GIFI)', 'gifi']]) {
  await page.getByRole('tab', { name: label }).click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(shots, `light-report-${name}.png`) })
}

// ---- file flows (native dialogs stubbed inside the main process) -------------
const outDir = mkdtempSync(join(tmpdir(), 'alberta-books-out-'))
const stubDialogs = (save, open) =>
  app.evaluate(({ dialog }, [s, o]) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: s })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: o ? [o] : [] })
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
  }, [save, open])

// Invoice PDF
const pdfPath = join(outDir, 'invoice.pdf')
await stubDialogs(pdfPath, null)
const pdf = await rpc('invoices.exportPdf', { id: 2 })
if (pdf.savedTo !== pdfPath || !readFileSync(pdfPath).subarray(0, 5).toString().startsWith('%PDF')) throw new Error('PDF export failed')

// CSV export, with a formula-looking client name
const csvPath = join(outDir, 'tb.csv')
await stubDialogs(csvPath, null)
await rpc('reports.exportCsv', { report: 'gifi', fiscalYearEnd: `${y}-12-31` })
if (!readFileSync(csvPath, 'utf8').includes('2599')) throw new Error('CSV export failed')

// Bank feed through the UI: drop a statement, check the preview, import, categorize, post.
const statement = join(outDir, 'statement.csv')
writeFileSync(
  statement,
  ['Date,Description,Amount', `${pad(thisMonth)}/03/${y},STAPLES #123,-56.70`, `${pad(thisMonth)}/04/${y},"E-TRANSFER, BOW RIVER",9408.00`, `${pad(thisMonth)}/05/${y},MONTHLY ACCOUNT FEE,-15.95`].join('\n')
)
await page.evaluate(() => (window.location.hash = '/bank'))
await page.getByRole('button', { name: 'Import statement' }).first().click()
await page.locator('dialog input[type=file]').setInputFiles(statement)
await page.waitForSelector('dialog >> text=STAPLES #123')
await page.screenshot({ path: join(shots, 'light-bank-import-preview.png') })
await page.getByRole('button', { name: /Import 3 transactions/ }).click()
await page.waitForSelector('text=Imported: 3 new transactions')
await page.waitForTimeout(300)
const rows = page.locator('tbody tr')
if ((await rows.count()) !== 3) throw new Error('The queue should show 3 transactions')
const pick = async (text, value) => {
  const row = page.locator('tbody tr', { hasText: text })
  const select = row.locator('select')
  if (typeof value === 'number') await select.selectOption({ index: value })
  else await select.selectOption({ label: value })
}
await pick('STAPLES', '5160 · Office expenses and supplies')
await pick('BOW RIVER', 1) // first open invoice
await pick('MONTHLY ACCOUNT FEE', '5120 · Bank charges')
await page.screenshot({ path: join(shots, 'light-bank-feed-review.png') })
await page.getByRole('button', { name: /Post 3 with a category/ }).click()
await page.waitForSelector('text=3 transactions posted')
const queue = await rpc('bank.list', { status: 'unreviewed' })
if (queue.length !== 0) throw new Error('The queue should be empty after posting')
const posted = await rpc('bank.list', { status: 'posted' })
if (posted.length !== 3 || !posted.some((t) => t.linkKind === 'payment')) throw new Error('Bank lines were not posted as expected: ' + JSON.stringify(posted.map((t) => [t.description, t.linkKind, t.category])))
// Importing the same file again adds nothing.
const again = await rpc('bank.uploadStatement', { fileName: 'statement.csv', bytes: new Uint8Array(readFileSync(statement)) })
const againResult = await rpc('bank.importStatement', { token: again.token, bankAccountId: role('bank') })
if (againResult.inserted !== 0 || againResult.duplicates !== 3) throw new Error('Duplicate import was not skipped')
// Accountant package
const zipPath = join(outDir, 'package.zip')
await stubDialogs(zipPath, null)
const pkg = await rpc('package.export', { fiscalYearEnd: `${new Date().getMonth() + 1 > 8 ? y + 1 : y}-08-31` })
if (pkg.savedTo !== zipPath) throw new Error('Package was not saved')
const zip = unzipSync(new Uint8Array(readFileSync(zipPath)))
for (const name of ['README.txt', '01 Financial statements.pdf', '02 Workbook.xlsx', 'import/trial_balance_with_GIFI.csv', 'import/quickbooks_online_journal.csv', 'import/xero_manual_journals.csv']) {
  if (!zip[name]) throw new Error(`Package is missing ${name}`)
}
if (!strFromU8(zip['01 Financial statements.pdf'].subarray(0, 5)).startsWith('%PDF')) throw new Error('Package PDF is not a PDF')

// Backup and restore round trip
const before = (await rpc('invoices.list')).length
await rpc('backup.now')
const status = await rpc('backup.status')
const newest = join(status.autoBackupDir, status.backups[0].name)
await rpc('invoices.deleteDraft', { id: (await rpc('invoices.list')).find((i) => i.status === 'draft').id })
await stubDialogs(null, newest)
const restored = await rpc('backup.restore')
if (!restored.restored || (await rpc('invoices.list')).length !== before) throw new Error('Restore did not bring the draft back')
const notABackup = join(outDir, 'evil.db')
writeFileSync(notABackup, 'not a database')
await stubDialogs(null, notABackup)
const rejected = await page.evaluate(() => window.books.call('backup.restore'))
if (rejected.ok) throw new Error('A non-backup file was restored')
if ((await rpc('invoices.list')).length !== before) throw new Error('Books changed after a rejected restore')

// ---- AI assistants ------------------------------------------------------------
const ai = await rpc('ai.setEnabled', { enabled: true })
if (!ai.running) throw new Error(`AI server did not start: ${ai.error}`)
const base = ai.mcpUrl.replace(/\/mcp$/, '')
const mcp = async (token, method, params = {}, id = 1) => {
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  })
  if (r.status !== 200) throw new Error(`MCP ${method}: HTTP ${r.status}`)
  return (await r.json()).result
}
const { token } = await rpc('ai.createToken', { name: 'E2E', mode: 'write' })
const init = await mcp(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })
if (init.serverInfo.name !== 'alberta-books') throw new Error('MCP initialize failed')
const created = await mcp(token, 'tools/call', { name: 'create_expense', arguments: { date: today, vendor: 'Indigo', category: '5160', amount: '20.00', gst: '1.00', paid_from: '1000' } })
if (created.isError) throw new Error(`AI write failed: ${created.content[0].text}`)
const activity = await rpc('ai.activity')
if (!activity.some((a) => a.actor === 'ai:E2E' && a.canUndo)) throw new Error('AI change is not in the activity log')

// OAuth like Grok: register, authorize (approval dialog stubbed to "Allow read and make changes"), token.
await stubDialogs(null, null)
const reg = await (await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Grok', redirect_uris: ['https://grok.com/cb'] }) })).json()
const verifier = randomBytes(32).toString('base64url')
const challenge = createHash('sha256').update(verifier).digest('base64url')
const authPage = await (await fetch(`${base}/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://grok.com/cb', code_challenge: challenge, code_challenge_method: 'S256', state: 's1' })}`)).text()
const pendingId = /const id = "([\w-]+)"/.exec(authPage)[1]
let location = null
for (let i = 0; i < 50 && !location; i++) {
  location = (await (await fetch(`${base}/authorize/status?id=${pendingId}`)).json()).location ?? null
  if (!location) await new Promise((r) => setTimeout(r, 100))
}
const code = new URL(location).searchParams.get('code')
const tokens = await (await fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: 'https://grok.com/cb' }) })).json()
const overview = await mcp(tokens.access_token, 'tools/call', { name: 'get_overview', arguments: {} })
if (!JSON.parse(overview.content[0].text).company.name.startsWith('Chabsun')) throw new Error('OAuth token did not work')

// Claude Desktop bridge: this app started with --mcp-stdio, talking over stdin/stdout.
const bridge = spawn(electronBinary, [join(root, 'out/main/index.js'), '--mcp-stdio', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])], {
  env: { ...process.env, ALBERTA_BOOKS_DATA_DIR: dataDir, ALBERTA_BOOKS_TOKEN: token, ...(process.getuid?.() === 0 ? { ALBERTA_BOOKS_TEST_ROOT: '1' } : {}) },
  stdio: ['pipe', 'pipe', 'pipe']
})
let bridgeOut = ''
bridge.stdout.on('data', (c) => (bridgeOut += c))
bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n')
bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
bridge.stdin.end()
const bridgeCode = await new Promise((r) => bridge.on('exit', r))
const bridgeLines = bridgeOut.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
if (bridgeCode !== 0 || bridgeLines.length !== 2 || bridgeLines[1].result.tools.length < 10) throw new Error(`stdio bridge failed (exit ${bridgeCode}): ${bridgeOut}`)

await page.evaluate(() => (window.location.hash = '/ai'))
await page.waitForTimeout(400)
await page.screenshot({ path: join(shots, 'light-ai-connected.png') })
await rpc('ai.setEnabled', { enabled: false })

console.log(`PDF: ${pdfPath}`)
await app.close()
if (errors.length) {
  console.error('Errors:\n' + errors.join('\n'))
  process.exit(1)
}
console.log(`OK: ${screens.length} screens in light and dark. Screenshots in ${shots}`)
