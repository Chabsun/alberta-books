/**
 * Chart-of-accounts additions in schema version 2: CRA rule per expense
 * account, plus the categories the rules need (meals vs. club dues, vehicle
 * cost types, capital asset accounts, non-deductible items).
 */
import type { AccountType } from '../../shared/types'
import type { TaxRuleId } from '../../shared/taxRules'

interface NewAccount {
  code: string
  name: string
  type: AccountType
  gifi: string
  rule?: TaxRuleId
}

export const V2_ACCOUNTS: NewAccount[] = [
  // Capital assets and accumulated amortization
  { code: '1505', name: 'Software (owned licences)', type: 'asset', gifi: '1774', rule: 'capital_software' },
  { code: '1525', name: 'Small tools', type: 'asset', gifi: '1740', rule: 'capital_small_tools' },
  { code: '1540', name: 'Company vehicles', type: 'asset', gifi: '1742', rule: 'capital_vehicle' },
  { code: '1550', name: 'Accumulated amortization – vehicles', type: 'asset', gifi: '1743' },
  // Liabilities
  { code: '2600', name: 'Vehicle loan', type: 'liability', gifi: '2700' },
  // Expenses with special CRA rules
  { code: '5105', name: 'Gifts to clients', type: 'expense', gifi: '8520', rule: 'client_gifts' },
  { code: '5115', name: 'Golf, dining and recreational club dues (not deductible)', type: 'expense', gifi: '9270', rule: 'club_dues' },
  { code: '5145', name: 'Life insurance premiums (usually not deductible)', type: 'expense', gifi: '8690', rule: 'life_insurance' },
  { code: '5185', name: 'Home office (corporation)', type: 'expense', gifi: '8910', rule: 'home_office' },
  { code: '5225', name: 'Conventions and conferences', type: 'expense', gifi: '9200', rule: 'conventions' },
  { code: '5231', name: 'Vehicle – fuel, repairs, parking', type: 'expense', gifi: '9281', rule: 'vehicle_operating' },
  { code: '5232', name: 'Vehicle – insurance and registration', type: 'expense', gifi: '9281', rule: 'vehicle_insurance' },
  { code: '5233', name: 'Vehicle – lease payments', type: 'expense', gifi: '9281', rule: 'vehicle_lease' },
  { code: '5234', name: 'Vehicle – loan interest', type: 'expense', gifi: '8710', rule: 'vehicle_interest' },
  { code: '5260', name: 'Training and education', type: 'expense', gifi: '9270', rule: 'standard' },
  { code: '5810', name: 'Fines and penalties (not deductible)', type: 'expense', gifi: '9270', rule: 'fines_penalties' },
  { code: '5820', name: 'Charitable donations (Schedule 2)', type: 'expense', gifi: '9270', rule: 'donations' },
  { code: '5830', name: 'Political contributions (not deductible)', type: 'expense', gifi: '9270', rule: 'political' }
]

/** Rule for each account that existed in version 1 (by code). */
export const V1_RULES: Record<string, TaxRuleId> = {
  '1500': 'capital_computer',
  '1520': 'capital_furniture',
  '5100': 'standard',
  '5110': 'meals_entertainment',
  '5120': 'exempt_financial',
  '5130': 'standard',
  '5140': 'insurance',
  '5150': 'exempt_financial',
  '5160': 'standard',
  '5170': 'standard',
  '5180': 'standard',
  '5190': 'standard',
  '5200': 'standard',
  '5210': 'standard',
  '5220': 'travel',
  '5230': 'vehicle_operating',
  '5240': 'standard',
  '5250': 'amortization',
  '5800': 'standard',
  '5900': 'income_tax'
}

/** Accumulated amortization account for each capital asset account. */
export const ACCUMULATED_FOR: Record<string, string> = {
  '1500': '1510',
  '1505': '1510',
  '1520': '1530',
  '1525': '1530',
  '1540': '1550'
}
