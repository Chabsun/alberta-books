/**
 * What an AI assistant can do with the books. Each tool is one of:
 *
 *   read   seen by every connection
 *   write  "Read and make changes" and "Full control": everyday bookkeeping that
 *          can be undone (categorize, record expenses, draft invoices, …)
 *   final  "Full control" only: issue and void invoices, change settings and the
 *          lock date, file GST returns, restore backups, void and delete. Unless
 *          you turned it off for that connection, the app asks you first.
 *
 * Everything goes through the same services (CRA rules, lock date, audit log)
 * as the app itself, attributed to the assistant ("ai:Grok"). Assistants can
 * never manage AI connections or write files to your computer.
 *
 * Amounts: inputs are dollar strings ("42.50"); outputs turn every
 * `...Cents` field into dollars (e.g. amountCents 4250 → amount "42.50").
 */
import { z } from 'zod'
import type { Db } from '../db/connection'
import { UserError } from '../errors'
import { addDays, fiscalYearOf, isIsoDate, todayIso } from '../../shared/dates'
import { centsToPlain, parseMoney } from '../../shared/money'
import { AUTO_LIMITS, CCA_CLASSES, receiptRequirements, TAX_RULES } from '../../shared/taxRules'
import { accountIdByRole, getAccount, listAccounts } from '../services/accounts'
import { categorize, deleteRule, excludeTransaction, getBankTransaction, importStatement, listBankTransactions, listRules, saveRule, uncategorize } from '../services/bankFeed'
import { ccaSchedule } from '../services/cca'
import { listClients } from '../services/clients'
import { createExpense, getExpense, listExpenses, previewExpense, updateExpenseDetails, voidExpense } from '../services/expenses'
import { deleteDraft, getInvoice, issueInvoice, listInvoices, recordPayment, saveDraft, voidInvoice, voidPayment } from '../services/invoices'
import { findIssues } from '../services/issues'
import { createManualEntry, listEntriesBetween, reverseManualEntry } from '../services/ledger'
import { audit } from '../services/audit'
import { addReceipt } from '../services/receipts'
import { accountLedger, balanceSheet, dashboard, fileGstReturn, gstFilings, gstReturn, incomeStatement, trialBalance } from '../services/reports'
import { getSettings, updateSettings } from '../services/settings'
import { schemas } from '../../shared/api'
import { formatMoney } from '../../shared/money'
import { taxAdjustments } from '../services/taxAdjustments'
import { addTrip, deleteTrip, listVehicles, vehicleBenefit, vehicleLimits } from '../services/vehicles'
import type { AiConnection } from './connections'

/** What only the desktop app can do (dialogs, PDF rendering, backup files). */
export interface ToolHost {
  /** Asks you in Alberta Books. Resolves true to go ahead. */
  confirm(req: { assistant: string; action: string }): Promise<boolean>
  invoicePdf(invoiceId: number): Promise<{ fileName: string; bytes: Uint8Array }>
  listBackups(): { name: string; createdAt: string; sizeBytes: number }[]
  /** Restores an automatic backup by name (the current books are backed up first). */
  restoreBackup(name: string, actor: string): void
  backup(): void
}

export interface ToolContext {
  db: Db
  receiptsDir: string
  connection: AiConnection
  host?: ToolHost
}

/** A tool result that also carries files (e.g. an invoice PDF for the assistant to attach to an email). */
export class WithFiles {
  constructor(
    readonly data: unknown,
    readonly files: { fileName: string; mime: string; bytes: Uint8Array }[]
  ) {}
}

type ToolMode = 'read' | 'write' | 'final'

interface Tool<S extends z.ZodType = z.ZodType> {
  name: string
  title: string
  description: string
  mode: ToolMode
  input: S
  /** Final tools: one sentence for the confirmation dialog. */
  confirm?: (input: z.output<S>, ctx: ToolContext) => string
  /** Restoring replaces the database, so it can't run inside a transaction. */
  noTransaction?: boolean
  run: (input: z.output<S>, ctx: ToolContext) => unknown
}

function needHost(ctx: ToolContext): ToolHost {
  if (!ctx.host) throw new UserError('This action needs the Alberta Books app to be open.')
  return ctx.host
}

const tool = <S extends z.ZodType>(t: Tool<S>): Tool => t as unknown as Tool

// ---------------------------------------------------------------- input helpers

const date = z.string().refine(isIsoDate, 'Use a date like 2026-03-31').describe('Date, YYYY-MM-DD')
const dollars = (what: string) =>
  z
    .string()
    .max(20)
    .refine((s) => parseMoney(s) !== null, 'Use an amount like 42.50')
    .describe(`${what} in dollars, e.g. "42.50"`)
const cents = (s: string) => parseMoney(s)!
const id = z.int().positive()
const account = z
  .union([z.int().positive(), z.string().regex(/^\d{3,6}$/)])
  .describe('Account id (number) or account code (string such as "5110"); see list_accounts')
const pct = z.int().min(0).max(100)

function accountId(db: Db, ref: number | string): number {
  if (typeof ref === 'number') return getAccount(db, ref).id
  const a = listAccounts(db, true).find((x) => x.code === ref)
  if (!a) throw new UserError(`No account with code ${ref}.`)
  return a.id
}

function base64(s: string, maxMb: number): Uint8Array {
  const clean = s.replace(/^data:[^,]*,/, '').replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new UserError('content_base64 is not valid base64.')
  const bytes = new Uint8Array(Buffer.from(clean, 'base64'))
  if (bytes.length === 0) throw new UserError('The file is empty.')
  if (bytes.length > maxMb * 1024 * 1024) throw new UserError(`Files can be up to ${maxMb} MB.`)
  return bytes
}

/** `amountCents: 4250` → `amount: "42.50"` (and GST `lineNNN` cents → dollars), recursively. */
export function toDollars(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(toDollars)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      if (k.endsWith('Cents') && typeof x === 'number') out[k.slice(0, -5)] = centsToPlain(x)
      // GST return lines (line101 … line109) are cents too.
      else if (/^line\d{3}$/.test(k) && typeof x === 'number') out[k] = centsToPlain(x)
      else out[k] = toDollars(x)
    }
    return out
  }
  return v
}

const fyEnd = (db: Db, d?: string) => fiscalYearOf(d ?? todayIso(), getSettings(db).fiscalYearEndMonth).end

// ---------------------------------------------------------------- read tools

const expenseFields = {
  date,
  vendor: z.string().trim().min(1).max(150),
  description: z.string().max(500).default(''),
  category: account.describe('Expense category: account id or code (see list_accounts; each has a CRA rule)'),
  amount: dollars('Amount before GST'),
  gst: dollars('GST shown on the receipt (use "0.00" if none)'),
  paid_from: account.describe('Bank or credit card account that paid, or the shareholder loan account if paid personally'),
  business_pct: pct.optional().describe('Business-use % (default 100). Personal share goes to the shareholder loan.'),
  supplier_gst_number: z.string().max(20).optional().describe('Supplier GST/HST number, required by CRA to claim GST on purchases of $100 or more'),
  purpose: z.string().max(500).optional().describe('Business purpose (required for meals, entertainment, travel)'),
  attendees: z.string().max(500).optional().describe('Who attended (meals and entertainment)'),
  vehicle_id: id.optional().describe('Company vehicle, for vehicle costs'),
  primarily_business: z.boolean().optional().describe('Vehicle purchases: used more than 50% for business')
}

function expenseInput(db: Db, i: z.output<z.ZodObject<typeof expenseFields>>) {
  return {
    date: i.date,
    vendor: i.vendor,
    description: i.description,
    accountId: accountId(db, i.category),
    amountCents: cents(i.amount),
    gstCents: cents(i.gst),
    paidFromAccountId: accountId(db, i.paid_from),
    businessPct: i.business_pct,
    supplierGstNumber: i.supplier_gst_number,
    purpose: i.purpose,
    attendees: i.attendees,
    vehicleId: i.vehicle_id ?? null,
    primarilyBusiness: i.primarily_business
  }
}

export const TOOLS: Tool[] = [
  tool({
    name: 'get_overview',
    title: 'Company overview',
    mode: 'read',
    description:
      'Start here. Company details (Alberta corporation: GST 5%, no PST), fiscal year, this year’s income and expenses, bank balances, money owed, open items to fix, and whether this connection may make changes.',
    input: z.object({}),
    run: (_i, { db, connection }) => {
      const s = getSettings(db)
      const fy = fiscalYearOf(todayIso(), s.fiscalYearEndMonth)
      return {
        today: todayIso(),
        company: { name: s.companyName, gstNumber: s.gstNumber, province: 'Alberta', gstRate: '5%', pst: 'none' },
        fiscalYear: fy,
        lockDate: s.lockDate,
        access: connection.mode === 'write' ? 'read and write' : 'read only',
        dashboard: dashboard(db, null),
        openItems: findIssues(db).map((i) => `[${i.severity}] ${i.message}`)
      }
    }
  }),
  tool({
    name: 'get_cra_expense_rules',
    title: 'CRA expense rules',
    mode: 'read',
    description:
      'Every CRA rule this app applies to expenses: % deductible, % of GST claimable (ITC), what CRA requires on receipts, capital cost allowance classes, and vehicle limits. Read before categorizing expenses.',
    input: z.object({}),
    run: () => ({
      rules: Object.values(TAX_RULES),
      ccaClasses: Object.values(CCA_CLASSES),
      vehicleLimitsByYear: AUTO_LIMITS,
      receiptRequirements: {
        under100: receiptRequirements(50_00),
        from100to500: receiptRequirements(200_00),
        over500: receiptRequirements(600_00)
      },
      general: [
        'An expense is deductible only if it was incurred to earn business income and is reasonable (ITA s.18(1)(a), s.67).',
        'Personal expenses paid by the corporation are not deductible: record a business-use % so the personal share goes to the shareholder loan.',
        'Equipment, computers, furniture and vehicles are capital assets (CCA), not expenses.',
        'Keep receipts six years from the end of the tax year they relate to.',
        'Meals and entertainment: 50% deductible and 50% of the GST claimable; record purpose and attendees.'
      ]
    })
  }),
  tool({
    name: 'list_accounts',
    title: 'Chart of accounts',
    mode: 'read',
    description: 'All accounts with code, type, GIFI code, balance, and the CRA rule attached to each expense category.',
    input: z.object({ include_archived: z.boolean().optional() }),
    run: (i, { db }) =>
      listAccounts(db, i.include_archived ?? false).map((a) => ({ ...a, craRule: a.taxRule ? TAX_RULES[a.taxRule as keyof typeof TAX_RULES]?.label : null }))
  }),
  tool({
    name: 'list_bank_transactions',
    title: 'Bank feed',
    mode: 'read',
    description: 'Imported bank and credit card transactions. status "unreviewed" is the queue still to categorize; each has a suggested category. Positive amounts are money in.',
    input: z.object({
      status: z.enum(['unreviewed', 'posted', 'excluded']).optional(),
      search: z.string().max(100).optional(),
      from: date.optional(),
      to: date.optional(),
      limit: z.int().min(1).max(500).default(100)
    }),
    run: (i, { db }) => listBankTransactions(db, i)
  }),
  tool({
    name: 'list_bank_rules',
    title: 'Bank rules',
    mode: 'read',
    description: 'Rules that categorize bank transactions automatically by matching text.',
    input: z.object({}),
    run: (_i, { db }) => listRules(db)
  }),
  tool({
    name: 'list_expenses',
    title: 'Expenses',
    mode: 'read',
    description: 'Expenses with GST claimed, non-deductible share, CRA rule and what CRA would still ask for (warnings).',
    input: z.object({ from: date.optional(), to: date.optional(), search: z.string().max(100).optional(), limit: z.int().min(1).max(1000).default(200) }),
    run: (i, { db }) => {
      const q = i.search?.toLowerCase()
      return listExpenses(db)
        .filter((x) => (!i.from || x.date >= i.from) && (!i.to || x.date <= i.to) && (!q || `${x.vendor} ${x.description}`.toLowerCase().includes(q)))
        .slice(0, i.limit)
    }
  }),
  tool({
    name: 'preview_expense',
    title: 'Preview expense treatment',
    mode: 'read',
    description: 'Shows how CRA rules would treat an expense (deductible cost, GST claimable, personal share, capital asset) without saving anything.',
    input: z.object(expenseFields),
    run: (i, { db }) => previewExpense(db, expenseInput(db, i))
  }),
  tool({
    name: 'list_invoices',
    title: 'Invoices',
    mode: 'read',
    description: 'Sales invoices with status (draft, open, partial, overdue, paid, void) and balance due.',
    input: z.object({ status: z.enum(['draft', 'open', 'partial', 'overdue', 'paid', 'void']).optional() }),
    run: (i, { db }) => listInvoices(db).filter((x) => !i.status || x.displayStatus === i.status)
  }),
  tool({
    name: 'list_clients',
    title: 'Clients',
    mode: 'read',
    description: 'Clients the corporation invoices.',
    input: z.object({}),
    run: (_i, { db }) => listClients(db)
  }),
  tool({
    name: 'get_report',
    title: 'Financial report',
    mode: 'read',
    description:
      'Financial reports. income_statement and gst_return need from/to; balance_sheet and trial_balance need as_of; tax_adjustments (Schedule 1 estimate) and cca_schedule (Schedule 8) need fiscal_year_end. Dates default to the current fiscal year.',
    input: z.object({
      report: z.enum(['income_statement', 'balance_sheet', 'trial_balance', 'gst_return', 'tax_adjustments', 'cca_schedule']),
      from: date.optional(),
      to: date.optional(),
      as_of: date.optional(),
      fiscal_year_end: date.optional()
    }),
    run: (i, { db }) => {
      const fy = fiscalYearOf(todayIso(), getSettings(db).fiscalYearEndMonth)
      const from = i.from ?? fy.start
      const to = i.to ?? todayIso()
      switch (i.report) {
        case 'income_statement':
          return incomeStatement(db, from, to)
        case 'gst_return':
          return gstReturn(db, from, to)
        case 'balance_sheet':
          return balanceSheet(db, i.as_of ?? todayIso())
        case 'trial_balance':
          return trialBalance(db, i.as_of ?? todayIso())
        case 'tax_adjustments':
          return taxAdjustments(db, fyEnd(db, i.fiscal_year_end))
        case 'cca_schedule':
          return ccaSchedule(db, fyEnd(db, i.fiscal_year_end))
      }
    }
  }),
  tool({
    name: 'get_account_ledger',
    title: 'Account ledger',
    mode: 'read',
    description: 'Every posting to one account between two dates, with running balance.',
    input: z.object({ account, from: date, to: date }),
    run: (i, { db }) => accountLedger(db, accountId(db, i.account), i.from, i.to)
  }),
  tool({
    name: 'list_journal_entries',
    title: 'Journal',
    mode: 'read',
    description: 'Journal entries (all postings) between two dates, at most 92 days at a time.',
    input: z.object({ from: date, to: date }),
    run: (i, { db }) => {
      if (i.to < i.from || addDays(i.from, 92) < i.to) throw new UserError('Use a range of at most 92 days.')
      return listEntriesBetween(db, i.from, i.to)
    }
  }),
  tool({
    name: 'find_issues',
    title: 'Open items',
    mode: 'read',
    description: 'Mistakes, missing CRA paperwork (GST numbers, purposes, receipts), possible personal expenses and coming deadlines (GST, T5, T2).',
    input: z.object({}),
    run: (_i, { db }) => findIssues(db)
  }),
  tool({
    name: 'get_vehicle_summary',
    title: 'Company vehicle',
    mode: 'read',
    description:
      'Company vehicles, and for one vehicle: the shareholder’s taxable benefit for a calendar year (standby charge, operating benefit, GST to remit) and the CRA lease/interest caps for a fiscal year.',
    input: z.object({ vehicle_id: id.optional(), year: z.int().min(2000).max(2100).optional(), fiscal_year_end: date.optional() }),
    run: (i, { db }) => {
      const vehicles = listVehicles(db)
      if (!i.vehicle_id) return { vehicles }
      const year = i.year ?? Number(todayIso().slice(0, 4))
      return { vehicles, benefit: vehicleBenefit(db, i.vehicle_id, year), limits: vehicleLimits(db, i.vehicle_id, fyEnd(db, i.fiscal_year_end)) }
    }
  }),

  // ---------------------------------------------------------------- write tools

  tool({
    name: 'categorize_bank_transaction',
    title: 'Categorize bank transaction',
    mode: 'write',
    description:
      'Posts an unreviewed bank transaction. Give an account (expense category, income, another bank account for a transfer, or the shareholder loan), or an invoice_id for a client payment. CRA rules of the category apply (e.g. meals 50%). Set remember=true to categorize this payee the same way next time.',
    input: z.object({
      id,
      account: account.optional(),
      invoice_id: id.optional(),
      gst_included: z.boolean().optional().describe('The amount includes 5% GST to split out (default true for expenses)'),
      business_pct: pct.optional(),
      purpose: z.string().max(500).optional(),
      attendees: z.string().max(500).optional(),
      supplier_gst_number: z.string().max(20).optional(),
      memo: z.string().max(300).optional(),
      remember: z.boolean().default(false)
    }),
    run: (i, { db }) => {
      if ((i.account === undefined) === (i.invoice_id === undefined)) throw new UserError('Give either account or invoice_id.')
      const target =
        i.invoice_id !== undefined
          ? { kind: 'invoice' as const, invoiceId: i.invoice_id }
          : {
              kind: 'account' as const,
              accountId: accountId(db, i.account!),
              gstIncluded: i.gst_included,
              businessPct: i.business_pct,
              purpose: i.purpose,
              attendees: i.attendees,
              supplierGstNumber: i.supplier_gst_number,
              memo: i.memo
            }
      return categorize(db, i.id, target, i.remember)
    }
  }),
  tool({
    name: 'exclude_bank_transaction',
    title: 'Exclude bank transaction',
    mode: 'write',
    description: 'Marks an unreviewed bank transaction as not for the books (e.g. a duplicate). Nothing is posted.',
    input: z.object({ id, reason: z.string().max(200).default('') }),
    run: (i, { db }) => excludeTransaction(db, i.id, i.reason)
  }),
  tool({
    name: 'undo_bank_categorization',
    title: 'Undo categorization',
    mode: 'write',
    description: 'Puts a categorized bank transaction back in the queue by posting a reversal (nothing is deleted).',
    input: z.object({ id }),
    run: (i, { db }) => uncategorize(db, i.id)
  }),
  tool({
    name: 'create_bank_rule',
    title: 'Create bank rule',
    mode: 'write',
    description: 'Categorizes future bank transactions whose description matches the text. auto_post=true posts them without review.',
    input: z.object({
      pattern: z.string().trim().min(2).max(100),
      match_type: z.enum(['contains', 'equals', 'starts']).default('contains'),
      direction: z.enum(['any', 'in', 'out']).default('any'),
      account,
      gst_included: z.boolean().default(true),
      business_pct: pct.default(100),
      auto_post: z.boolean().default(false)
    }),
    run: (i, { db }) =>
      saveRule(db, {
        pattern: i.pattern,
        matchType: i.match_type,
        direction: i.direction,
        accountId: accountId(db, i.account),
        gstIncluded: i.gst_included,
        businessPct: i.business_pct,
        autoPost: i.auto_post
      })
  }),
  tool({
    name: 'import_bank_statement',
    title: 'Import bank statement',
    mode: 'write',
    description:
      'Imports a bank or credit card statement into the review queue (duplicates are skipped). Pass the file content: OFX/QFX/QBO or CSV text in `content`, or the raw file in `content_base64`.',
    input: z.object({
      bank_account: account.describe('The bank or credit card account the statement is for'),
      file_name: z.string().trim().min(1).max(200).describe('Original file name, e.g. "statement.qbo" or "visa.csv"'),
      content: z.string().max(10_000_000).optional(),
      content_base64: z.string().max(14_000_000).optional()
    }),
    run: (i, { db }) => {
      const bytes = i.content !== undefined ? new TextEncoder().encode(i.content) : i.content_base64 !== undefined ? base64(i.content_base64, 10) : null
      if (!bytes?.length) throw new UserError('Pass the statement in content or content_base64.')
      return importStatement(db, { bankAccountId: accountId(db, i.bank_account), fileName: i.file_name, bytes })
    }
  }),
  tool({
    name: 'create_expense',
    title: 'Record expense',
    mode: 'write',
    description:
      'Records an expense from a receipt (not for transactions already in the bank feed: categorize those instead). CRA rules of the category apply. Use preview_expense first if unsure.',
    input: z.object(expenseFields),
    run: (i, { db }) => createExpense(db, expenseInput(db, i))
  }),
  tool({
    name: 'update_expense_details',
    title: 'Add receipt details',
    mode: 'write',
    description: 'Adds what CRA asks for to an existing expense: supplier GST number, business purpose, attendees, description. Amounts never change.',
    input: z.object({
      id,
      supplier_gst_number: z.string().max(20).optional(),
      purpose: z.string().max(500).optional(),
      attendees: z.string().max(500).optional(),
      description: z.string().max(500).optional()
    }),
    run: (i, { db }) =>
      updateExpenseDetails(db, i.id, { supplierGstNumber: i.supplier_gst_number, purpose: i.purpose, attendees: i.attendees, description: i.description })
  }),
  tool({
    name: 'attach_receipt',
    title: 'Attach receipt',
    mode: 'write',
    description: 'Attaches a receipt (PDF or photo: JPG, PNG, WEBP, HEIC, up to 15 MB) to an expense or bank transaction.',
    input: z.object({
      expense_id: id.optional(),
      bank_transaction_id: id.optional(),
      file_name: z.string().trim().min(1).max(150),
      content_base64: z.string().max(21_000_000)
    }),
    run: (i, { db, receiptsDir }) => {
      if (!i.expense_id && !i.bank_transaction_id) throw new UserError('Give expense_id or bank_transaction_id.')
      if (i.bank_transaction_id) getBankTransaction(db, i.bank_transaction_id)
      return addReceipt(db, receiptsDir, {
        fileName: i.file_name,
        bytes: base64(i.content_base64, 15),
        expenseId: i.expense_id ?? null,
        bankTransactionId: i.bank_transaction_id ?? null
      })
    }
  }),
  tool({
    name: 'add_vehicle_trip',
    title: 'Log vehicle trip',
    mode: 'write',
    description: 'Adds a logbook line for a company vehicle. CRA requires the purpose of each business trip.',
    input: z.object({
      vehicle_id: id,
      date,
      km: z.int().min(1).max(100_000),
      kind: z.enum(['business', 'personal']),
      purpose: z.string().max(300).optional(),
      route: z.string().max(300).optional()
    }),
    run: (i, { db }) => addTrip(db, { vehicleId: i.vehicle_id, date: i.date, km: i.km, kind: i.kind, purpose: i.purpose, route: i.route })
  }),
  tool({
    name: 'create_invoice_draft',
    title: 'Draft invoice',
    mode: 'write',
    description: 'Creates a draft invoice for a client (GST 5% on taxable lines). Only you can issue it from the app.',
    input: z.object({
      client_id: id,
      issue_date: date,
      due_date: date.optional(),
      notes: z.string().max(2000).default(''),
      lines: z
        .array(
          z.object({
            description: z.string().trim().min(1).max(500),
            quantity: z.number().positive().max(1_000_000).default(1),
            unit_price: dollars('Price per unit before GST'),
            taxable: z.boolean().default(true)
          })
        )
        .min(1)
        .max(100)
    }),
    run: (i, { db }) => {
      const terms = getSettings(db).paymentTermsDays
      const inv = saveDraft(db, {
        clientId: i.client_id,
        issueDate: i.issue_date,
        dueDate: i.due_date ?? addDays(i.issue_date, terms),
        notes: i.notes,
        lines: i.lines.map((l) => ({
          description: l.description,
          qtyMilli: Math.round(l.quantity * 1000),
          unitPriceCents: cents(l.unit_price),
          taxable: l.taxable,
          accountId: accountIdByRole(db, 'sales')
        }))
      })
      return getInvoice(db, inv.id)
    }
  }),
  tool({
    name: 'create_journal_entry',
    title: 'Journal entry',
    mode: 'write',
    description:
      'Posts a manual journal entry (debits must equal credits). For adjustments, accruals, dividends declared, shareholder loan movements. Prefer the other tools for bank transactions and expenses.',
    input: z.object({
      date,
      memo: z.string().trim().min(1).max(300),
      lines: z
        .array(
          z.object({
            account,
            debit: dollars('Debit').default('0'),
            credit: dollars('Credit').default('0'),
            memo: z.string().max(200).default('')
          })
        )
        .min(2)
        .max(50)
    }),
    run: (i, { db }) =>
      createManualEntry(db, {
        date: i.date,
        memo: i.memo,
        lines: i.lines.map((l) => ({ accountId: accountId(db, l.account), debitCents: cents(l.debit), creditCents: cents(l.credit), memo: l.memo }))
      })
  }),
  tool({
    name: 'reverse_journal_entry',
    title: 'Reverse journal entry',
    mode: 'write',
    description: 'Reverses a manual journal entry by posting the opposite entry (nothing is deleted).',
    input: z.object({ id, date: date.optional() }),
    run: (i, { db }) => reverseManualEntry(db, i.id, i.date ?? todayIso())
  }),

  // ---------------------------------------------------------------- final tools (Full control)

  tool({
    name: 'record_invoice_payment',
    title: 'Record invoice payment',
    mode: 'write',
    description: 'Records a client payment on an issued invoice (for payments not in the bank feed; for bank deposits use categorize_bank_transaction with invoice_id).',
    input: z.object({ invoice_id: id, date, amount: dollars('Amount received'), account: account.describe('Bank account the money went to') }),
    run: (i, { db }) => recordPayment(db, { invoiceId: i.invoice_id, date: i.date, amountCents: cents(i.amount), accountId: accountId(db, i.account) })
  }),
  tool({
    name: 'issue_invoice',
    title: 'Issue invoice',
    mode: 'final',
    description:
      'Issues a draft invoice: it gets its final number, is posted to the books and can no longer be edited (only voided). Returns the invoice and its PDF, which you can attach to an email to the client.',
    input: z.object({ id }),
    confirm: (i, { db }) => {
      const inv = getInvoice(db, i.id)
      return `Issue invoice to ${inv.clientName} for ${formatMoney(inv.totalCents)} (it becomes final)`
    },
    run: async (i, ctx) => {
      const inv = issueInvoice(ctx.db, i.id)
      audit(ctx.db, 'issue', 'invoice', inv.id, `${inv.number} to ${inv.clientName}, ${formatMoney(inv.totalCents)}`)
      if (!ctx.host) return inv
      try {
        const pdf = await ctx.host.invoicePdf(inv.id)
        return new WithFiles(inv, [{ fileName: pdf.fileName, mime: 'application/pdf', bytes: pdf.bytes }])
      } catch {
        // The invoice is issued either way; the PDF can be fetched again with get_invoice_pdf.
        return inv
      }
    }
  }),
  tool({
    name: 'get_invoice_pdf',
    title: 'Invoice PDF',
    mode: 'read',
    description: 'Returns an invoice as a PDF file (to attach to an email or show the user).',
    input: z.object({ id }),
    run: async (i, ctx) => {
      const inv = getInvoice(ctx.db, i.id)
      const pdf = await needHost(ctx).invoicePdf(inv.id)
      return new WithFiles({ invoice: inv.number ?? `Draft ${inv.id}`, fileName: pdf.fileName }, [{ fileName: pdf.fileName, mime: 'application/pdf', bytes: pdf.bytes }])
    }
  }),
  tool({
    name: 'void_invoice',
    title: 'Void invoice',
    mode: 'final',
    description: 'Voids an issued invoice by posting a reversal on the given date. The invoice number stays used, marked void.',
    input: z.object({ id, date: date.optional() }),
    confirm: (i, { db }) => {
      const inv = getInvoice(db, i.id)
      return `Void invoice ${inv.number} to ${inv.clientName} (${formatMoney(inv.totalCents)})`
    },
    run: (i, { db }) => voidInvoice(db, i.id, i.date ?? todayIso())
  }),
  tool({
    name: 'void_invoice_payment',
    title: 'Void payment',
    mode: 'final',
    description: 'Voids a recorded client payment (posts a reversal).',
    input: z.object({ payment_id: id, date: date.optional() }),
    confirm: (i) => `Void client payment #${i.payment_id}`,
    run: (i, { db }) => voidPayment(db, i.payment_id, i.date ?? todayIso())
  }),
  tool({
    name: 'delete_invoice_draft',
    title: 'Delete draft invoice',
    mode: 'final',
    description: 'Deletes a draft invoice (issued invoices can only be voided).',
    input: z.object({ id }),
    confirm: (i, { db }) => {
      const inv = getInvoice(db, i.id)
      return `Delete the draft invoice for ${inv.clientName} (${formatMoney(inv.totalCents)})`
    },
    run: (i, { db }) => {
      const inv = getInvoice(db, i.id)
      deleteDraft(db, i.id)
      audit(db, 'delete', 'invoice_draft', i.id, `Draft for ${inv.clientName}, ${formatMoney(inv.totalCents)}`)
      return { deleted: true }
    }
  }),
  tool({
    name: 'void_expense',
    title: 'Void expense',
    mode: 'final',
    description: 'Voids an expense by posting a reversal. For expenses from the bank feed, use undo_bank_categorization instead.',
    input: z.object({ id, date: date.optional() }),
    confirm: (i, { db }) => {
      const x = getExpense(db, i.id)
      return `Void the expense from ${x.vendor} on ${x.date} (${formatMoney(x.totalCents)})`
    },
    run: (i, { db }) => voidExpense(db, i.id, i.date ?? todayIso())
  }),
  tool({
    name: 'delete_bank_rule',
    title: 'Delete bank rule',
    mode: 'final',
    description: 'Deletes a bank rule (see list_bank_rules). Transactions it already categorized stay as they are.',
    input: z.object({ id }),
    confirm: (i, { db }) => `Delete the bank rule “${listRules(db).find((r) => r.id === i.id)?.pattern ?? i.id}”`,
    run: (i, { db }) => {
      deleteRule(db, i.id)
      return { deleted: true }
    }
  }),
  tool({
    name: 'delete_vehicle_trip',
    title: 'Delete logbook trip',
    mode: 'final',
    description: 'Deletes a vehicle logbook line.',
    input: z.object({ id }),
    confirm: (i) => `Delete logbook trip #${i.id}`,
    run: (i, { db }) => {
      deleteTrip(db, i.id)
      return { deleted: true }
    }
  }),
  tool({
    name: 'update_settings',
    title: 'Change settings',
    mode: 'final',
    description:
      'Changes company settings: companyName, address, email, phone, gstNumber, fiscalYearEndMonth (1-12), invoicePrefix, nextInvoiceNumber, paymentTermsDays, invoiceFooter, lockDate (YYYY-MM-DD or null; nothing on or before it can be changed). Only the fields you pass change.',
    input: schemas['settings.update'],
    confirm: (i) => `Change settings: ${Object.entries(i).filter(([, v]) => v !== undefined).map(([k, v]) => `${k} → ${v === null ? 'none' : String(v)}`).join(', ')}`,
    run: (i, { db }) => {
      const changed = Object.entries(i).filter(([, v]) => v !== undefined)
      const result = updateSettings(db, i)
      audit(db, 'update', 'settings', null, changed.map(([k, v]) => `${k}: ${v === null ? 'none' : String(v)}`).join(', '))
      return result
    }
  }),
  tool({
    name: 'file_gst_return',
    title: 'File GST return',
    mode: 'final',
    description:
      'Marks the GST return for a period as filed: posts the closing entry (GST owing or refund) and locks that period from changes. Do this after the return is submitted to CRA. Check it first with get_report report=gst_return.',
    input: z.object({ from: date, to: date }),
    confirm: (i, { db }) => {
      const g = gstReturn(db, i.from, i.to)
      return `File the GST return for ${i.from} to ${i.to}: net tax ${formatMoney(g.line109)} (this locks the period)`
    },
    run: (i, ctx) => {
      if (i.to < i.from) throw new UserError('The start date must be on or before the end date.')
      const r = fileGstReturn(ctx.db, i.from, i.to)
      return r
    }
  }),
  tool({
    name: 'list_gst_filings',
    title: 'Filed GST returns',
    mode: 'read',
    description: 'GST returns already marked as filed.',
    input: z.object({}),
    run: (_i, { db }) => gstFilings(db)
  }),
  tool({
    name: 'list_backups',
    title: 'Backups',
    mode: 'read',
    description: 'Automatic backups of the books, newest first.',
    input: z.object({}),
    run: (_i, ctx) => needHost(ctx).listBackups().slice(0, 60)
  }),
  tool({
    name: 'restore_backup',
    title: 'Restore backup',
    mode: 'final',
    noTransaction: true,
    description:
      'Replaces the books with an automatic backup (by name from list_backups). The current books are backed up first, so this can be undone by restoring that copy.',
    input: z.object({ name: z.string().regex(/^alberta-books-\d{4}-\d{2}-\d{2}_\d{6}(-\d+)?\.db$/, 'Use a name from list_backups') }),
    confirm: (i) => `Restore the backup “${i.name}” (your current books are backed up first)`,
    run: (i, ctx) => {
      const host = needHost(ctx)
      if (!host.listBackups().some((b) => b.name === i.name)) throw new UserError('No backup with that name. Use list_backups.')
      host.restoreBackup(i.name, `ai:${ctx.connection.name}`)
      return { restored: i.name }
    }
  })
]

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

const VISIBLE: Record<'read' | 'write' | 'full', ToolMode[]> = { read: ['read'], write: ['read', 'write'], full: ['read', 'write', 'final'] }

export function toolsFor(mode: 'read' | 'write' | 'full'): Tool[] {
  return TOOLS.filter((t) => VISIBLE[mode].includes(t.mode))
}

/** MCP tool listing with JSON Schema inputs. */
export function describeTools(mode: 'read' | 'write' | 'full') {
  return toolsFor(mode).map((t) => ({
    name: t.name,
    title: t.title,
    description: t.mode === 'final' ? `${t.description} (Final action: only when the user asks for it.)` : t.description,
    inputSchema: z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' }),
    annotations: { readOnlyHint: t.mode === 'read', destructiveHint: t.mode === 'final', idempotentHint: t.mode === 'read', openWorldHint: false }
  }))
}

/**
 * Runs a tool as the connected assistant. Changes are attributed to it in the
 * journal and audit log. Final actions are asked about in the app first
 * unless you turned that off for this connection.
 */
export async function callTool(name: string, args: unknown, ctx: ToolContext): Promise<{ data: unknown; files: WithFiles['files'] }> {
  const t = TOOL_BY_NAME.get(name)
  if (!t) throw new UserError(`Unknown tool: ${name}`)
  if (!VISIBLE[ctx.connection.mode].includes(t.mode)) {
    throw new UserError(
      t.mode === 'final'
        ? 'This needs “Full control”. You can give it in Alberta Books → AI assistants.'
        : 'This connection is read-only. You can allow changes in Alberta Books → AI assistants.'
    )
  }
  const parsed = t.input.safeParse(args ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new UserError(`Invalid input${issue?.path.length ? ` (${issue.path.join('.')})` : ''}: ${issue?.message ?? 'check the arguments'}`)
  }
  const actor = `ai:${ctx.connection.name}`
  if (t.mode === 'final' && ctx.connection.confirmFinal) {
    const action = t.confirm ? t.confirm(parsed.data, ctx) : t.title
    const ok = await needHost(ctx).confirm({ assistant: ctx.connection.name, action })
    if (!ok) throw new UserError('Declined in Alberta Books. Nothing was changed.')
  }
  let result: unknown
  if (t.mode === 'read') result = await t.run(parsed.data, ctx)
  else if (t.noTransaction) result = await ctx.db.as(actor, () => t.run(parsed.data, ctx))
  else {
    // Services are synchronous: the change commits inside the transaction; only a PDF may be awaited after.
    const db = ctx.db
    const pending = db.as(actor, () => db.tx(() => t.run(parsed.data, ctx)))
    result = await pending
  }
  if (t.mode === 'final' && t.name === 'file_gst_return') ctx.host?.backup()
  return result instanceof WithFiles ? { data: toDollars(result.data), files: result.files } : { data: toDollars(result), files: [] }
}
