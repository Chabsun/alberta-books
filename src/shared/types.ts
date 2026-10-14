/** Domain types shared by the main process and the UI. All money is integer cents. */

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense'

export const ACCOUNT_TYPES: AccountType[] = ['asset', 'liability', 'equity', 'income', 'expense']

export type AccountRole =
  | 'bank'
  | 'ar'
  | 'gst_collected'
  | 'gst_itc'
  | 'gst_owing'
  | 'shareholder_loan'
  | 'share_capital'
  | 'retained_earnings'
  | 'dividends'
  | 'sales'

export interface Account {
  id: number
  code: string
  name: string
  type: AccountType
  gifiCode: string | null
  role: AccountRole | null
  isBank: boolean
  archived: boolean
  /** Balance in the account's normal direction (debit for assets/expenses, credit otherwise). */
  balanceCents: number
  hasActivity: boolean
}

export interface Settings {
  companyName: string
  address: string
  email: string
  phone: string
  gstNumber: string
  fiscalYearEndMonth: number
  invoicePrefix: string
  nextInvoiceNumber: number
  paymentTermsDays: number
  invoiceFooter: string
  lockDate: string | null
  backupDir: string | null
}

export interface Client {
  id: number
  name: string
  email: string
  phone: string
  address: string
  archived: boolean
  balanceCents: number
}

export type InvoiceStatus = 'draft' | 'issued' | 'void'
export type InvoiceDisplayStatus = 'draft' | 'open' | 'partial' | 'overdue' | 'paid' | 'void'

export interface InvoiceLine {
  id: number
  description: string
  qtyMilli: number
  unitPriceCents: number
  amountCents: number
  taxable: boolean
  accountId: number
}

export interface Payment {
  id: number
  invoiceId: number
  date: string
  amountCents: number
  accountId: number
  accountName: string
  voided: boolean
}

export interface InvoiceSummary {
  id: number
  number: string | null
  clientId: number
  clientName: string
  issueDate: string
  dueDate: string
  status: InvoiceStatus
  displayStatus: InvoiceDisplayStatus
  subtotalCents: number
  gstCents: number
  totalCents: number
  paidCents: number
  balanceCents: number
}

export interface Invoice extends InvoiceSummary {
  notes: string
  gstRateBps: number
  lines: InvoiceLine[]
  payments: Payment[]
}

export interface Expense {
  id: number
  date: string
  vendor: string
  description: string
  accountId: number
  accountName: string
  amountCents: number
  gstCents: number
  totalCents: number
  paidFromAccountId: number
  paidFromName: string
  voided: boolean
  entryId: number
}

export type EntrySource = 'manual' | 'invoice' | 'payment' | 'expense' | 'gst_return' | 'import' | 'reversal'

export interface JournalLine {
  accountId: number
  accountCode: string
  accountName: string
  debitCents: number
  creditCents: number
  memo: string
}

export interface JournalEntry {
  id: number
  date: string
  memo: string
  source: EntrySource
  reversesId: number | null
  reversedById: number | null
  totalCents: number
  lines: JournalLine[]
}

export interface ReportRow {
  accountId: number
  code: string
  name: string
  gifiCode: string | null
  amountCents: number
}

export interface IncomeStatement {
  from: string
  to: string
  income: ReportRow[]
  expenses: ReportRow[]
  totalIncomeCents: number
  totalExpensesCents: number
  netIncomeCents: number
}

export interface BalanceSheet {
  asOf: string
  fiscalYearStart: string
  assets: ReportRow[]
  liabilities: ReportRow[]
  equity: ReportRow[]
  totalAssetsCents: number
  totalLiabilitiesCents: number
  totalEquityCents: number
  /** True when assets = liabilities + equity (always expected; shown as a health check). */
  balanced: boolean
}

export interface TrialBalanceRow {
  accountId: number
  code: string
  name: string
  type: AccountType
  debitCents: number
  creditCents: number
}

export interface TrialBalance {
  asOf: string
  rows: TrialBalanceRow[]
  totalDebitCents: number
  totalCreditCents: number
}

export interface GstReturn {
  from: string
  to: string
  /** Line 101: sales and other revenue (excluding GST). */
  line101: number
  /** Line 105: total GST collected (lines 103 + 104). */
  line105: number
  /** Line 108: total ITCs (lines 106 + 107). */
  line108: number
  /** Line 109: net tax. Positive = owing to CRA, negative = refund. */
  line109: number
  filed: { id: number; filedAt: string } | null
  /** True when the period overlaps a locked (already filed) period. */
  locked: boolean
}

export interface FiledGstReturn {
  id: number
  periodStart: string
  periodEnd: string
  line109: number
  filedAt: string
}

export interface LedgerRow {
  entryId: number
  date: string
  memo: string
  source: EntrySource
  debitCents: number
  creditCents: number
  runningBalanceCents: number
}

export interface AccountLedger {
  account: Account
  from: string
  to: string
  openingBalanceCents: number
  rows: LedgerRow[]
  closingBalanceCents: number
}

export interface GifiLine {
  gifiCode: string
  description: string
  amountCents: number
}

export interface GifiReport {
  fiscalYearStart: string
  fiscalYearEnd: string
  schedule100: GifiLine[]
  schedule125: GifiLine[]
  unmapped: string[]
}

export interface Dashboard {
  today: string
  fiscalYearStart: string
  cashCents: number
  receivableCents: number
  overdueCents: number
  overdueCount: number
  gstOwingCents: number
  netIncomeYtdCents: number
  revenueYtdCents: number
  expensesYtdCents: number
  /** Positive: the company owes you. Negative: you owe the company. */
  shareholderLoanCents: number
  monthly: { month: string; incomeCents: number; expenseCents: number }[]
  openInvoices: InvoiceSummary[]
  recentEntries: JournalEntry[]
  lastBackupAt: string | null
}

export interface BackupInfo {
  name: string
  createdAt: string
  sizeBytes: number
}

export interface BackupStatus {
  databasePath: string
  autoBackupDir: string
  extraBackupDir: string | null
  backups: BackupInfo[]
}

export interface CsvFile {
  fileName: string
  headers: string[]
  rows: string[][]
}

export interface ImportResult {
  posted: number
  skippedDuplicates: number
}
