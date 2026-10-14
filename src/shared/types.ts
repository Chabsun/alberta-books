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
  /** CRA rule id (see shared/taxRules.ts); expense and capital accounts only. */
  taxRule: string | null
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
  /** Pre-tax amount on the receipt. */
  amountCents: number
  /** GST shown on the receipt. */
  gstCents: number
  /** GST claimed back (input tax credit) after the CRA rule. */
  itcCents: number
  totalCents: number
  businessPct: number
  /** Not deductible for income tax (added back on Schedule 1). */
  nonDeductibleCents: number
  taxRule: string | null
  supplierGstNumber: string
  purpose: string
  attendees: string
  vehicleId: number | null
  paidFromAccountId: number
  paidFromName: string
  voided: boolean
  entryId: number
  receiptCount: number
  /** What CRA would still ask for (GST number, purpose, attendees, receipt). */
  warnings: string[]
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
  /** 'user', 'import', 'system' or 'ai:<name>'. */
  actor: string
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
  /** Line 103: GST collected. */
  line103: number
  /** Line 104: adjustments added to tax (vehicle benefit GST, lease ITC repayment). */
  line104: number
  /** Line 105: total GST collected (lines 103 + 104). */
  line105: number
  /** Line 106: input tax credits. */
  line106: number
  /** Line 108: total ITCs (lines 106 + 107). */
  line108: number
  adjustments: { label: string; amountCents: number }[]
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

// ---------------------------------------------------------------- vehicles, CCA, tax

export interface Vehicle {
  id: number
  name: string
  ownership: 'owned' | 'leased'
  startDate: string
  endDate: string | null
  /** Purchase price before tax (owned). */
  costCents: number
  /** Manufacturer's list price before tax (leased; for the lease cap). */
  msrpCents: number
  /** Monthly lease payment before tax (leased). */
  monthlyLeaseCents: number
  zeroEmission: boolean
  notes: string
  archived: boolean
}

export interface VehicleTrip {
  id: number
  vehicleId: number
  date: string
  km: number
  kind: 'business' | 'personal'
  purpose: string
  route: string
}

export interface VehicleBenefit {
  vehicleId: number
  year: number
  daysAvailable: number
  monthsAvailable: number
  businessKm: number
  personalKm: number
  businessUsePct: number
  standbyChargeCents: number
  operatingBenefitCents: number
  totalBenefitCents: number
  gstToRemitCents: number
  reimbursedOperatingCents: number
  reimbursedStandbyCents: number
  electHalfStandby: boolean
  operatingRatePerKmCents: number
  notes: string[]
}

export interface VehicleLimits {
  vehicleId: number
  fiscalYearStart: string
  fiscalYearEnd: string
  daysInYear: number
  leaseCostCents: number
  leaseFormulaACents: number
  leaseFormulaBCents: number
  leaseDeductibleCents: number
  leaseExcessCents: number
  leaseItcRepayCents: number
  interestCostCents: number
  interestCapCents: number
  interestExcessCents: number
}

export interface CcaRow {
  ccaClass: string
  label: string
  ratePct: number
  openingUccCents: number
  additionsCents: number
  disposalsCents: number
  incentiveAdjustmentCents: number
  ccaCents: number
  recaptureCents: number
  terminalLossCents: number
  closingUccCents: number
}

export interface CcaSchedule {
  fiscalYearStart: string
  fiscalYearEnd: string
  rows: CcaRow[]
  totalCcaCents: number
  notes: string[]
}

export interface Asset {
  id: number
  description: string
  ccaClass: string
  costCents: number
  acquiredDate: string
  availableDate: string
  disposedDate: string | null
  proceedsCents: number | null
}

export interface TaxAdjustmentLine {
  label: string
  amountCents: number
  note?: string
}

/** Net income for tax purposes (T2 Schedule 1 style), estimated from the books. */
export interface TaxAdjustments {
  fiscalYearStart: string
  fiscalYearEnd: string
  netIncomeBooksCents: number
  addBacks: TaxAdjustmentLine[]
  deductions: TaxAdjustmentLine[]
  netIncomeForTaxCents: number
  /** Charitable donations, deducted separately on Schedule 2. */
  donationsCents: number
  notes: string[]
}

// ---------------------------------------------------------------- bank feed

export interface BankTransaction {
  id: number
  accountId: number
  accountName: string
  date: string
  /** Positive = money in, negative = money out. */
  amountCents: number
  description: string
  payee: string | null
  status: 'unreviewed' | 'posted' | 'excluded'
  entryId: number | null
  linkKind: 'expense' | 'payment' | 'entry' | 'transfer' | null
  linkId: number | null
  /** Where it was posted, once categorized. */
  category: string | null
  suggestedAccountId: number | null
  suggestedAccountName: string | null
  suggestedInvoiceId: number | null
  /** 'rule:<id>', 'history', 'invoice' or 'transfer'. */
  suggestionSource: string | null
  note: string
}

export interface BankRule {
  id: number
  pattern: string
  matchType: 'contains' | 'equals' | 'starts'
  direction: 'any' | 'in' | 'out'
  accountId: number
  accountName: string
  gstIncluded: boolean
  businessPct: number
  autoPost: boolean
}

export interface StatementImportResult {
  format: 'ofx' | 'csv'
  rowsInFile: number
  inserted: number
  duplicates: number
  autoPosted: number
  warnings: string[]
  /** Bank's closing balance (OFX) compared with the books. */
  balanceCheck?: { bankCents: number; booksCents: number; asOf: string }
}

export interface StatementPreview {
  token: string
  fileName: string
  format: 'ofx' | 'csv'
  /** CSV only: the raw rows (first 50) and the guessed column mapping. */
  rows: string[][]
  mapping: {
    date: number
    description: number
    amount?: number
    debit?: number
    credit?: number
    dateFormat: 'ymd' | 'mdy' | 'dmy'
    hasHeader: boolean
    flipSigns?: boolean
  } | null
  /** Transactions as they will be imported with the current mapping (first 50). */
  sample: { date: string; amountCents: number; description: string }[]
  total: number
  warnings: string[]
}

// ---------------------------------------------------------------- migration, receipts, issues

export interface MigrationAnalysis {
  transactions: number
  lines: number
  from: string | null
  to: string | null
  /** Source account names and the account they will go to (null = choose one). */
  accounts: { name: string; accountId: number | null }[]
  unbalanced: number
}

export interface MigrationResult {
  dryRun: boolean
  imported: number
  skipped: { key: string; reason: string }[]
}

export interface Receipt {
  id: number
  fileName: string
  mime: string
  sizeBytes: number
  expenseId: number | null
  bankTransactionId: number | null
  note: string
  createdAt: string
}

export interface Issue {
  severity: 'error' | 'warning' | 'info'
  code: string
  message: string
  /** Where to fix it in the app. */
  link?: string
  count?: number
}

/** How an expense will be treated under CRA rules, shown before saving. */
export interface ExpensePreview {
  account: string
  rule: { id: string; label: string; guidance: string; reference: string; deductiblePct: number; itcPct: number; gst: string }
  costCents: number
  itcCents: number
  personalCents: number
  nonDeductibleCents: number
  asset: { ccaClass: string; capitalCostCents: number } | null
  notes: string[]
  receiptMustShow: string[]
}

export interface AuditEvent {
  id: number
  at: string
  actor: string
  action: string
  entity: string
  entityId: number | null
  summary: string
  entryId: number | null
}

export interface PendingMigration {
  token: string
  fileName: string
  analysis: MigrationAnalysis
}

// ---------------------------------------------------------------- AI assistants

export interface AiConnection {
  id: number
  name: string
  kind: 'token' | 'oauth'
  mode: 'read' | 'write'
  clientId: string | null
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

export interface AiActivity extends AuditEvent {
  /** This change can still be undone. */
  canUndo: boolean
}

export interface AiStatus {
  enabled: boolean
  running: boolean
  port: number
  /** Address for assistants on this computer, e.g. http://127.0.0.1:47815/mcp */
  mcpUrl: string
  error: string | null
  tunnel: {
    status: 'off' | 'starting' | 'on' | 'error'
    /** Public address for Grok while the tunnel is on, e.g. https://abc.trycloudflare.com/mcp */
    mcpUrl: string | null
    error: string | null
    mode: 'quick' | 'named'
    hostname: string | null
    hasToken: boolean
  }
  cloudflaredInstalled: boolean
  connections: AiConnection[]
  claudeDesktop: { configPath: string | null; connected: boolean }
}
