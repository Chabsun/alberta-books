/**
 * What an AI assistant can do with the books. Each tool is either "read" or
 * "write"; read-only connections only see read tools. Writes go through the
 * same services (and CRA rules, lock date and audit log) as the app itself,
 * attributed to the assistant ("ai:Grok").
 *
 * Deliberately not available to assistants: settings and the lock date,
 * issuing or voiding invoices, filing GST returns, restoring backups,
 * deleting anything, managing AI connections, and saving files to disk.
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
import { categorize, excludeTransaction, getBankTransaction, importStatement, listBankTransactions, listRules, saveRule, uncategorize } from '../services/bankFeed'
import { ccaSchedule } from '../services/cca'
import { listClients } from '../services/clients'
import { createExpense, listExpenses, previewExpense, updateExpenseDetails } from '../services/expenses'
import { getInvoice, listInvoices, saveDraft } from '../services/invoices'
import { findIssues } from '../services/issues'
import { createManualEntry, listEntriesBetween, reverseManualEntry } from '../services/ledger'
import { addReceipt } from '../services/receipts'
import { accountLedger, balanceSheet, dashboard, gstReturn, incomeStatement, trialBalance } from '../services/reports'
import { getSettings } from '../services/settings'
import { taxAdjustments } from '../services/taxAdjustments'
import { addTrip, listVehicles, vehicleBenefit, vehicleLimits } from '../services/vehicles'
import type { AiConnection } from './connections'

export interface ToolContext {
  db: Db
  receiptsDir: string
  connection: AiConnection
}

interface Tool<S extends z.ZodType = z.ZodType> {
  name: string
  title: string
  description: string
  mode: 'read' | 'write'
  input: S
  run: (input: z.output<S>, ctx: ToolContext) => unknown
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

/** `amountCents: 4250` → `amount: "42.50"`, recursively. */
export function toDollars(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(toDollars)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      if (k.endsWith('Cents') && typeof x === 'number') out[k.slice(0, -5)] = centsToPlain(x)
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
  })
]

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

export function toolsFor(mode: 'read' | 'write'): Tool[] {
  return TOOLS.filter((t) => mode === 'write' || t.mode === 'read')
}

/** MCP tool listing with JSON Schema inputs. */
export function describeTools(mode: 'read' | 'write') {
  return toolsFor(mode).map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' }),
    annotations: { readOnlyHint: t.mode === 'read', destructiveHint: false, idempotentHint: t.mode === 'read', openWorldHint: false }
  }))
}

/** Runs a tool as the connected assistant. Writes are attributed to it in the journal and audit log. */
export function callTool(name: string, args: unknown, ctx: ToolContext): unknown {
  const t = TOOL_BY_NAME.get(name)
  if (!t) throw new UserError(`Unknown tool: ${name}`)
  if (t.mode === 'write' && ctx.connection.mode !== 'write') {
    throw new UserError('This connection is read-only. You can allow changes in Alberta Books → Settings → AI assistants.')
  }
  const parsed = t.input.safeParse(args ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new UserError(`Invalid input${issue?.path.length ? ` (${issue.path.join('.')})` : ''}: ${issue?.message ?? 'check the arguments'}`)
  }
  const actor = `ai:${ctx.connection.name}`
  const result = t.mode === 'write' ? ctx.db.as(actor, () => ctx.db.tx(() => t.run(parsed.data, ctx))) : t.run(parsed.data, ctx)
  return toDollars(result)
}
