/**
 * How one expense is split for income tax and GST, given its CRA rule.
 * Pure arithmetic in cents, so every rule is easy to test.
 *
 *   receipt: pre-tax amount A, GST paid G, business-use p%
 *   business part  Ab = A·p,  Gb = G·p          personal part = (A − Ab) + (G − Gb)
 *   ITC            = Gb · rule.itcPct           (capped for passenger vehicles)
 *   cost to books  = Ab + (Gb − ITC)            GST you can't claim back is part of the cost
 *   non-deductible = cost · (100 − rule.deductiblePct)
 */
import { autoLimits, CCA_CLASSES, taxRule, type CcaClassId, type TaxRule } from '../../shared/taxRules'
import { gstOn, mulDivRound } from '../../shared/money'

export interface ExpenseSplitInput {
  ruleId: string | null
  amountCents: number
  gstCents: number
  businessPct: number
  /** Purchase date, for vehicle limits. */
  date: string
  /** Passenger vehicle purchase: zero-emission (class 54). */
  zeroEmission?: boolean
  /** Passenger vehicle purchase: used more than 50% for business (needed to claim GST back). */
  primarilyBusiness?: boolean
}

export interface ExpenseSplit {
  rule: TaxRule
  /** Debited to the expense or asset account. */
  costCents: number
  /** Debited to GST paid (input tax credit). */
  itcCents: number
  /** Debited to the shareholder loan (the personal part, which the company paid for you). */
  personalCents: number
  /** Part of the cost not deductible for income tax (added back on Schedule 1). */
  nonDeductibleCents: number
  /** Capital asset to record, if the rule is a capital class. */
  asset: { ccaClass: CcaClassId; capitalCostCents: number } | null
  notes: string[]
}

export function splitExpense(input: ExpenseSplitInput): ExpenseSplit {
  const rule = taxRule(input.ruleId)
  const notes: string[] = []
  const p = Math.min(100, Math.max(0, Math.round(input.businessPct)))
  const ab = mulDivRound(input.amountCents, p, 100)
  const gb = mulDivRound(input.gstCents, p, 100)
  const personal = input.amountCents - ab + (input.gstCents - gb)

  let itc = mulDivRound(gb, rule.itcPct, 100)
  let asset: ExpenseSplit['asset'] = null

  if (rule.ccaClass) {
    let ccaClass = rule.ccaClass
    let capitalCost = ab + (gb - itc)
    if (rule.id === 'capital_vehicle') {
      const limits = autoLimits(Number(input.date.slice(0, 4)))
      const ceiling = input.zeroEmission ? limits.zevCeiling : limits.ccaCeiling
      // GST can be claimed back only on vehicles used more than 50% for business,
      // and only up to the GST on the cost ceiling.
      itc = input.primarilyBusiness === false ? 0 : Math.min(gb, gstOn(ceiling))
      if (input.primarilyBusiness === false) notes.push('No GST claimed back: the vehicle is not used more than 50% for business.')
      if (gb > itc && itc > 0) notes.push(`GST claimed back is capped at the GST on the $${ceiling / 100} limit.`)
      const fullCost = ab + (gb - itc)
      if (input.zeroEmission) {
        ccaClass = '54'
        capitalCost = Math.min(fullCost, ceiling + (gstOn(ceiling) - Math.min(itc, gstOn(ceiling))))
        if (fullCost > capitalCost) notes.push(`Class 54: only $${ceiling / 100} plus tax can be written off.`)
      } else if (ab > ceiling) {
        ccaClass = '10.1'
        capitalCost = ceiling + Math.max(0, gstOn(ceiling) - itc)
        notes.push(`Class 10.1: the vehicle costs more than the $${ceiling / 100} limit, so only the limit can be written off.`)
      } else {
        ccaClass = '10'
        capitalCost = fullCost
      }
    }
    asset = { ccaClass, capitalCostCents: capitalCost }
    notes.push(`Capital asset (CCA class ${CCA_CLASSES[ccaClass].number}): written off over time, not expensed.`)
  }

  const cost = ab + (gb - itc)
  const nonDeductible = rule.ccaClass ? 0 : mulDivRound(cost, 100 - rule.deductiblePct, 100)
  if (rule.deductiblePct === 50) notes.push('50% of this cost is not deductible for income tax.')
  if (rule.nonDeductible) notes.push('Not deductible for income tax.')
  if (rule.itcPct === 50 && gb > 0) notes.push('Only 50% of the GST can be claimed back.')
  if (rule.itcPct === 0 && input.gstCents > 0 && rule.gst !== 'exempt') notes.push('The GST on this cannot be claimed back.')
  if (rule.gst === 'exempt' && input.gstCents > 0) {
    notes.push('This category is normally GST-exempt: check the receipt really shows GST.')
  }
  if (personal > 0) notes.push('The personal part is charged to your shareholder loan (it reduces what the company owes you).')

  return { rule, costCents: cost, itcCents: itc, personalCents: personal, nonDeductibleCents: nonDeductible, asset, notes }
}
