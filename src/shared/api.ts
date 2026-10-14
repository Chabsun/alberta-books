/**
 * The complete list of operations the UI may ask the main process to perform.
 *
 * Security model: the UI (renderer) is treated as untrusted. It cannot run
 * SQL, touch the file system or pick file paths. It can only call the methods
 * below, and every input is validated with these schemas in the main process
 * before anything runs.
 */
import { z } from 'zod'
import { isIsoDate } from './dates'
import { ACCOUNT_TYPES } from './types'
import type {
  Account,
  AiActivity,
  AiStatus,
  AccountLedger,
  Asset,
  AuditEvent,
  BackupStatus,
  BalanceSheet,
  BankRule,
  BankTransaction,
  CcaSchedule,
  Client,
  Dashboard,
  Expense,
  ExpensePreview,
  FiledGstReturn,
  GifiReport,
  GstReturn,
  IncomeStatement,
  Invoice,
  InvoiceSummary,
  Issue,
  JournalEntry,
  MigrationResult,
  PendingMigration,
  Receipt,
  Settings,
  StatementImportResult,
  StatementPreview,
  TaxAdjustments,
  TrialBalance,
  Vehicle,
  VehicleBenefit,
  VehicleLimits,
  VehicleTrip
} from './types'

const MAX_CENTS = 99_999_999_999_99

const id = z.int().positive()
const date = z.string().refine(isIsoDate, 'Enter a valid date')
const cents = z.int().min(-MAX_CENTS).max(MAX_CENTS)
const positiveCents = z.int().positive().max(MAX_CENTS)
const nonNegativeCents = z.int().min(0).max(MAX_CENTS)
const text = (max: number) => z.string().trim().max(max)
const requiredText = (max: number, label: string) =>
  z.string().trim().min(1, `${label} is required`).max(max)
const none = z.undefined()

const pct = z.int().min(0).max(100)
const year = z.int().min(2000).max(2100)
const gstNumber = text(20).refine((s) => s === '' || /^\d{9}\s?RT\s?\d{4}$/i.test(s), 'GST number looks like 123456789 RT0001')
/** Random handle for a file the main process is holding (see pendingFiles.ts). */
const token = z.string().regex(/^[\w-]{24}$/, 'That file is no longer open. Choose it again.')
const bytes = (maxMb: number) =>
  z.instanceof(Uint8Array).refine((b) => b.length > 0 && b.length <= maxMb * 1024 * 1024, `Files can be up to ${maxMb} MB.`)
const fileName = requiredText(200, 'File name')

const col = z.int().min(0).max(200)
const csvMapping = z.object({
  date: col,
  description: col,
  amount: col.optional(),
  debit: col.optional(),
  credit: col.optional(),
  dateFormat: z.enum(['ymd', 'mdy', 'dmy']),
  hasHeader: z.boolean(),
  flipSigns: z.boolean().optional()
})

const expenseInput = z.object({
  date,
  vendor: requiredText(150, 'Vendor'),
  description: text(500).default(''),
  accountId: id,
  amountCents: positiveCents,
  gstCents: nonNegativeCents,
  paidFromAccountId: id,
  businessPct: pct.optional(),
  supplierGstNumber: gstNumber.optional(),
  purpose: text(500).optional(),
  attendees: text(500).optional(),
  vehicleId: id.nullable().optional(),
  primarilyBusiness: z.boolean().optional()
})

const categorizeTarget = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('account'),
    accountId: id,
    gstIncluded: z.boolean().optional(),
    businessPct: pct.optional(),
    purpose: text(500).optional(),
    attendees: text(500).optional(),
    supplierGstNumber: gstNumber.optional(),
    memo: text(300).optional()
  }),
  z.object({ kind: z.literal('invoice'), invoiceId: id })
])

const range = z
  .object({ from: date, to: date })
  .refine((r) => r.from <= r.to, 'The start date must be on or before the end date')

export const schemas = {
  'app.info': none,
  'app.setTheme': z.object({ theme: z.enum(['system', 'light', 'dark']) }),

  'settings.get': none,
  'settings.update': z.object({
    companyName: requiredText(120, 'Company name').optional(),
    address: text(400).optional(),
    email: text(200).optional(),
    phone: text(50).optional(),
    gstNumber: gstNumber.optional(),
    fiscalYearEndMonth: z.int().min(1).max(12).optional(),
    invoicePrefix: text(12).optional(),
    nextInvoiceNumber: z.int().positive().max(9_999_999).optional(),
    paymentTermsDays: z.int().min(0).max(365).optional(),
    invoiceFooter: text(600).optional(),
    lockDate: date.nullable().optional()
  }),

  'accounts.list': z.object({ includeArchived: z.boolean().optional() }).optional(),
  'accounts.save': z.object({
    id: id.optional(),
    code: z.string().trim().regex(/^\d{3,6}$/, 'Account code must be 3 to 6 digits'),
    name: requiredText(100, 'Account name'),
    type: z.enum(ACCOUNT_TYPES as [string, ...string[]]),
    gifiCode: z
      .string()
      .trim()
      .regex(/^(\d{4})?$/, 'GIFI codes are 4 digits')
      .optional(),
    isBank: z.boolean().optional(),
    taxRule: z.string().max(40).nullable().optional(),
    archived: z.boolean().optional()
  }),

  'clients.list': z.object({ includeArchived: z.boolean().optional() }).optional(),
  'clients.save': z.object({
    id: id.optional(),
    name: requiredText(150, 'Client name'),
    email: text(200).default(''),
    phone: text(50).default(''),
    address: text(400).default(''),
    archived: z.boolean().optional()
  }),

  'invoices.list': none,
  'invoices.get': z.object({ id }),
  'invoices.saveDraft': z
    .object({
      id: id.optional(),
      clientId: id,
      issueDate: date,
      dueDate: date,
      notes: text(2000).default(''),
      lines: z
        .array(
          z.object({
            description: requiredText(500, 'Line description'),
            qtyMilli: z.int().positive().max(1_000_000_000),
            unitPriceCents: cents,
            taxable: z.boolean(),
            accountId: id
          })
        )
        .min(1, 'Add at least one line')
        .max(200)
    })
    .refine((v) => v.dueDate >= v.issueDate, 'The due date cannot be before the invoice date'),
  'invoices.deleteDraft': z.object({ id }),
  'invoices.issue': z.object({ id }),
  'invoices.void': z.object({ id, date }),
  'invoices.recordPayment': z.object({ invoiceId: id, date, amountCents: positiveCents, accountId: id }),
  'invoices.voidPayment': z.object({ paymentId: id, date }),
  'invoices.exportPdf': z.object({ id }),

  'expenses.list': none,
  'expenses.preview': expenseInput,
  'expenses.create': expenseInput,
  'expenses.updateDetails': z.object({
    id,
    supplierGstNumber: gstNumber.optional(),
    purpose: text(500).optional(),
    attendees: text(500).optional(),
    description: text(500).optional()
  }),
  'expenses.void': z.object({ id, date }),

  'journal.list': z.object({ limit: z.int().min(1).max(5000).optional() }).optional(),
  'journal.create': z.object({
    date,
    memo: requiredText(300, 'Description'),
    lines: z
      .array(
        z.object({
          accountId: id,
          debitCents: nonNegativeCents,
          creditCents: nonNegativeCents,
          memo: text(200).default('')
        })
      )
      .min(2, 'A journal entry needs at least two lines')
      .max(100)
  }),
  'journal.reverse': z.object({ id, date }),

  'reports.dashboard': none,
  'reports.incomeStatement': range,
  'reports.balanceSheet': z.object({ asOf: date }),
  'reports.trialBalance': z.object({ asOf: date }),
  'reports.gstReturn': range,
  'reports.fileGstReturn': range,
  'reports.gstFilings': none,
  'reports.ledger': z
    .object({ accountId: id, from: date, to: date })
    .refine((r) => r.from <= r.to, 'The start date must be on or before the end date'),
  'reports.gifi': z.object({ fiscalYearEnd: date }),
  'reports.exportCsv': z.discriminatedUnion('report', [
    z.object({ report: z.literal('trialBalance'), asOf: date }),
    z.object({ report: z.literal('balanceSheet'), asOf: date }),
    z.object({ report: z.literal('incomeStatement'), from: date, to: date }),
    z.object({ report: z.literal('journal'), from: date, to: date }),
    z.object({ report: z.literal('gifi'), fiscalYearEnd: date })
  ]),

  'backup.status': none,
  'backup.now': none,
  'backup.chooseFolder': z.object({ clear: z.boolean().optional() }).optional(),
  'backup.openFolder': none,
  'backup.restore': none,

  // Bank feed
  'bank.pickStatement': none,
  'bank.uploadStatement': z.object({ fileName, bytes: bytes(10) }),
  'bank.previewStatement': z.object({ token, mapping: csvMapping }),
  'bank.importStatement': z.object({ token, bankAccountId: id, mapping: csvMapping.optional() }),
  'bank.list': z
    .object({
      status: z.enum(['unreviewed', 'posted', 'excluded']).optional(),
      accountId: id.optional(),
      from: date.optional(),
      to: date.optional(),
      search: text(100).optional(),
      limit: z.int().min(1).max(5000).optional()
    })
    .optional(),
  'bank.categorize': z.object({ id, target: categorizeTarget, remember: z.boolean().default(false) }),
  'bank.uncategorize': z.object({ id, date: date.optional() }),
  'bank.exclude': z.object({ id, reason: text(200).default('') }),
  'bank.rules': none,
  'bank.saveRule': z.object({
    pattern: requiredText(100, 'Text to match'),
    matchType: z.enum(['contains', 'equals', 'starts']).optional(),
    direction: z.enum(['any', 'in', 'out']).optional(),
    accountId: id,
    gstIncluded: z.boolean().optional(),
    businessPct: pct.optional(),
    autoPost: z.boolean().optional()
  }),
  'bank.deleteRule': z.object({ id }),

  // Company vehicle
  'vehicles.list': none,
  'vehicles.save': z
    .object({
      id: id.optional(),
      name: requiredText(80, 'Vehicle name'),
      ownership: z.enum(['owned', 'leased']),
      startDate: date,
      endDate: date.nullable().optional(),
      costCents: nonNegativeCents.optional(),
      msrpCents: nonNegativeCents.optional(),
      monthlyLeaseCents: nonNegativeCents.optional(),
      zeroEmission: z.boolean().optional(),
      notes: text(500).optional(),
      archived: z.boolean().optional()
    }),
  'vehicles.trips': z.object({ vehicleId: id, from: date, to: date }),
  'vehicles.addTrip': z.object({
    vehicleId: id,
    date,
    km: z.int().min(1).max(100_000),
    kind: z.enum(['business', 'personal']),
    purpose: text(300).optional(),
    route: text(300).optional()
  }),
  'vehicles.deleteTrip': z.object({ id }),
  'vehicles.setYear': z.object({
    vehicleId: id,
    year,
    reimbursedOperatingCents: nonNegativeCents,
    reimbursedStandbyCents: nonNegativeCents,
    electHalfStandby: z.boolean()
  }),
  'vehicles.benefit': z.object({ vehicleId: id, year }),
  'vehicles.limits': z.object({ vehicleId: id, fiscalYearEnd: date }),

  // Capital assets and year end
  'cca.schedule': z.object({ fiscalYearEnd: date }),
  'cca.assets': none,
  'cca.setOpening': z.object({ ccaClass: z.enum(['8', '10', '10.1', '12', '12T', '50', '54']), asOf: date, uccCents: nonNegativeCents }),
  'cca.dispose': z.object({ id, date, proceedsCents: nonNegativeCents }),
  'tax.adjustments': z.object({ fiscalYearEnd: date }),
  'issues.list': none,
  'audit.list': z.object({ actorPrefix: text(60).optional(), limit: z.int().min(1).max(2000).optional() }).optional(),
  'package.export': z.object({ fiscalYearEnd: date }),

  // Receipts
  'receipts.list': z.object({ expenseId: id.optional(), bankTransactionId: id.optional() }),
  'receipts.pick': z.object({ expenseId: id.optional(), bankTransactionId: id.optional() }),
  'receipts.upload': z.object({ fileName, bytes: bytes(15), expenseId: id.optional(), bankTransactionId: id.optional() }),
  'receipts.open': z.object({ id }),

  // Moving from QuickBooks or Zoho
  'migration.pickFile': none,
  'migration.uploadFile': z.object({ fileName, bytes: bytes(20) }),
  'migration.import': z.object({
    token,
    source: z.enum(['quickbooks', 'zoho', 'other']),
    mapping: z.record(z.string().max(200), id),
    from: date.optional(),
    to: date.optional(),
    dryRun: z.boolean().optional()
  }),
  // AI assistants (the assistants themselves can never call these)
  'ai.status': none,
  'ai.setEnabled': z.object({ enabled: z.boolean() }),
  'ai.createToken': z.object({ name: requiredText(60, 'Name'), mode: z.enum(['read', 'write']) }),
  'ai.connectClaudeDesktop': z.object({ mode: z.enum(['read', 'write']) }),
  'ai.connectClaudeCode': z.object({ mode: z.enum(['read', 'write']) }),
  'ai.setMode': z.object({ id, mode: z.enum(['read', 'write']) }),
  'ai.revoke': z.object({ id }),
  'ai.startTunnel': z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('quick') }),
    z.object({ mode: z.literal('named'), hostname: requiredText(200, 'Hostname'), token: text(2000).optional() })
  ]),
  'ai.stopTunnel': none,
  'ai.installCloudflared': none,
  'ai.activity': z.object({ limit: z.int().min(1).max(2000).optional() }).optional(),
  'ai.undo': z.object({ auditId: id }),

  'migration.openingBalances': z.object({
    date,
    balances: z
      .array(z.object({ accountId: id, debitCents: nonNegativeCents, creditCents: nonNegativeCents }))
      .min(2, 'Enter at least two balances')
      .max(500)
  })
} as const

export type Method = keyof typeof schemas
export type Input<M extends Method> = z.input<(typeof schemas)[M]>
export type ParsedInput<M extends Method> = z.output<(typeof schemas)[M]>

export interface Outputs {
  'app.info': { version: string; platform: string; databasePath: string }
  'app.setTheme': null
  'settings.get': Settings
  'settings.update': Settings
  'accounts.list': Account[]
  'accounts.save': Account
  'clients.list': Client[]
  'clients.save': Client
  'invoices.list': InvoiceSummary[]
  'invoices.get': Invoice
  'invoices.saveDraft': Invoice
  'invoices.deleteDraft': null
  'invoices.issue': Invoice
  'invoices.void': Invoice
  'invoices.recordPayment': Invoice
  'invoices.voidPayment': Invoice
  'invoices.exportPdf': { savedTo: string | null }
  'expenses.list': Expense[]
  'expenses.preview': ExpensePreview
  'expenses.create': Expense
  'expenses.updateDetails': Expense
  'expenses.void': Expense
  'journal.list': JournalEntry[]
  'journal.create': JournalEntry
  'journal.reverse': JournalEntry
  'reports.dashboard': Dashboard
  'reports.incomeStatement': IncomeStatement
  'reports.balanceSheet': BalanceSheet
  'reports.trialBalance': TrialBalance
  'reports.gstReturn': GstReturn
  'reports.fileGstReturn': GstReturn
  'reports.gstFilings': FiledGstReturn[]
  'reports.ledger': AccountLedger
  'reports.gifi': GifiReport
  'reports.exportCsv': { savedTo: string | null }
  'backup.status': BackupStatus
  'backup.now': BackupStatus
  'backup.chooseFolder': BackupStatus
  'backup.openFolder': null
  'backup.restore': { restored: boolean }
  'bank.pickStatement': StatementPreview | null
  'bank.uploadStatement': StatementPreview
  'bank.previewStatement': StatementPreview
  'bank.importStatement': StatementImportResult
  'bank.list': BankTransaction[]
  'bank.categorize': BankTransaction
  'bank.uncategorize': BankTransaction
  'bank.exclude': BankTransaction
  'bank.rules': BankRule[]
  'bank.saveRule': BankRule
  'bank.deleteRule': null
  'vehicles.list': Vehicle[]
  'vehicles.save': Vehicle
  'vehicles.trips': VehicleTrip[]
  'vehicles.addTrip': VehicleTrip
  'vehicles.deleteTrip': null
  'vehicles.setYear': VehicleBenefit
  'vehicles.benefit': VehicleBenefit
  'vehicles.limits': VehicleLimits
  'cca.schedule': CcaSchedule
  'cca.assets': Asset[]
  'cca.setOpening': CcaSchedule
  'cca.dispose': Asset[]
  'tax.adjustments': TaxAdjustments
  'issues.list': Issue[]
  'audit.list': AuditEvent[]
  'package.export': { savedTo: string | null; receipts: number }
  'receipts.list': Receipt[]
  'receipts.pick': Receipt[]
  'receipts.upload': Receipt
  'receipts.open': null
  'migration.pickFile': PendingMigration | null
  'migration.uploadFile': PendingMigration
  'migration.import': MigrationResult
  'migration.openingBalances': { entryId: number }
  'ai.status': AiStatus
  'ai.setEnabled': AiStatus
  'ai.createToken': { status: AiStatus; token: string }
  'ai.connectClaudeDesktop': AiStatus
  'ai.connectClaudeCode': { status: AiStatus; token: string; command: string }
  'ai.setMode': AiStatus
  'ai.revoke': AiStatus
  'ai.startTunnel': AiStatus
  'ai.stopTunnel': AiStatus
  'ai.installCloudflared': AiStatus
  'ai.activity': AiActivity[]
  'ai.undo': AiActivity[]
}

export type Output<M extends Method> = Outputs[M]

export type RpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** What the preload script exposes on `window.books`. */
export interface BooksBridge {
  platform: string
  call(method: string, input: unknown): Promise<RpcResult<unknown>>
  /** Subscribes to changes made outside the window (AI assistants). Returns an unsubscribe function. */
  onChanged(fn: () => void): () => void
}
