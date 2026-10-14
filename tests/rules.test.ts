import { describe, expect, it } from 'vitest'
import { splitExpense } from '../src/main/services/expenseMath'
import { createExpense, updateExpenseDetails, voidExpense } from '../src/main/services/expenses'
import { ccaSchedule, firstYearFactor, setOpeningUcc } from '../src/main/services/cca'
import { addTrip, saveVehicle, setVehicleYear, vehicleBenefit, vehicleLimits } from '../src/main/services/vehicles'
import { taxAdjustments } from '../src/main/services/taxAdjustments'
import { fileGstReturn, gstReturn } from '../src/main/services/reports'
import { updateSettings } from '../src/main/services/settings'
import { createManualEntry } from '../src/main/services/ledger'
import { receiptRequirements } from '../src/shared/taxRules'
import { acct, balanceOf, makeDb, role } from './helpers'

const split = (ruleId: string, amountCents: number, gstCents: number, extra: Partial<Parameters<typeof splitExpense>[0]> = {}) =>
  splitExpense({ ruleId, amountCents, gstCents, businessPct: 100, date: '2026-03-01', ...extra })

describe('CRA expense rules', () => {
  it('meals and entertainment: 50% of the GST back, 50% of the cost not deductible', () => {
    const s = split('meals_entertainment', 100_00, 5_00)
    expect(s.itcCents).toBe(2_50)
    expect(s.costCents).toBe(102_50)
    expect(s.nonDeductibleCents).toBe(51_25)
  })

  it('club dues: nothing deductible, no GST back', () => {
    const s = split('club_dues', 500_00, 25_00)
    expect(s.itcCents).toBe(0)
    expect(s.costCents).toBe(525_00)
    expect(s.nonDeductibleCents).toBe(525_00)
  })

  it('fines and penalties are not deductible', () => {
    expect(split('fines_penalties', 150_00, 0).nonDeductibleCents).toBe(150_00)
  })

  it('bank charges: deductible, GST-exempt', () => {
    const s = split('exempt_financial', 15_00, 0)
    expect(s).toMatchObject({ itcCents: 0, costCents: 15_00, nonDeductibleCents: 0 })
  })

  it('mixed personal use: only the business share is expensed and claimed', () => {
    const s = split('standard', 100_00, 5_00, { businessPct: 60 })
    expect(s.costCents).toBe(60_00)
    expect(s.itcCents).toBe(3_00)
    expect(s.personalCents).toBe(42_00)
  })

  it('computers are capital (class 50), with the GST claimed now', () => {
    const s = split('capital_computer', 2000_00, 100_00)
    expect(s.asset).toEqual({ ccaClass: '50', capitalCostCents: 2000_00 })
    expect(s.itcCents).toBe(100_00)
    expect(s.nonDeductibleCents).toBe(0)
  })

  it('passenger vehicle over the 2026 ceiling: class 10.1, GST back capped at GST on $39,000', () => {
    const s = split('capital_vehicle', 50_000_00, 2_500_00)
    expect(s.itcCents).toBe(1_950_00)
    expect(s.asset).toEqual({ ccaClass: '10.1', capitalCostCents: 39_000_00 })
  })

  it('passenger vehicle under the ceiling: class 10, full GST back', () => {
    const s = split('capital_vehicle', 30_000_00, 1_500_00)
    expect(s.itcCents).toBe(1_500_00)
    expect(s.asset).toEqual({ ccaClass: '10', capitalCostCents: 30_000_00 })
  })

  it('2025 purchases use the 2025 ceiling ($38,000)', () => {
    const s = split('capital_vehicle', 40_000_00, 2_000_00, { date: '2025-06-01' })
    expect(s.asset).toEqual({ ccaClass: '10.1', capitalCostCents: 38_000_00 })
  })

  it('zero-emission vehicle: class 54 with the $61,000 ceiling', () => {
    const s = split('capital_vehicle', 70_000_00, 3_500_00, { zeroEmission: true })
    expect(s.itcCents).toBe(3_050_00)
    expect(s.asset).toEqual({ ccaClass: '54', capitalCostCents: 61_000_00 })
  })

  it('vehicle used 50% or less for business: no GST back on the purchase', () => {
    expect(split('capital_vehicle', 30_000_00, 1_500_00, { primarilyBusiness: false }).itcCents).toBe(0)
  })

  it('lists what a receipt must show, by amount', () => {
    expect(receiptRequirements(99_99)).toHaveLength(3)
    expect(receiptRequirements(100_00)).toContain('Supplier’s GST/HST registration number')
    expect(receiptRequirements(500_00)).toContain('Payment terms')
  })
})

describe('expenses in the books', () => {
  it('posts meals with half the ITC and flags missing purpose, attendees, GST number and receipt', () => {
    const db = makeDb()
    const x = createExpense(db, {
      date: '2026-03-02',
      vendor: 'Ruth’s Chris',
      description: 'Client dinner',
      accountId: acct(db, '5110'),
      amountCents: 200_00,
      gstCents: 10_00,
      paidFromAccountId: role(db, 'bank')
    })
    expect(x.itcCents).toBe(5_00)
    expect(x.nonDeductibleCents).toBe(102_50)
    expect(balanceOf(db, acct(db, '5110'))).toBe(205_00)
    expect(x.warnings).toHaveLength(4)
    const fixed = updateExpenseDetails(db, x.id, { supplierGstNumber: '123456789 RT0001', purpose: 'Project kickoff', attendees: 'J. Smith (Acme)' })
    expect(fixed.warnings).toEqual(['Attach the receipt.'])
    expect(() => updateExpenseDetails(db, x.id, { supplierGstNumber: '12345' })).toThrow(/GST number/)
  })

  it('charges the personal share to the shareholder loan', () => {
    const db = makeDb()
    createExpense(db, {
      date: '2026-03-02',
      vendor: 'Telus',
      description: '',
      accountId: acct(db, '5210'),
      amountCents: 100_00,
      gstCents: 5_00,
      paidFromAccountId: role(db, 'bank'),
      businessPct: 70
    })
    expect(balanceOf(db, acct(db, '5210'))).toBe(70_00)
    expect(balanceOf(db, role(db, 'gst_itc'))).toBe(-3_50)
    expect(balanceOf(db, role(db, 'shareholder_loan'))).toBe(-31_50) // you owe the company
  })

  it('records capital purchases as assets, and voiding removes them from CCA', () => {
    const db = makeDb()
    const x = createExpense(db, {
      date: '2026-01-15',
      vendor: 'Apple',
      description: 'MacBook Pro',
      accountId: acct(db, '1500'),
      amountCents: 2000_00,
      gstCents: 100_00,
      paidFromAccountId: role(db, 'bank')
    })
    updateSettings(db, { fiscalYearEndMonth: 8 })
    expect(ccaSchedule(db, '2026-08-31').totalCcaCents).toBe(1650_00)
    voidExpense(db, x.id, '2026-01-16')
    expect(ccaSchedule(db, '2026-08-31').totalCcaCents).toBe(0)
  })

  it('refuses a business-use % on company vehicle and capital costs', () => {
    const db = makeDb()
    expect(() =>
      createExpense(db, { date: '2026-03-02', vendor: 'Shell', description: '', accountId: acct(db, '5231'), amountCents: 80_00, gstCents: 4_00, paidFromAccountId: role(db, 'bank'), businessPct: 80 })
    ).toThrow(/100%/)
  })
})

describe('capital cost allowance', () => {
  it('applies the reinstated incentive, the old phase-out and the half-year rule', () => {
    expect(firstYearFactor('50', '2026-01-15', '2026-01-15')).toBe(1.5)
    expect(firstYearFactor('50', '2026-01-15', '2031-01-15')).toBe(1)
    expect(firstYearFactor('8', '2024-03-01', '2024-03-01')).toBe(1)
    expect(firstYearFactor('8', '2019-03-01', '2019-03-01')).toBe(1.5)
    expect(firstYearFactor('8', '2017-03-01', '2017-03-01')).toBe(0.5)
    expect(firstYearFactor('54', '2026-03-01', '2026-03-01')).toBe(Infinity)
  })

  it('rolls UCC forward year to year, with opening balances from an earlier T2', () => {
    const db = makeDb()
    updateSettings(db, { fiscalYearEndMonth: 8 })
    setOpeningUcc(db, '8', '2025-08-31', 10_000_00)
    db.run(`INSERT INTO assets (description, cca_class, cost, acquired_date, available_date) VALUES ('Laptop', '50', 200000, '2026-01-15', '2026-01-15')`)
    const y1 = ccaSchedule(db, '2026-08-31')
    expect(y1.rows.find((r) => r.ccaClass === '8')!.ccaCents).toBe(2_000_00)
    expect(y1.rows.find((r) => r.ccaClass === '50')!.ccaCents).toBe(1_650_00)
    const y2 = ccaSchedule(db, '2027-08-31')
    expect(y2.rows.find((r) => r.ccaClass === '50')!.openingUccCents).toBe(350_00)
    expect(y2.rows.find((r) => r.ccaClass === '50')!.ccaCents).toBe(192_50)
    expect(y2.rows.find((r) => r.ccaClass === '8')!.ccaCents).toBe(1_600_00)
  })

  it('writes off zero-emission vehicles and small tools in the first year', () => {
    const db = makeDb()
    db.run(`INSERT INTO assets (description, cca_class, cost, acquired_date, available_date) VALUES ('EV', '54', 6100000, '2026-03-01', '2026-03-01')`)
    db.run(`INSERT INTO assets (description, cca_class, cost, acquired_date, available_date) VALUES ('Drill', '12T', 30000, '2026-03-01', '2026-03-01')`)
    const s = ccaSchedule(db, '2026-12-31')
    expect(s.totalCcaCents).toBe(61_300_00)
  })

  it('treats each class 10.1 car separately', () => {
    const db = makeDb()
    db.run(`INSERT INTO assets (description, cca_class, cost, acquired_date, available_date) VALUES ('Car', '10.1', 3900000, '2026-02-01', '2026-02-01')`)
    expect(ccaSchedule(db, '2026-12-31').totalCcaCents).toBe(17_550_00)
  })
})

describe('company vehicle', () => {
  function ownedCar() {
    const db = makeDb()
    const v = saveVehicle(db, { name: 'Ford F-150', ownership: 'owned', startDate: '2025-06-01', costCents: 40_000_00 })
    return { db, v }
  }

  it('computes the reduced standby charge, operating benefit and GST to remit', () => {
    const { db, v } = ownedCar()
    addTrip(db, { vehicleId: v.id, date: '2026-04-01', km: 15000, kind: 'business', purpose: 'Client sites (annual total)' })
    addTrip(db, { vehicleId: v.id, date: '2026-04-02', km: 5000, kind: 'personal' })
    const b = vehicleBenefit(db, v.id, 2026)
    expect(b.monthsAvailable).toBe(12)
    expect(b.businessUsePct).toBe(75)
    expect(b.standbyChargeCents).toBe(2_519_50) // 2% × $42,000 × 12 × 5,000 / 20,004
    expect(b.operatingBenefitCents).toBe(1_700_00) // 5,000 km × 34¢
    expect(b.gstToRemitCents).toBe(96_90 + 51_00) // 4/104 of standby + 3% of operating
  })

  it('applies the half-standby election and shareholder reimbursements', () => {
    const { db, v } = ownedCar()
    addTrip(db, { vehicleId: v.id, date: '2026-04-01', km: 15000, kind: 'business', purpose: 'Client sites' })
    addTrip(db, { vehicleId: v.id, date: '2026-04-02', km: 5000, kind: 'personal' })
    setVehicleYear(db, v.id, 2026, { reimbursedOperatingCents: 0, reimbursedStandbyCents: 500_00, electHalfStandby: true })
    const b = vehicleBenefit(db, v.id, 2026)
    expect(b.operatingBenefitCents).toBe(1_259_75)
    expect(b.standbyChargeCents).toBe(2_019_50)
  })

  it('charges the full standby charge when business use is 50% or less', () => {
    const { db, v } = ownedCar()
    addTrip(db, { vehicleId: v.id, date: '2026-04-01', km: 4000, kind: 'business', purpose: 'Clients' })
    addTrip(db, { vehicleId: v.id, date: '2026-04-02', km: 6000, kind: 'personal' })
    expect(vehicleBenefit(db, v.id, 2026).standbyChargeCents).toBe(10_080_00)
  })

  it('requires a purpose for business trips', () => {
    const { db, v } = ownedCar()
    expect(() => addTrip(db, { vehicleId: v.id, date: '2026-04-01', km: 40, kind: 'business' })).toThrow(/purpose/)
  })

  it('caps lease payments (formula A and B) and repays GST on the excess', () => {
    const db = makeDb()
    updateSettings(db, { fiscalYearEndMonth: 8 })
    const v = saveVehicle(db, { name: 'Leased SUV', ownership: 'leased', startDate: '2026-01-01', monthlyLeaseCents: 1_300_00, msrpCents: 50_000_00 })
    for (let m = 1; m <= 8; m++) {
      createExpense(db, { date: `2026-0${m}-05`, vendor: 'Ford Credit', description: 'Lease', accountId: acct(db, '5233'), amountCents: 1_300_00, gstCents: 65_00, paidFromAccountId: role(db, 'bank'), vehicleId: v.id })
    }
    const lim = vehicleLimits(db, v.id, '2026-08-31')
    expect(lim.daysInYear).toBe(243)
    expect(lim.leaseFormulaACents).toBe(8_910_00)
    expect(lim.leaseFormulaBCents).toBe(9_543_53)
    expect(lim.leaseDeductibleCents).toBe(8_910_00)
    expect(lim.leaseExcessCents).toBe(1_490_00)
    expect(lim.leaseItcRepayCents).toBe(74_50)

    const adj = taxAdjustments(db, '2026-08-31')
    expect(adj.addBacks.find((a) => a.label.startsWith('Lease cost over'))!.amountCents).toBe(1_490_00)
    const r = gstReturn(db, '2025-09-01', '2026-08-31')
    expect(r.line104).toBe(74_50)
    expect(r.line109).toBe(74_50 - 8 * 65_00)
  })

  it('caps loan interest at $350 a month', () => {
    const db = makeDb()
    const v = saveVehicle(db, { name: 'Car', ownership: 'owned', startDate: '2026-01-01', costCents: 45_000_00 })
    createExpense(db, { date: '2026-06-30', vendor: 'RBC', description: 'Car loan interest', accountId: acct(db, '5234'), amountCents: 5_000_00, gstCents: 0, paidFromAccountId: role(db, 'bank'), vehicleId: v.id })
    const lim = vehicleLimits(db, v.id, '2026-12-31')
    expect(lim.interestCapCents).toBe(4_258_33) // $350 × 365 days / 30
    expect(lim.interestExcessCents).toBe(741_67)
  })

  it('adds the benefit GST to the return covering the end of February, and posts it when filed', () => {
    const db = makeDb()
    const v = saveVehicle(db, { name: 'Car', ownership: 'owned', startDate: '2025-01-01', costCents: 40_000_00 })
    addTrip(db, { vehicleId: v.id, date: '2026-05-01', km: 15000, kind: 'business', purpose: 'Clients' })
    addTrip(db, { vehicleId: v.id, date: '2026-05-02', km: 5000, kind: 'personal' })
    const q1 = gstReturn(db, '2027-01-01', '2027-03-31')
    expect(q1.line104).toBe(147_90)
    expect(gstReturn(db, '2026-10-01', '2026-12-31').line104).toBe(0)
    fileGstReturn(db, '2027-01-01', '2027-03-31')
    expect(balanceOf(db, role(db, 'gst_owing'))).toBe(147_90)
  })
})

describe('tax adjustments (Schedule 1)', () => {
  it('adds back non-deductible amounts and deducts CCA', () => {
    const db = makeDb()
    updateSettings(db, { fiscalYearEndMonth: 8 })
    const bank = role(db, 'bank')
    createManualEntry(db, {
      date: '2025-10-01',
      memo: 'Revenue',
      lines: [
        { accountId: bank, debitCents: 100_000_00, creditCents: 0, memo: '' },
        { accountId: role(db, 'sales'), debitCents: 0, creditCents: 100_000_00, memo: '' }
      ]
    })
    createExpense(db, { date: '2025-11-01', vendor: 'Restaurant', description: '', accountId: acct(db, '5110'), amountCents: 400_00, gstCents: 20_00, paidFromAccountId: bank, purpose: 'x', attendees: 'y' })
    createExpense(db, { date: '2025-11-02', vendor: 'Golf club', description: '', accountId: acct(db, '5115'), amountCents: 1_000_00, gstCents: 50_00, paidFromAccountId: bank })
    createExpense(db, { date: '2025-11-03', vendor: 'City of Calgary', description: 'Parking ticket', accountId: acct(db, '5810'), amountCents: 75_00, gstCents: 0, paidFromAccountId: bank })
    createExpense(db, { date: '2026-01-15', vendor: 'Apple', description: 'Laptop', accountId: acct(db, '1500'), amountCents: 2_000_00, gstCents: 100_00, paidFromAccountId: bank })
    const t = taxAdjustments(db, '2026-08-31')
    // Book net income: 100,000 − 410 (meals incl. half GST) − 1,050 − 75 = 98,465
    expect(t.netIncomeBooksCents).toBe(98_465_00)
    const add = Object.fromEntries(t.addBacks.map((a) => [a.label, a.amountCents]))
    expect(add['50% of Meals and entertainment (50% deductible)']).toBe(205_00)
    expect(add['Golf, dining and recreational club dues (not deductible)']).toBe(1_050_00)
    expect(add['Fines and penalties (not deductible)']).toBe(75_00)
    expect(t.deductions).toEqual([{ label: 'Capital cost allowance (Schedule 8)', amountCents: 1_650_00 }])
    expect(t.netIncomeForTaxCents).toBe(98_465_00 + 205_00 + 1_050_00 + 75_00 - 1_650_00)
  })
})
