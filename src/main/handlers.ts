/**
 * One handler per allowed operation (see src/shared/api.ts). Inputs arrive
 * here already validated. File dialogs are opened by the main process, so
 * the UI never chooses or sees file paths.
 */
import { app, BrowserWindow, clipboard, dialog, nativeTheme, shell } from 'electron'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Method, Output, ParsedInput } from '../shared/api'
import { centsToPlain } from '../shared/money'
import type { BackupStatus } from '../shared/types'
import type { AppContext } from './context'
import { UserError } from './errors'
import { invoiceHtml, renderPdf } from './pdf'
import { listAiActivity, undoAiActivity } from './ai/activity'
import { revokeConnection, setConnectionConfirm, setConnectionMode } from './ai/connections'
import { holdFile, releaseFile, takeFile } from './pendingFiles'
import { buildAccountantPackage } from './services/accountantPackage'
import { listAccounts, saveAccount } from './services/accounts'
import { listAudit } from './services/audit'
import { listBackups } from './services/backup'
import {
  categorize,
  deleteRule,
  excludeTransaction,
  importStatement,
  listBankTransactions,
  listRules,
  saveRule,
  uncategorize
} from './services/bankFeed'
import { ccaSchedule, disposeAsset, listAssets, setOpeningUcc } from './services/cca'
import { getClient, listClients, saveClient } from './services/clients'
import { toCsv } from './services/csv'
import { createExpense, listExpenses, previewExpense, updateExpenseDetails, voidExpense } from './services/expenses'
import { findIssues } from './services/issues'
import { analyzeJournal, importJournal, setOpeningBalances } from './services/migration'
import { addReceipt, listReceipts, receiptPath } from './services/receipts'
import { previewStatement } from './services/statements'
import { taxAdjustments } from './services/taxAdjustments'
import {
  addTrip,
  deleteTrip,
  listTrips,
  listVehicles,
  saveVehicle,
  setVehicleYear,
  vehicleBenefit,
  vehicleLimits
} from './services/vehicles'
import {
  deleteDraft,
  getInvoice,
  issueInvoice,
  listInvoices,
  recordPayment,
  saveDraft,
  voidInvoice,
  voidPayment
} from './services/invoices'
import { createManualEntry, listEntries, listEntriesBetween, reverseManualEntry } from './services/ledger'
import {
  accountLedger,
  balanceSheet,
  dashboard,
  fileGstReturn,
  gifiReport,
  gstFilings,
  gstReturn,
  incomeStatement,
  trialBalance
} from './services/reports'
import { getSettings, updateSettings } from './services/settings'

type Handlers = { [M in Method]: (input: ParsedInput<M>, ctx: AppContext) => Output<M> | Promise<Output<M>> }

function parentWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

async function saveFile(defaultName: string, filters: Electron.FileFilter[], data: string | Buffer): Promise<string | null> {
  const win = parentWindow()
  const options = { defaultPath: join(app.getPath('documents'), defaultName), filters }
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return null
  writeFileSync(result.filePath, data)
  return result.filePath
}

/** Opens files the user picks and reads them (with a size limit). The UI never sees the paths. */
async function openFiles(
  title: string,
  filters: Electron.FileFilter[],
  maxMb: number,
  multiple = false
): Promise<{ fileName: string; bytes: Uint8Array }[]> {
  const win = parentWindow()
  const options: Electron.OpenDialogOptions = {
    title,
    filters,
    properties: multiple ? ['openFile', 'multiSelections'] : ['openFile']
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  if (result.canceled) return []
  return result.filePaths.map((file) => {
    if (statSync(file).size > maxMb * 1024 * 1024) throw new UserError(`"${basename(file)}" is larger than ${maxMb} MB.`)
    return { fileName: basename(file), bytes: new Uint8Array(readFileSync(file)) }
  })
}

const STATEMENT_FILTERS = [
  { name: 'Bank statements (OFX, QFX, QBO, CSV)', extensions: ['ofx', 'qfx', 'qbo', 'csv', 'txt'] },
  { name: 'All files', extensions: ['*'] }
]
const RECEIPT_FILTERS = [{ name: 'Receipts (PDF or photo)', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'heic'] }]
const JOURNAL_FILTERS = [{ name: 'Journal export (CSV or Excel)', extensions: ['csv', 'txt', 'xlsx'] }]

function stageStatement(fileName: string, bytes: Uint8Array) {
  const preview = previewStatement(fileName, bytes)
  return { token: holdFile('statement', fileName, bytes), ...preview }
}

function stageMigration(ctx: AppContext, fileName: string, bytes: Uint8Array) {
  const analysis = analyzeJournal(ctx.db, fileName, bytes)
  return { token: holdFile('migration', fileName, bytes), fileName, analysis }
}

function addReceipts(ctx: AppContext, files: { fileName: string; bytes: Uint8Array }[], link: { expenseId?: number; bankTransactionId?: number }) {
  const added = []
  const errors: string[] = []
  for (const f of files) {
    try {
      added.push(addReceipt(ctx.db, ctx.receiptsDir, { ...f, ...link }))
    } catch (err) {
      if (!(err instanceof UserError)) throw err
      errors.push(`${f.fileName}: ${err.message}`)
    }
  }
  if (errors.length && !added.length) throw new UserError(errors.join(' '))
  return added
}

function backupStatus(ctx: AppContext): BackupStatus {
  return {
    databasePath: ctx.dbPath,
    autoBackupDir: ctx.autoBackupDir,
    extraBackupDir: getSettings(ctx.db).backupDir,
    backups: listBackups(ctx.autoBackupDir).slice(0, 20)
  }
}

const money = (cents: number) => Number(centsToPlain(cents))

export const handlers: Handlers = {
  'app.info': (_i, ctx) => ({ version: app.getVersion(), platform: process.platform, databasePath: ctx.dbPath }),
  // Keeps the Windows title bar (and native dialogs) in the same light/dark mode as the app.
  'app.setTheme': (input) => {
    nativeTheme.themeSource = input.theme
    return null
  },

  'app.copy': (input) => {
    clipboard.writeText(input.text)
    return null
  },

  'settings.get': (_i, ctx) => getSettings(ctx.db),
  'settings.update': (input, ctx) => updateSettings(ctx.db, input),

  'accounts.list': (input, ctx) => listAccounts(ctx.db, input?.includeArchived ?? false),
  'accounts.save': (input, ctx) => saveAccount(ctx.db, input),

  'clients.list': (input, ctx) => listClients(ctx.db, input?.includeArchived ?? false),
  'clients.save': (input, ctx) => saveClient(ctx.db, input),

  'invoices.list': (_i, ctx) => listInvoices(ctx.db),
  'invoices.get': (input, ctx) => getInvoice(ctx.db, input.id),
  'invoices.saveDraft': (input, ctx) => saveDraft(ctx.db, input),
  'invoices.deleteDraft': (input, ctx) => {
    deleteDraft(ctx.db, input.id)
    return null
  },
  'invoices.issue': (input, ctx) => issueInvoice(ctx.db, input.id),
  'invoices.void': (input, ctx) => voidInvoice(ctx.db, input.id, input.date),
  'invoices.recordPayment': (input, ctx) => recordPayment(ctx.db, input),
  'invoices.voidPayment': (input, ctx) => voidPayment(ctx.db, input.paymentId, input.date),
  'invoices.exportPdf': async (input, ctx) => {
    const inv = getInvoice(ctx.db, input.id)
    const client = getClient(ctx.db, inv.clientId)
    const pdf = await renderPdf(invoiceHtml(inv, getSettings(ctx.db), client))
    const name = `${inv.number ?? `Draft invoice ${inv.id}`} – ${client.name}.pdf`.replace(/[/\\?%*:|"<>]/g, '-')
    return { savedTo: await saveFile(name, [{ name: 'PDF', extensions: ['pdf'] }], pdf) }
  },

  'expenses.list': (_i, ctx) => listExpenses(ctx.db),
  'expenses.preview': (input, ctx) => previewExpense(ctx.db, input),
  'expenses.create': (input, ctx) => createExpense(ctx.db, input),
  'expenses.updateDetails': (input, ctx) => updateExpenseDetails(ctx.db, input.id, input),
  'expenses.void': (input, ctx) => voidExpense(ctx.db, input.id, input.date),

  'journal.list': (input, ctx) => listEntries(ctx.db, input?.limit ?? 500),
  'journal.create': (input, ctx) => createManualEntry(ctx.db, input),
  'journal.reverse': (input, ctx) => reverseManualEntry(ctx.db, input.id, input.date),

  'reports.dashboard': (_i, ctx) => dashboard(ctx.db, ctx.lastBackupAt()),
  'reports.incomeStatement': (input, ctx) => incomeStatement(ctx.db, input.from, input.to),
  'reports.balanceSheet': (input, ctx) => balanceSheet(ctx.db, input.asOf),
  'reports.trialBalance': (input, ctx) => trialBalance(ctx.db, input.asOf),
  'reports.gstReturn': (input, ctx) => gstReturn(ctx.db, input.from, input.to),
  'reports.fileGstReturn': (input, ctx) => {
    const r = fileGstReturn(ctx.db, input.from, input.to)
    ctx.backup()
    return r
  },
  'reports.gstFilings': (_i, ctx) => gstFilings(ctx.db),
  'reports.ledger': (input, ctx) => accountLedger(ctx.db, input.accountId, input.from, input.to),
  'reports.gifi': (input, ctx) => gifiReport(ctx.db, input.fiscalYearEnd),
  'reports.exportCsv': async (input, ctx) => {
    const company = getSettings(ctx.db).companyName
    let rows: (string | number)[][]
    let name: string
    switch (input.report) {
      case 'trialBalance': {
        const tb = trialBalance(ctx.db, input.asOf)
        rows = [['Code', 'Account', 'Debit', 'Credit'], ...tb.rows.map((r) => [r.code, r.name, money(r.debitCents), money(r.creditCents)]), ['', 'Total', money(tb.totalDebitCents), money(tb.totalCreditCents)]]
        name = `Trial balance ${input.asOf}`
        break
      }
      case 'balanceSheet': {
        const bs = balanceSheet(ctx.db, input.asOf)
        const section = (title: string, list: typeof bs.assets, total: number) => [[title], ...list.map((r) => [r.code, r.name, money(r.amountCents)]), ['', `Total ${title.toLowerCase()}`, money(total)]]
        rows = [['Code', 'Account', 'Amount'], ...section('Assets', bs.assets, bs.totalAssetsCents), ...section('Liabilities', bs.liabilities, bs.totalLiabilitiesCents), ...section('Equity', bs.equity, bs.totalEquityCents)]
        name = `Balance sheet ${input.asOf}`
        break
      }
      case 'incomeStatement': {
        const is = incomeStatement(ctx.db, input.from, input.to)
        rows = [['Code', 'Account', 'Amount'], ['Income'], ...is.income.map((r) => [r.code, r.name, money(r.amountCents)]), ['', 'Total income', money(is.totalIncomeCents)], ['Expenses'], ...is.expenses.map((r) => [r.code, r.name, money(r.amountCents)]), ['', 'Total expenses', money(is.totalExpensesCents)], ['', 'Net income', money(is.netIncomeCents)]]
        name = `Income statement ${input.from} to ${input.to}`
        break
      }
      case 'journal': {
        rows = [['Entry', 'Date', 'Description', 'Source', 'Code', 'Account', 'Debit', 'Credit', 'Line memo']]
        for (const e of listEntriesBetween(ctx.db, input.from, input.to)) {
          for (const l of e.lines) rows.push([e.id, e.date, e.memo, e.source, l.accountCode, l.accountName, money(l.debitCents), money(l.creditCents), l.memo])
        }
        name = `General journal ${input.from} to ${input.to}`
        break
      }
      case 'gifi': {
        const g = gifiReport(ctx.db, input.fiscalYearEnd)
        rows = [['Schedule', 'GIFI code', 'Description', 'Amount'], ...g.schedule100.map((l) => ['100', l.gifiCode, l.description, money(l.amountCents)]), ...g.schedule125.map((l) => ['125', l.gifiCode, l.description, money(l.amountCents)])]
        name = `GIFI ${g.fiscalYearEnd}`
        break
      }
    }
    return { savedTo: await saveFile(`${company} – ${name}.csv`.replace(/[/\\?%*:|"<>]/g, '-'), [{ name: 'CSV', extensions: ['csv'] }], toCsv(rows)) }
  },

  'backup.status': (_i, ctx) => backupStatus(ctx),
  'backup.now': (_i, ctx) => {
    ctx.backup()
    return backupStatus(ctx)
  },
  'backup.chooseFolder': async (input, ctx) => {
    if (input?.clear) {
      updateSettings(ctx.db, { backupDir: null })
      return backupStatus(ctx)
    }
    const win = parentWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a second backup folder (for example in iCloud Drive or Dropbox)',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (!result.canceled && result.filePaths[0]) {
      updateSettings(ctx.db, { backupDir: result.filePaths[0] })
      ctx.backup()
    }
    return backupStatus(ctx)
  },
  'backup.openFolder': async (_i, ctx) => {
    await shell.openPath(ctx.autoBackupDir)
    return null
  },
  'backup.restore': async (_i, ctx) => {
    const win = parentWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a backup to restore',
      defaultPath: ctx.autoBackupDir,
      filters: [{ name: 'Alberta Books backup', extensions: ['db'] }],
      properties: ['openFile']
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return { restored: false }
    const file = result.filePaths[0]
    const confirm = {
      type: 'warning' as const,
      buttons: ['Restore', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Restore "${basename(file)}"?`,
      detail: 'Your current books will be replaced by this backup. A backup of the current books is made first, so this can be undone.'
    }
    const answer = win ? await dialog.showMessageBox(win, confirm) : await dialog.showMessageBox(confirm)
    if (answer.response !== 0) return { restored: false }
    try {
      ctx.restoreFrom(file)
    } catch (err) {
      throw new UserError(err instanceof Error ? err.message : 'The backup could not be restored.')
    }
    return { restored: true }
  },

  'bank.pickStatement': async () => {
    const [file] = await openFiles('Choose a bank or credit card statement', STATEMENT_FILTERS, 10)
    return file ? stageStatement(file.fileName, file.bytes) : null
  },
  'bank.uploadStatement': (input) => stageStatement(input.fileName, input.bytes),
  'bank.previewStatement': (input) => {
    const f = takeFile('statement', input.token)
    return { token: input.token, ...previewStatement(f.fileName, f.bytes, input.mapping) }
  },
  'bank.importStatement': (input, ctx) => {
    const f = takeFile('statement', input.token)
    const result = importStatement(ctx.db, { bankAccountId: input.bankAccountId, fileName: f.fileName, bytes: f.bytes, mapping: input.mapping })
    releaseFile(input.token)
    return result
  },
  'bank.list': (input, ctx) => listBankTransactions(ctx.db, input ?? {}),
  'bank.categorize': (input, ctx) => categorize(ctx.db, input.id, input.target, input.remember),
  'bank.uncategorize': (input, ctx) => uncategorize(ctx.db, input.id, input.date),
  'bank.exclude': (input, ctx) => excludeTransaction(ctx.db, input.id, input.reason),
  'bank.rules': (_i, ctx) => listRules(ctx.db),
  'bank.saveRule': (input, ctx) => saveRule(ctx.db, input),
  'bank.deleteRule': (input, ctx) => {
    deleteRule(ctx.db, input.id)
    return null
  },

  'vehicles.list': (_i, ctx) => listVehicles(ctx.db),
  'vehicles.save': (input, ctx) => saveVehicle(ctx.db, input),
  'vehicles.trips': (input, ctx) => listTrips(ctx.db, input.vehicleId, input.from, input.to),
  'vehicles.addTrip': (input, ctx) => addTrip(ctx.db, input),
  'vehicles.deleteTrip': (input, ctx) => {
    deleteTrip(ctx.db, input.id)
    return null
  },
  'vehicles.setYear': (input, ctx) => {
    setVehicleYear(ctx.db, input.vehicleId, input.year, input)
    return vehicleBenefit(ctx.db, input.vehicleId, input.year)
  },
  'vehicles.benefit': (input, ctx) => vehicleBenefit(ctx.db, input.vehicleId, input.year),
  'vehicles.limits': (input, ctx) => vehicleLimits(ctx.db, input.vehicleId, input.fiscalYearEnd),

  'cca.schedule': (input, ctx) => ccaSchedule(ctx.db, input.fiscalYearEnd),
  'cca.assets': (_i, ctx) => listAssets(ctx.db),
  'cca.setOpening': (input, ctx) => {
    setOpeningUcc(ctx.db, input.ccaClass, input.asOf, input.uccCents)
    return ccaSchedule(ctx.db, input.asOf)
  },
  'cca.dispose': (input, ctx) => {
    disposeAsset(ctx.db, input.id, input.date, input.proceedsCents)
    return listAssets(ctx.db)
  },
  'tax.adjustments': (input, ctx) => taxAdjustments(ctx.db, input.fiscalYearEnd),
  'issues.list': (_i, ctx) => findIssues(ctx.db),
  'audit.list': (input, ctx) => listAudit(ctx.db, input ?? {}),
  'package.export': async (input, ctx) => {
    const pkg = await buildAccountantPackage(ctx.db, ctx.receiptsDir, input.fiscalYearEnd, renderPdf)
    const savedTo = await saveFile(pkg.fileName, [{ name: 'Zip archive', extensions: ['zip'] }], Buffer.from(pkg.zip))
    if (savedTo) shell.showItemInFolder(savedTo)
    return { savedTo, receipts: pkg.receipts }
  },

  'receipts.list': (input, ctx) => listReceipts(ctx.db, input),
  'receipts.pick': async (input, ctx) => addReceipts(ctx, await openFiles('Attach receipts', RECEIPT_FILTERS, 15, true), input),
  'receipts.upload': (input, ctx) => {
    const { fileName, bytes, ...link } = input
    return addReceipts(ctx, [{ fileName, bytes }], link)[0]!
  },
  'receipts.open': async (input, ctx) => {
    // Stored names are <sha256>.<pdf|jpg|png|webp|heic> (checked by receiptPath): opens in the default viewer.
    const error = await shell.openPath(receiptPath(ctx.db, ctx.receiptsDir, input.id))
    if (error) throw new UserError(`The receipt could not be opened: ${error}`)
    return null
  },

  'migration.pickFile': async (_i, ctx) => {
    const [file] = await openFiles('Choose a QuickBooks or Zoho journal export', JOURNAL_FILTERS, 20)
    return file ? stageMigration(ctx, file.fileName, file.bytes) : null
  },
  'migration.uploadFile': (input, ctx) => stageMigration(ctx, input.fileName, input.bytes),
  'migration.import': (input, ctx) => {
    const f = takeFile('migration', input.token)
    const { token: _t, ...opts } = input
    const result = importJournal(ctx.db, f.fileName, f.bytes, opts)
    if (!input.dryRun) {
      releaseFile(input.token)
      ctx.backup()
    }
    return result
  },
  'migration.openingBalances': (input, ctx) => ({ entryId: setOpeningBalances(ctx.db, input.date, input.balances) }),

  'ai.status': (_i, ctx) => ctx.ai.status(),
  'ai.setEnabled': (input, ctx) => ctx.ai.setEnabled(input.enabled),
  'ai.createToken': (input, ctx) => ctx.ai.createToken(input.name, input.mode),
  'ai.connectClaudeDesktop': (input, ctx) => ctx.ai.connectClaudeDesktop(input.mode),
  'ai.connectClaudeCode': (input, ctx) => ctx.ai.connectClaudeCode(input.mode),
  'ai.setMode': (input, ctx) => {
    setConnectionMode(ctx.db, input.id, input.mode)
    return ctx.ai.status()
  },
  'ai.setConfirm': (input, ctx) => {
    setConnectionConfirm(ctx.db, input.id, input.confirm)
    return ctx.ai.status()
  },
  'ai.revoke': (input, ctx) => {
    revokeConnection(ctx.db, input.id)
    return ctx.ai.status()
  },
  'ai.startTunnel': (input, ctx) => ctx.ai.startTunnel(input),
  'ai.stopTunnel': (_i, ctx) => ctx.ai.stopTunnel(),
  'ai.installCloudflared': (_i, ctx) => ctx.ai.installCloudflared(),
  'ai.activity': (input, ctx) => listAiActivity(ctx.db, input?.limit),
  'ai.undo': (input, ctx) => {
    undoAiActivity(ctx.db, input.auditId)
    return listAiActivity(ctx.db)
  }
}
