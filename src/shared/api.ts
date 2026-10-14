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
  AccountLedger,
  BackupStatus,
  BalanceSheet,
  Client,
  CsvFile,
  Dashboard,
  Expense,
  FiledGstReturn,
  GifiReport,
  GstReturn,
  ImportResult,
  IncomeStatement,
  Invoice,
  InvoiceSummary,
  JournalEntry,
  Settings,
  TrialBalance
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
    gstNumber: text(20)
      .refine((s) => s === '' || /^\d{9}\s?RT\s?\d{4}$/i.test(s), 'GST number looks like 123456789 RT0001')
      .optional(),
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
  'expenses.create': z.object({
    date,
    vendor: requiredText(150, 'Vendor'),
    description: text(500).default(''),
    accountId: id,
    amountCents: positiveCents,
    gstCents: nonNegativeCents,
    paidFromAccountId: id
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

  'import.pickCsv': none,
  'import.post': z.object({
    bankAccountId: id,
    rows: z
      .array(
        z.object({
          date,
          description: requiredText(300, 'Description'),
          amountCents: cents.refine((v) => v !== 0, 'Amount cannot be zero'),
          target: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('account'), accountId: id, gstIncluded: z.boolean() }),
            z.object({ kind: z.literal('invoice'), invoiceId: id })
          ])
        })
      )
      .min(1)
      .max(5000)
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
  'expenses.create': Expense
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
  'import.pickCsv': CsvFile | null
  'import.post': ImportResult
}

export type Output<M extends Method> = Outputs[M]

export type RpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** What the preload script exposes on `window.books`. */
export interface BooksBridge {
  platform: string
  call(method: string, input: unknown): Promise<RpcResult<unknown>>
}
