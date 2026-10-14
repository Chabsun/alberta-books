/**
 * CRA rules for business expenses of a Canadian-controlled private
 * corporation in Alberta (GST 5%, no PST).
 *
 * Every expense account carries one of these rules. The rule decides:
 *  - how much of the cost is deductible for income tax (the rest is added
 *    back on the T2 Schedule 1),
 *  - how much of the GST paid can be claimed back as an input tax credit (ITC),
 *  - whether GST normally applies at all,
 *  - whether the purchase is a capital asset (written off through CCA, not expensed).
 *
 * These encode the general rules. Unusual situations exist for most of them;
 * the guidance text says when to check with your accountant.
 */

export type GstTreatment = 'taxable' | 'exempt' | 'zero'

export interface TaxRule {
  id: TaxRuleId
  label: string
  /** % of the business cost deductible for income tax. */
  deductiblePct: number
  /** % of the GST paid that can be claimed as an input tax credit. */
  itcPct: number
  /** Whether purchases in this category normally carry GST. */
  gst: GstTreatment
  /** Capital asset: the CCA class it belongs to (the cost is not an expense). */
  ccaClass?: CcaClassId
  /** CRA expects the business purpose to be recorded. */
  needsPurpose?: boolean
  /** CRA expects who attended (meals and entertainment). */
  needsAttendees?: boolean
  /** Vehicle cost with special limits. */
  vehicle?: 'operating' | 'insurance' | 'lease' | 'interest'
  /** Not a deductible expense in any form; the amount is added back in full. */
  nonDeductible?: boolean
  /** Plain-language rule shown when entering an expense. */
  guidance: string
  /** Where the rule comes from. */
  reference: string
}

export type TaxRuleId =
  | 'standard'
  | 'meals_entertainment'
  | 'client_gifts'
  | 'conventions'
  | 'travel'
  | 'exempt_financial'
  | 'insurance'
  | 'life_insurance'
  | 'club_dues'
  | 'fines_penalties'
  | 'political'
  | 'donations'
  | 'income_tax'
  | 'amortization'
  | 'home_office'
  | 'vehicle_operating'
  | 'vehicle_insurance'
  | 'vehicle_lease'
  | 'vehicle_interest'
  | 'capital_computer'
  | 'capital_furniture'
  | 'capital_software'
  | 'capital_small_tools'
  | 'capital_vehicle'

const CRA = 'https://www.canada.ca/en/revenue-agency'

export const TAX_RULES: Record<TaxRuleId, TaxRule> = {
  standard: {
    id: 'standard',
    label: 'Regular business expense',
    deductiblePct: 100,
    itcPct: 100,
    gst: 'taxable',
    guidance: 'Fully deductible if it was spent to earn business income and is reasonable. Claim the GST back if the receipt shows it.',
    reference: `${CRA}/services/tax/businesses/topics/sole-proprietorships-partnerships/business-expenses.html`
  },
  meals_entertainment: {
    id: 'meals_entertainment',
    label: 'Meals and entertainment (50%)',
    deductiblePct: 50,
    itcPct: 50,
    gst: 'taxable',
    needsPurpose: true,
    needsAttendees: true,
    guidance:
      'Only 50% is deductible, and only 50% of the GST can be claimed back. This includes meals while travelling and at conferences, and tickets to shows or games. Record who attended and the business purpose. Exceptions (100%): meals billed to a client and shown on their invoice, and up to six events a year open to all staff.',
    reference: `${CRA}/services/tax/businesses/small-businesses-self-employed-income/business-income-tax-reporting/business-expenses/types-operating-expenses.html`
  },
  client_gifts: {
    id: 'client_gifts',
    label: 'Gifts to clients',
    deductiblePct: 100,
    itcPct: 100,
    gst: 'taxable',
    needsPurpose: true,
    guidance: 'Business gifts are deductible when reasonable. Gifts of food, drink or event tickets fall under the 50% meals and entertainment rule instead; use that category for them.',
    reference: `${CRA}/services/tax/businesses/topics/sole-proprietorships-partnerships/business-expenses.html`
  },
  conventions: {
    id: 'conventions',
    label: 'Conventions and conferences',
    deductiblePct: 100,
    itcPct: 100,
    gst: 'taxable',
    needsPurpose: true,
    guidance:
      'Deductible for up to two conventions a year, held within the territory your business normally operates in. Meals and entertainment at the event are 50% (enter them separately under Meals). If the fee includes meals without a breakdown, CRA allows $50 a day as the meal portion.',
    reference: `${CRA}/services/tax/businesses/topics/sole-proprietorships-partnerships/business-expenses/convention-expenses.html`
  },
  travel: {
    id: 'travel',
    label: 'Business travel',
    deductiblePct: 100,
    itcPct: 100,
    gst: 'taxable',
    needsPurpose: true,
    guidance:
      'Airfare, hotels, taxis and car rentals for business trips are deductible. Meals while travelling are 50% (enter them under Meals). International flights are zero-rated (no GST). Keep the business purpose of each trip.',
    reference: `${CRA}/services/tax/businesses/topics/sole-proprietorships-partnerships/report-business-income-expenses/completing-form-t2125/line-9200-travel.html`
  },
  exempt_financial: {
    id: 'exempt_financial',
    label: 'Bank charges and interest (no GST)',
    deductiblePct: 100,
    itcPct: 0,
    gst: 'exempt',
    guidance: 'Deductible. Bank fees, card fees and loan interest are GST-exempt, so there is no GST to claim back. Interest on CRA balances and late-filing penalties are not deductible (use Fines and penalties).',
    reference: `${CRA}/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate/exempt-supplies.html`
  },
  insurance: {
    id: 'insurance',
    label: 'Business insurance (no GST)',
    deductiblePct: 100,
    itcPct: 0,
    gst: 'exempt',
    guidance: 'Business insurance premiums (liability, property, professional) are deductible. Insurance is GST-exempt, so there is no GST to claim back. Life insurance is different: use the Life insurance category.',
    reference: `${CRA}/services/tax/businesses/topics/sole-proprietorships-partnerships/business-expenses.html`
  },
  life_insurance: {
    id: 'life_insurance',
    label: 'Life insurance (usually not deductible)',
    deductiblePct: 0,
    itcPct: 0,
    gst: 'exempt',
    nonDeductible: true,
    guidance:
      'Life insurance premiums are generally not deductible. A portion can be deductible when a lender requires the policy as collateral for a business loan; ask your accountant in that case.',
    reference: `${CRA}/services/tax/businesses/topics/sole-proprietorships-partnerships/business-expenses.html`
  },
  club_dues: {
    id: 'club_dues',
    label: 'Golf, dining and recreational club dues (not deductible)',
    deductiblePct: 0,
    itcPct: 0,
    gst: 'taxable',
    nonDeductible: true,
    guidance:
      'Membership dues and initiation fees for clubs whose main purpose is dining, recreation or sport (golf, fitness, social clubs) are not deductible, and the GST cannot be claimed back. Dues to trade or professional associations are deductible: use Licences, dues and memberships.',
    reference: `${CRA}/services/tax/businesses/small-businesses-self-employed-income/business-income-tax-reporting/business-expenses/types-operating-expenses.html`
  },
  fines_penalties: {
    id: 'fines_penalties',
    label: 'Fines and penalties (not deductible)',
    deductiblePct: 0,
    itcPct: 0,
    gst: 'exempt',
    nonDeductible: true,
    guidance: 'Fines and penalties are not deductible (parking and traffic tickets, CRA penalties and interest on late tax). Record them so the books are complete; they are added back for tax.',
    reference: 'https://laws-lois.justice.gc.ca/eng/acts/i-3.3/section-67.6.html'
  },
  political: {
    id: 'political',
    label: 'Political contributions (not deductible)',
    deductiblePct: 0,
    itcPct: 0,
    gst: 'exempt',
    nonDeductible: true,
    guidance: 'Corporations cannot deduct political contributions, and federal and Alberta law prohibit corporate donations to parties and candidates.',
    reference: 'https://laws-lois.justice.gc.ca/eng/acts/i-3.3/'
  },
  donations: {
    id: 'donations',
    label: 'Charitable donations (Schedule 2)',
    deductiblePct: 0,
    itcPct: 0,
    gst: 'exempt',
    nonDeductible: true,
    guidance:
      'Donations to registered charities are not a business expense. The corporation deducts them separately on Schedule 2 of the T2, against taxable income. Keep the official donation receipts.',
    reference: `${CRA}/services/tax/businesses/topics/corporations/corporation-income-tax-return/completing-your-corporation-income-tax-t2-return/corporation-income-tax-return-line-311.html`
  },
  income_tax: {
    id: 'income_tax',
    label: 'Corporate income tax (not deductible)',
    deductiblePct: 0,
    itcPct: 0,
    gst: 'exempt',
    nonDeductible: true,
    guidance: 'Income tax is recorded as an expense in the books but is not deductible for tax; it is added back.',
    reference: 'https://laws-lois.justice.gc.ca/eng/acts/i-3.3/'
  },
  amortization: {
    id: 'amortization',
    label: 'Amortization (replaced by CCA for tax)',
    deductiblePct: 0,
    itcPct: 0,
    gst: 'exempt',
    nonDeductible: true,
    guidance:
      'Book amortization is added back for tax, and capital cost allowance (CCA, from the Assets page) is deducted instead.',
    reference: `${CRA}/services/tax/businesses/topics/sole-proprietorships-partnerships/report-business-income-expenses/claiming-capital-cost-allowance.html`
  },
  home_office: {
    id: 'home_office',
    label: 'Home office (corporation)',
    deductiblePct: 100,
    itcPct: 0,
    gst: 'exempt',
    needsPurpose: true,
    guidance:
      'A corporation cannot claim "business-use-of-home" like a sole proprietor. It can pay you a reasonable rent for a dedicated workspace under a written agreement (you report it as rental income), or reimburse actual business costs. Residential rent and most home costs carry no claimable GST. Agree the method with your accountant first.',
    reference: `${CRA}/services/tax/businesses/topics/sole-proprietorships-partnerships/business-expenses/business-use-home-expenses.html`
  },
  vehicle_operating: {
    id: 'vehicle_operating',
    label: 'Company vehicle: fuel, repairs, parking',
    deductiblePct: 100,
    itcPct: 100,
    gst: 'taxable',
    vehicle: 'operating',
    guidance:
      'Company-car running costs are deductible in full by the corporation. Your personal driving creates a taxable benefit for you (operating cost benefit) and GST the corporation must remit, both calculated on the Vehicle page from your logbook. Keep a logbook of every trip.',
    reference: `${CRA}/services/tax/businesses/topics/payroll/benefits-allowances/automobile/automobile-motor-vehicle-benefits.html`
  },
  vehicle_insurance: {
    id: 'vehicle_insurance',
    label: 'Company vehicle: insurance and registration (no GST)',
    deductiblePct: 100,
    itcPct: 0,
    gst: 'exempt',
    vehicle: 'insurance',
    guidance: 'Deductible. Insurance is GST-exempt, and provincial registration fees carry no GST.',
    reference: `${CRA}/services/tax/businesses/topics/payroll/benefits-allowances/automobile/automobile-motor-vehicle-benefits.html`
  },
  vehicle_lease: {
    id: 'vehicle_lease',
    label: 'Company vehicle: lease payments (capped)',
    deductiblePct: 100,
    itcPct: 100,
    gst: 'taxable',
    vehicle: 'lease',
    guidance:
      'Lease payments on a passenger vehicle are deductible only up to the CRA limit ($1,100 a month plus tax for leases from 2025). The excess is added back at year end, and the matching share of the GST claimed back is repaid on the GST return. The Vehicle page calculates both.',
    reference: 'https://www.canada.ca/en/department-finance/news/2026/01/government-announces-the-2026-automobile-deduction-limits-and-expense-benefit-rates-for-businesses.html'
  },
  vehicle_interest: {
    id: 'vehicle_interest',
    label: 'Company vehicle: loan interest (capped)',
    deductiblePct: 100,
    itcPct: 0,
    gst: 'exempt',
    vehicle: 'interest',
    guidance: 'Interest on a loan to buy a passenger vehicle is deductible only up to $350 a month. The excess is added back at year end (Vehicle page).',
    reference: 'https://www.canada.ca/en/department-finance/news/2026/01/government-announces-the-2026-automobile-deduction-limits-and-expense-benefit-rates-for-businesses.html'
  },
  capital_computer: {
    id: 'capital_computer',
    label: 'Computers and hardware (capital, class 50)',
    deductiblePct: 100,
    itcPct: 100,
    gst: 'taxable',
    ccaClass: '50',
    guidance:
      'Computers, monitors, phones and other equipment that last more than a year are capital assets: written off through CCA (class 50, 55% a year, with an enhanced first year) instead of expensed. Claim the GST back right away.',
    reference: `${CRA}/services/tax/businesses/topics/sole-proprietorships-partnerships/report-business-income-expenses/claiming-capital-cost-allowance/classes-depreciable-property.html`
  },
  capital_furniture: {
    id: 'capital_furniture',
    label: 'Furniture and equipment (capital, class 8)',
    deductiblePct: 100,
    itcPct: 100,
    gst: 'taxable',
    ccaClass: '8',
    guidance: 'Desks, chairs and other equipment are capital assets: class 8, 20% a year through CCA. Claim the GST back right away.',
    reference: `${CRA}/services/tax/businesses/topics/sole-proprietorships-partnerships/report-business-income-expenses/claiming-capital-cost-allowance/classes-depreciable-property.html`
  },
  capital_software: {
    id: 'capital_software',
    label: 'Software licences bought outright (capital, class 12)',
    deductiblePct: 100,
    itcPct: 100,
    gst: 'taxable',
    ccaClass: '12',
    guidance: 'Software bought outright is class 12 (100%). Monthly or yearly subscriptions are regular expenses instead: use Software and subscriptions.',
    reference: `${CRA}/services/tax/businesses/topics/sole-proprietorships-partnerships/report-business-income-expenses/claiming-capital-cost-allowance/classes-depreciable-property.html`
  },
  capital_small_tools: {
    id: 'capital_small_tools',
    label: 'Small tools under $500 (class 12, full write-off)',
    deductiblePct: 100,
    itcPct: 100,
    gst: 'taxable',
    ccaClass: '12T',
    guidance: 'Tools and kitchen utensils that cost under $500 each are class 12: written off in full in the year bought.',
    reference: `${CRA}/services/tax/businesses/topics/sole-proprietorships-partnerships/report-business-income-expenses/claiming-capital-cost-allowance/classes-depreciable-property.html`
  },
  capital_vehicle: {
    id: 'capital_vehicle',
    label: 'Company vehicle purchase (capital)',
    deductiblePct: 100,
    itcPct: 100,
    gst: 'taxable',
    ccaClass: '10',
    guidance:
      'A passenger vehicle is class 10 (30%), or class 10.1 when it costs more than the CRA limit ($39,000 before tax for 2026). Only the limit is depreciable, and the GST you can claim back is capped at the GST on the limit. Zero-emission vehicles are class 54 (limit $61,000). The corporation can claim GST on the purchase only if the vehicle is used more than 50% for business.',
    reference: 'https://www.canada.ca/en/department-finance/news/2026/01/government-announces-the-2026-automobile-deduction-limits-and-expense-benefit-rates-for-businesses.html'
  }
}

export const TAX_RULE_IDS = Object.keys(TAX_RULES) as TaxRuleId[]

export function taxRule(id: string | null | undefined): TaxRule {
  return (id && TAX_RULES[id as TaxRuleId]) || TAX_RULES.standard
}

// ---------------------------------------------------------------------------
// Capital cost allowance classes
// ---------------------------------------------------------------------------

export type CcaClassId = '8' | '10' | '10.1' | '12' | '12T' | '50' | '54'

export interface CcaClass {
  id: CcaClassId
  /** Number on Schedule 8. */
  number: string
  label: string
  /** Declining-balance rate, as a fraction. */
  rate: number
  /** Subject to the half-year rule when no incentive applies. */
  halfYear: boolean
}

export const CCA_CLASSES: Record<CcaClassId, CcaClass> = {
  '8': { id: '8', number: '8', label: 'Furniture, equipment', rate: 0.2, halfYear: true },
  '10': { id: '10', number: '10', label: 'Vehicles', rate: 0.3, halfYear: true },
  '10.1': { id: '10.1', number: '10.1', label: 'Passenger vehicle over the cost limit', rate: 0.3, halfYear: true },
  '12': { id: '12', number: '12', label: 'Software', rate: 1, halfYear: true },
  '12T': { id: '12T', number: '12', label: 'Small tools under $500', rate: 1, halfYear: false },
  '50': { id: '50', number: '50', label: 'Computer equipment', rate: 0.55, halfYear: true },
  '54': { id: '54', number: '54', label: 'Zero-emission passenger vehicle', rate: 0.3, halfYear: true }
}

// ---------------------------------------------------------------------------
// Prescribed automobile amounts (Income Tax Regulations; Department of Finance
// announcements). Keyed by calendar year of acquisition / lease / use.
// 2025 and 2026 confirmed from the January 14, 2026 Finance release (2026 values,
// and 2025 values it says "remain" or "increase from"). 2024 values: verify.
// ---------------------------------------------------------------------------

export interface AutoLimits {
  /** Class 10.1 capital cost ceiling, before tax (cents). */
  ccaCeiling: number
  /** Class 54 zero-emission ceiling, before tax (cents). */
  zevCeiling: number
  /** Deductible lease cost per month, before tax (cents). */
  leasePerMonth: number
  /** Deductible interest per month (cents). */
  interestPerMonth: number
  /** Operating cost benefit per personal km (cents). */
  operatingBenefitPerKm: number
}

export const AUTO_LIMITS: Record<number, AutoLimits> = {
  2024: { ccaCeiling: 3_700_000, zevCeiling: 6_100_000, leasePerMonth: 105_000, interestPerMonth: 35_000, operatingBenefitPerKm: 33 },
  2025: { ccaCeiling: 3_800_000, zevCeiling: 6_100_000, leasePerMonth: 110_000, interestPerMonth: 35_000, operatingBenefitPerKm: 34 },
  2026: { ccaCeiling: 3_900_000, zevCeiling: 6_100_000, leasePerMonth: 110_000, interestPerMonth: 35_000, operatingBenefitPerKm: 34 }
}

/** Limits for a year; years after the last known one use the latest figures. */
export function autoLimits(year: number): AutoLimits & { year: number; known: boolean } {
  const years = Object.keys(AUTO_LIMITS).map(Number).sort((a, b) => a - b)
  const known = AUTO_LIMITS[year] !== undefined
  const use = known ? year : year < years[0] ? years[0] : years[years.length - 1]
  return { ...AUTO_LIMITS[use], year: use, known }
}

// ---------------------------------------------------------------------------
// GST input tax credit documentation (Input Tax Credit Information (GST/HST)
// Regulations, s.3; thresholds since April 20, 2021).
// ---------------------------------------------------------------------------

export function receiptRequirements(totalCents: number): string[] {
  const base = ['Supplier’s name (or trading name)', 'Invoice or receipt date', 'Total amount paid']
  if (totalCents < 100_00) return base
  const mid = [...base, 'Supplier’s GST/HST registration number', 'GST amount, or a statement that the price includes GST and at what rate']
  if (totalCents < 500_00) return mid
  return [...mid, 'Your corporation’s name (or trading name)', 'Payment terms', 'Description of what was bought']
}

export const GST_NUMBER_RE = /^\d{9}\s?RT\s?\d{4}$/i

// GST to remit on automobile benefits in a non-participating (GST-only) province.
export const STANDBY_GST_FRACTION = { numerator: 4, denominator: 104 }
export const OPERATING_BENEFIT_GST_RATE_BPS = 300
