/**
 * Company vehicle: logbook, the shareholder's taxable benefit from personal
 * use (standby charge + operating cost benefit), the GST the corporation must
 * remit on that benefit, and the CRA caps on lease payments and loan interest.
 *
 * Benefits are per calendar year (they go on your T4A/T4 slips by the end of
 * February). Deduction caps are per fiscal year of the corporation.
 */
import type { Db } from '../db/connection'
import { UserError } from '../errors'
import { isIsoDate } from '../../shared/dates'
import { gstOn, mulDivRound } from '../../shared/money'
import { autoLimits, OPERATING_BENEFIT_GST_RATE_BPS, STANDBY_GST_FRACTION } from '../../shared/taxRules'
import type { Vehicle, VehicleBenefit, VehicleLimits, VehicleTrip } from '../../shared/types'
import { audit } from './audit'
import { getSettings } from './settings'
import { fiscalYearOf } from '../../shared/dates'

interface VehicleRow {
  id: number
  name: string
  ownership: 'owned' | 'leased'
  start_date: string
  end_date: string | null
  cost: number
  msrp: number
  monthly_lease: number
  zero_emission: number
  notes: string
  archived: number
}

function toVehicle(r: VehicleRow): Vehicle {
  return {
    id: r.id,
    name: r.name,
    ownership: r.ownership,
    startDate: r.start_date,
    endDate: r.end_date,
    costCents: r.cost,
    msrpCents: r.msrp,
    monthlyLeaseCents: r.monthly_lease,
    zeroEmission: r.zero_emission === 1,
    notes: r.notes,
    archived: r.archived === 1
  }
}

export function listVehicles(db: Db): Vehicle[] {
  return db.all<VehicleRow>('SELECT * FROM vehicles ORDER BY archived, start_date DESC').map(toVehicle)
}

export function getVehicle(db: Db, id: number): Vehicle {
  const r = db.get<VehicleRow>('SELECT * FROM vehicles WHERE id = ?', id)
  if (!r) throw new UserError('Vehicle not found.')
  return toVehicle(r)
}

export interface VehicleInput {
  id?: number
  name: string
  ownership: 'owned' | 'leased'
  startDate: string
  endDate?: string | null
  costCents?: number
  msrpCents?: number
  monthlyLeaseCents?: number
  zeroEmission?: boolean
  notes?: string
  archived?: boolean
}

export function saveVehicle(db: Db, v: VehicleInput): Vehicle {
  if (v.endDate && v.endDate < v.startDate) throw new UserError('The end date cannot be before the start date.')
  if (v.ownership === 'leased' && !v.monthlyLeaseCents) throw new UserError('Enter the monthly lease payment (before tax).')
  const values = [
    v.name,
    v.ownership,
    v.startDate,
    v.endDate ?? null,
    v.costCents ?? 0,
    v.msrpCents ?? 0,
    v.monthlyLeaseCents ?? 0,
    v.zeroEmission ? 1 : 0,
    v.notes ?? '',
    v.archived ? 1 : 0
  ] as const
  if (v.id === undefined) {
    const { lastInsertRowid } = db.run(
      `INSERT INTO vehicles (name, ownership, start_date, end_date, cost, msrp, monthly_lease, zero_emission, notes, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...values
    )
    audit(db, 'create', 'vehicle', lastInsertRowid, v.name)
    return getVehicle(db, lastInsertRowid)
  }
  getVehicle(db, v.id)
  db.run(
    `UPDATE vehicles SET name = ?, ownership = ?, start_date = ?, end_date = ?, cost = ?, msrp = ?, monthly_lease = ?,
       zero_emission = ?, notes = ?, archived = ? WHERE id = ?`,
    ...values,
    v.id
  )
  audit(db, 'update', 'vehicle', v.id, v.name)
  return getVehicle(db, v.id)
}

// ---------------------------------------------------------------- logbook

export function listTrips(db: Db, vehicleId: number, from: string, to: string): VehicleTrip[] {
  return db
    .all<{ id: number; vehicle_id: number; date: string; km: number; kind: 'business' | 'personal'; purpose: string; route: string }>(
      'SELECT * FROM vehicle_trips WHERE vehicle_id = ? AND date BETWEEN ? AND ? ORDER BY date DESC, id DESC',
      vehicleId,
      from,
      to
    )
    .map((t) => ({ id: t.id, vehicleId: t.vehicle_id, date: t.date, km: t.km, kind: t.kind, purpose: t.purpose, route: t.route }))
}

export interface TripInput {
  vehicleId: number
  date: string
  km: number
  kind: 'business' | 'personal'
  purpose?: string
  route?: string
}

export function addTrip(db: Db, t: TripInput): VehicleTrip {
  getVehicle(db, t.vehicleId)
  if (!isIsoDate(t.date)) throw new UserError('Enter a valid date.')
  // Up to 100,000 so a month's or year's odometer totals can be entered as one line.
  if (!Number.isInteger(t.km) || t.km <= 0 || t.km > 100_000) throw new UserError('Kilometres must be a whole number between 1 and 100,000.')
  if (t.kind === 'business' && !(t.purpose ?? '').trim()) throw new UserError('CRA requires the business purpose of each business trip.')
  const { lastInsertRowid } = db.run(
    'INSERT INTO vehicle_trips (vehicle_id, date, km, kind, purpose, route) VALUES (?, ?, ?, ?, ?, ?)',
    t.vehicleId,
    t.date,
    t.km,
    t.kind,
    t.purpose ?? '',
    t.route ?? ''
  )
  audit(db, 'create', 'vehicle_trip', lastInsertRowid, `${t.km} km ${t.kind}`)
  return listTrips(db, t.vehicleId, t.date, t.date).find((x) => x.id === lastInsertRowid)!
}

export function deleteTrip(db: Db, id: number): void {
  const t = db.get<{ date: string }>('SELECT date FROM vehicle_trips WHERE id = ?', id)
  if (!t) throw new UserError('Trip not found.')
  const { lockDate } = getSettings(db)
  if (lockDate && t.date <= lockDate) throw new UserError('That trip is in a locked period.')
  db.run('DELETE FROM vehicle_trips WHERE id = ?', id)
  audit(db, 'delete', 'vehicle_trip', id, t.date)
}

export function setVehicleYear(
  db: Db,
  vehicleId: number,
  year: number,
  v: { reimbursedOperatingCents: number; reimbursedStandbyCents: number; electHalfStandby: boolean }
): void {
  db.run(
    `INSERT INTO vehicle_years (vehicle_id, year, reimbursed_operating, reimbursed_standby, elect_half_standby) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(vehicle_id, year) DO UPDATE SET reimbursed_operating = excluded.reimbursed_operating,
       reimbursed_standby = excluded.reimbursed_standby, elect_half_standby = excluded.elect_half_standby`,
    vehicleId,
    year,
    v.reimbursedOperatingCents,
    v.reimbursedStandbyCents,
    v.electHalfStandby ? 1 : 0
  )
  audit(db, 'update', 'vehicle_year', vehicleId, `${year} reimbursements and election`)
}

// ---------------------------------------------------------------- helpers

function daysBetweenInclusive(a: string, b: string): number {
  const [y1, m1, d1] = a.split('-').map(Number)
  const [y2, m2, d2] = b.split('-').map(Number)
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000) + 1
}

/** Days the vehicle was owned or leased within [from, to]. */
function daysAvailable(v: Vehicle, from: string, to: string): number {
  const start = v.startDate > from ? v.startDate : from
  const end = v.endDate && v.endDate < to ? v.endDate : to
  return end < start ? 0 : daysBetweenInclusive(start, end)
}

function km(db: Db, vehicleId: number, from: string, to: string) {
  const r = db.get<{ b: number; p: number; n: number }>(
    `SELECT COALESCE(SUM(CASE WHEN kind = 'business' THEN km END), 0) AS b,
            COALESCE(SUM(CASE WHEN kind = 'personal' THEN km END), 0) AS p, COUNT(*) AS n
     FROM vehicle_trips WHERE vehicle_id = ? AND date BETWEEN ? AND ?`,
    vehicleId,
    from,
    to
  )!
  return { business: r.b, personal: r.p, trips: r.n }
}

// ---------------------------------------------------------------- benefit (calendar year)

/**
 * The taxable benefit to you for a calendar year, and the GST the corporation
 * must remit on it (CRA T4130; ETA s.173). Standby charge: 2% of cost per
 * month available (owned) or 2/3 of lease cost (leased), reduced when business
 * use is over 50% and personal driving is under 1,667 km a month. Operating
 * cost benefit: the prescribed rate per personal km (34¢ for 2025-2026), or
 * half the standby charge when you elect it and business use is over 50%.
 */
export function vehicleBenefit(db: Db, vehicleId: number, year: number): VehicleBenefit {
  const v = getVehicle(db, vehicleId)
  const from = `${year}-01-01`
  const to = `${year}-12-31`
  const days = daysAvailable(v, from, to)
  const months = Math.round(days / 30)
  const { business, personal, trips } = km(db, vehicleId, from, to)
  const total = business + personal
  const businessUseOver50 = total > 0 && business * 2 > total
  const yearRow = db.get<{ reimbursed_operating: number; reimbursed_standby: number; elect_half_standby: number }>(
    'SELECT * FROM vehicle_years WHERE vehicle_id = ? AND year = ?',
    vehicleId,
    year
  )
  const limits = autoLimits(year)
  const notes: string[] = []

  let standbyFull: number
  if (v.ownership === 'owned') {
    const costWithTax = v.costCents + gstOn(v.costCents)
    standbyFull = mulDivRound(costWithTax, 2 * months, 100)
  } else {
    // Two-thirds of the lease cost (excluding insurance) for the days available.
    const leaseWithTax = v.monthlyLeaseCents + gstOn(v.monthlyLeaseCents)
    standbyFull = mulDivRound(leaseWithTax * 2, days, 3 * 30)
  }
  let reductionFactor = 1
  if (businessUseOver50 && months > 0) {
    reductionFactor = Math.min(1, personal / (1667 * months))
    notes.push('Reduced standby charge: business use is over 50% of all driving.')
  } else if (total > 0) {
    notes.push('Full standby charge: business use is 50% or less of all driving.')
  }
  const standbyGross = Math.round(standbyFull * reductionFactor)
  const standby = Math.max(0, standbyGross - (yearRow?.reimbursed_standby ?? 0))

  let operatingGross: number
  if (personal === 0) operatingGross = 0
  else if (yearRow?.elect_half_standby === 1 && businessUseOver50) {
    operatingGross = Math.round(standbyGross / 2)
    notes.push('Operating benefit at half the standby charge (election in writing required).')
  } else operatingGross = personal * limits.operatingBenefitPerKm
  const operating = Math.max(0, operatingGross - (yearRow?.reimbursed_operating ?? 0))

  const gstOnStandby = mulDivRound(standbyGross, STANDBY_GST_FRACTION.numerator, STANDBY_GST_FRACTION.denominator)
  const gstOnOperating = mulDivRound(operatingGross, OPERATING_BENEFIT_GST_RATE_BPS, 10_000)

  if (trips === 0 && days > 0) notes.push('No trips logged this year: CRA treats undocumented driving as personal. Keep a logbook.')
  if (!limits.known) notes.push(`CRA rates for ${year} are not in the app yet; ${limits.year} rates are used.`)
  notes.push(`Report the benefit on your slip for ${year} by the end of February ${year + 1}, and remit the GST in the GST return that covers the last day of February ${year + 1}.`)

  return {
    vehicleId,
    year,
    daysAvailable: days,
    monthsAvailable: months,
    businessKm: business,
    personalKm: personal,
    businessUsePct: total > 0 ? Math.round((business / total) * 1000) / 10 : 0,
    standbyChargeCents: standby,
    operatingBenefitCents: operating,
    totalBenefitCents: standby + operating,
    gstToRemitCents: gstOnStandby + gstOnOperating,
    reimbursedOperatingCents: yearRow?.reimbursed_operating ?? 0,
    reimbursedStandbyCents: yearRow?.reimbursed_standby ?? 0,
    electHalfStandby: yearRow?.elect_half_standby === 1,
    operatingRatePerKmCents: limits.operatingBenefitPerKm,
    notes
  }
}

// ---------------------------------------------------------------- deduction caps (fiscal year)

function ledgerTotal(db: Db, rule: string, from: string, to: string): number {
  return (
    db.get<{ s: number }>(
      `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS s FROM ledger l JOIN accounts a ON a.id = l.account_id
       WHERE a.tax_rule = ? AND l.date BETWEEN ? AND ?`,
      rule,
      from,
      to
    )?.s ?? 0
  )
}

/**
 * Lease and interest caps for the fiscal year containing `fiscalYearEnd`.
 * Lease (Reg. 7307): deductible = lesser of
 *   A: monthly cap × days leased / 30, and
 *   B: lease cost × class 10.1 ceiling / greater of (ceiling, 85% of list price).
 * Interest: monthly cap × days owned / 30. The rest is added back for tax, and
 * the GST claimed on the excess lease cost is repaid at year end (ETA s.235).
 * All vehicle lease/interest costs in the books are attributed to this vehicle.
 */
export function vehicleLimits(db: Db, vehicleId: number, fiscalYearEnd: string): VehicleLimits {
  const v = getVehicle(db, vehicleId)
  const { fiscalYearEndMonth } = getSettings(db)
  const fy = fiscalYearOf(fiscalYearEnd, fiscalYearEndMonth)
  const days = daysAvailable(v, fy.start, fy.end)
  const startYearLimits = autoLimits(Number(v.startDate.slice(0, 4)))

  const leaseCost = ledgerTotal(db, 'vehicle_lease', fy.start, fy.end)
  let leaseAllowed = leaseCost
  let leaseFormulaA = 0
  let leaseFormulaB = 0
  if (v.ownership === 'leased' && leaseCost > 0) {
    leaseFormulaA = mulDivRound(startYearLimits.leasePerMonth, days, 30)
    const ceiling = startYearLimits.ccaCeiling
    const denominator = Math.max(ceiling, mulDivRound(v.msrpCents, 85, 100))
    leaseFormulaB = mulDivRound(leaseCost, ceiling, denominator)
    leaseAllowed = Math.min(leaseCost, leaseFormulaA, leaseFormulaB)
  }
  const leaseExcess = leaseCost - leaseAllowed

  const interestCost = ledgerTotal(db, 'vehicle_interest', fy.start, fy.end)
  const interestCap = mulDivRound(startYearLimits.interestPerMonth, days, 30)
  const interestAllowed = Math.min(interestCost, interestCap)

  return {
    vehicleId,
    fiscalYearStart: fy.start,
    fiscalYearEnd: fy.end,
    daysInYear: days,
    leaseCostCents: leaseCost,
    leaseFormulaACents: leaseFormulaA,
    leaseFormulaBCents: leaseFormulaB,
    leaseDeductibleCents: leaseAllowed,
    leaseExcessCents: leaseExcess,
    leaseItcRepayCents: gstOn(leaseExcess),
    interestCostCents: interestCost,
    interestCapCents: interestCap,
    interestExcessCents: interestCost - interestAllowed
  }
}
