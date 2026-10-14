/**
 * Starting chart of accounts for a one-person Canadian corporation in Alberta.
 *
 * `gifi` is the CRA General Index of Financial Information code used on the
 * T2 return (Schedule 100 balance sheet, Schedule 125 income statement).
 * Every account and GIFI code can be changed in the app; have your accountant
 * confirm the mapping before your first T2 (CRA guide RC4088 lists all codes).
 *
 * `role` marks the accounts the app posts to automatically.
 */
import type { AccountRole, AccountType } from '../../shared/types'

interface SeedAccount {
  code: string
  name: string
  type: AccountType
  gifi: string | null
  role?: AccountRole
  isBank?: boolean
}

export const SEED_ACCOUNTS: SeedAccount[] = [
  // Assets
  { code: '1000', name: 'Chequing account', type: 'asset', gifi: '1002', role: 'bank', isBank: true },
  { code: '1010', name: 'Savings account', type: 'asset', gifi: '1002', isBank: true },
  { code: '1200', name: 'Accounts receivable', type: 'asset', gifi: '1060', role: 'ar' },
  { code: '1300', name: 'Prepaid expenses', type: 'asset', gifi: '1484' },
  { code: '1500', name: 'Computer equipment', type: 'asset', gifi: '1774' },
  { code: '1510', name: 'Accumulated amortization – computer equipment', type: 'asset', gifi: '1775' },
  { code: '1520', name: 'Furniture and equipment', type: 'asset', gifi: '1740' },
  { code: '1530', name: 'Accumulated amortization – furniture and equipment', type: 'asset', gifi: '1741' },

  // Liabilities
  { code: '2000', name: 'Accounts payable', type: 'liability', gifi: '2620' },
  { code: '2100', name: 'Business credit card', type: 'liability', gifi: '2600', isBank: true },
  { code: '2300', name: 'GST collected', type: 'liability', gifi: '2680', role: 'gst_collected' },
  { code: '2310', name: 'GST paid (input tax credits)', type: 'liability', gifi: '2680', role: 'gst_itc' },
  { code: '2320', name: 'GST owing to CRA (filed returns)', type: 'liability', gifi: '2680', role: 'gst_owing' },
  { code: '2400', name: 'Corporate income tax payable', type: 'liability', gifi: '2680' },
  { code: '2500', name: 'Due to shareholder (shareholder loan)', type: 'liability', gifi: '2780', role: 'shareholder_loan' },

  // Equity
  { code: '3000', name: 'Common shares', type: 'equity', gifi: '3500', role: 'share_capital' },
  { code: '3100', name: 'Retained earnings', type: 'equity', gifi: '3600', role: 'retained_earnings' },
  { code: '3200', name: 'Dividends declared', type: 'equity', gifi: '3700', role: 'dividends' },

  // Income
  { code: '4000', name: 'Service revenue', type: 'income', gifi: '8000', role: 'sales' },
  { code: '4100', name: 'Other revenue', type: 'income', gifi: '8230' },
  { code: '4200', name: 'Interest income', type: 'income', gifi: '8090' },

  // Expenses
  { code: '5100', name: 'Advertising and promotion', type: 'expense', gifi: '8520' },
  { code: '5110', name: 'Meals and entertainment (50% deductible)', type: 'expense', gifi: '8523' },
  { code: '5120', name: 'Bank charges', type: 'expense', gifi: '8715' },
  { code: '5130', name: 'Licences, dues and memberships', type: 'expense', gifi: '8760' },
  { code: '5140', name: 'Insurance', type: 'expense', gifi: '8690' },
  { code: '5150', name: 'Interest expense', type: 'expense', gifi: '8710' },
  { code: '5160', name: 'Office expenses and supplies', type: 'expense', gifi: '8810' },
  { code: '5170', name: 'Professional fees (legal, accounting)', type: 'expense', gifi: '8860' },
  { code: '5180', name: 'Rent', type: 'expense', gifi: '8910' },
  { code: '5190', name: 'Repairs and maintenance', type: 'expense', gifi: '8960' },
  { code: '5200', name: 'Software and subscriptions', type: 'expense', gifi: '9150' },
  { code: '5210', name: 'Telephone and internet', type: 'expense', gifi: '9225' },
  { code: '5220', name: 'Travel', type: 'expense', gifi: '9200' },
  { code: '5230', name: 'Vehicle expenses', type: 'expense', gifi: '9281' },
  { code: '5240', name: 'Utilities', type: 'expense', gifi: '9220' },
  { code: '5250', name: 'Amortization', type: 'expense', gifi: '8670' },
  { code: '5800', name: 'Other expenses', type: 'expense', gifi: '9270' },
  { code: '5900', name: 'Income taxes', type: 'expense', gifi: '9990' }
]
