/**
 * One handler per allowed operation (see src/shared/api.ts). Inputs arrive
 * here already validated. File dialogs are opened by the main process, so
 * the UI never chooses or sees file paths.
 */
import { app, BrowserWindow, dialog, shell } from 'electron'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Method, Output, ParsedInput } from '../shared/api'
import { centsToPlain } from '../shared/money'
import type { BackupStatus } from '../shared/types'
import type { AppContext } from './context'
import { UserError } from './errors'
import { invoiceHtml, renderPdf } from './pdf'
import { getAccount, listAccounts, saveAccount } from './services/accounts'
import { importRows } from './services/bankImport'
import { listBackups } from './services/backup'
import { getClient, listClients, saveClient } from './services/clients'
import { parseCsv, toCsv } from './services/csv'
import { createExpense, listExpenses, voidExpense } from './services/expenses'
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

const MAX_CSV_BYTES = 5 * 1024 * 1024

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
  'expenses.create': (input, ctx) => createExpense(ctx.db, input),
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

  'import.pickCsv': async () => {
    const win = parentWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a bank statement (CSV)',
      filters: [{ name: 'CSV files', extensions: ['csv', 'txt'] }],
      properties: ['openFile']
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const file = result.filePaths[0]
    if (statSync(file).size > MAX_CSV_BYTES) throw new UserError('That file is larger than 5 MB. Export a shorter date range.')
    const rows = parseCsv(readFileSync(file, 'utf8'))
    if (rows.length < 2) throw new UserError('That file has no transactions.')
    if (rows.length > 5001) throw new UserError('That file has more than 5,000 rows. Export a shorter date range.')
    const width = Math.max(...rows.map((r) => r.length))
    const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')].map((c) => c.slice(0, 300))
    return { fileName: basename(file), headers: pad(rows[0]), rows: rows.slice(1).map(pad) }
  },
  'import.post': (input, ctx) => {
    getAccount(ctx.db, input.bankAccountId)
    return importRows(ctx.db, input.bankAccountId, input.rows)
  }
}
