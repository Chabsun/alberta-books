/**
 * Capital cost allowance (T2 Schedule 8), declining balance by class.
 *
 * First-year treatment of additions (net of disposals in the same year):
 *  - acquired 2025-01-01 or later and available for use before 2034
 *    (reinstated Accelerated Investment Incentive, Bill C-15, Royal Assent
 *    March 26, 2026): before 2030, 1.5× the full rate (3× the half-year
 *    amount); 2030-2033, the full rate (half-year rule suspended);
 *  - zero-emission passenger vehicles (class 54) acquired 2025+ and available
 *    before 2030: written off in full in the first year (up to the ceiling);
 *  - acquired after Nov 20, 2018 and available before 2024: 1.5× (original AII);
 *  - available 2024-2027 and acquired before 2025: full rate (AII phase-out);
 *  - otherwise the half-year rule (half the rate) for classes subject to it.
 * Short fiscal years are prorated by days / 365. Class 10.1 is a separate
 * class per vehicle with no recapture or terminal loss, and half CCA in the
 * year it is sold. Prior years assume the maximum CCA was claimed.
 */
import type { Db } from '../db/connection'
import { addDays, fiscalYearOf } from '../../shared/dates'
import { CCA_CLASSES, type CcaClassId } from '../../shared/taxRules'
import type { CcaRow, CcaSchedule } from '../../shared/types'
import { getSettings } from './settings'

interface AssetRow {
  id: number
  description: string
  cca_class: CcaClassId
  cost: number
  acquired_date: string
  available_date: string
  disposed_date: string | null
  proceeds: number | null
}

/** Multiplier on the rate for the first year, by acquisition and available-for-use dates. */
export function firstYearFactor(ccaClass: CcaClassId, acquired: string, available: string): number {
  const cls = CCA_CLASSES[ccaClass]
  if (acquired >= '2025-01-01' && available < '2034-01-01') {
    if (ccaClass === '54' && available < '2030-01-01') return Infinity // full write-off
    return available < '2030-01-01' ? 1.5 : 1
  }
  if (acquired > '2018-11-20' && available < '2024-01-01') return 1.5
  if (available >= '2024-01-01' && available < '2028-01-01') return 1
  return cls.halfYear ? 0.5 : 1
}

function days(from: string, to: string): number {
  const [y1, m1, d1] = from.split('-').map(Number)
  const [y2, m2, d2] = to.split('-').map(Number)
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000) + 1
}

/** Pool key: one pool per class, except class 10.1 (one per vehicle). */
const poolKey = (a: AssetRow) => (a.cca_class === '10.1' ? `10.1#${a.id}` : a.cca_class)

export function ccaSchedule(db: Db, fiscalYearEnd: string): CcaSchedule {
  const { fiscalYearEndMonth } = getSettings(db)
  const target = fiscalYearOf(fiscalYearEnd, fiscalYearEndMonth)
  const assets = db.all<AssetRow>('SELECT * FROM assets ORDER BY available_date, id')
  const openings = db.all<{ cca_class: CcaClassId; as_of: string; ucc: number }>('SELECT * FROM cca_opening')

  const firstDates = [...assets.map((a) => a.available_date), ...openings.map((o) => addDays(o.as_of, 1))].sort()
  if (firstDates.length === 0) return { fiscalYearStart: target.start, fiscalYearEnd: target.end, rows: [], totalCcaCents: 0, notes: [] }

  // Walk fiscal years from the earliest activity to the target year, carrying UCC.
  const ucc = new Map<string, number>()
  let fy = fiscalYearOf(firstDates[0], fiscalYearEndMonth)
  let rows: CcaRow[] = []
  const notes: string[] = []
  for (let guard = 0; guard < 100; guard++) {
    rows = []
    const yearDays = days(fy.start, fy.end)
    const prorate = yearDays < 357 ? yearDays / 365 : 1
    for (const o of openings) {
      if (o.as_of >= addDays(fy.start, -1) && o.as_of < fy.end && !ucc.has(o.cca_class)) ucc.set(o.cca_class, o.ucc)
    }
    const keys = new Set<string>([...ucc.keys()])
    for (const a of assets) if (a.available_date <= fy.end && (!a.disposed_date || a.disposed_date >= fy.start)) keys.add(poolKey(a))

    for (const key of [...keys].sort()) {
      const ccaClass = key.split('#')[0] as CcaClassId
      const cls = CCA_CLASSES[ccaClass]
      const inPool = assets.filter((a) => poolKey(a) === key)
      const opening = ucc.get(key) ?? 0
      const added = inPool.filter((a) => a.available_date >= fy.start && a.available_date <= fy.end)
      const disposed = inPool.filter((a) => a.disposed_date && a.disposed_date >= fy.start && a.disposed_date <= fy.end)
      const additions = added.reduce((s, a) => s + a.cost, 0)
      const disposals = disposed.reduce((s, a) => s + Math.min(a.proceeds ?? 0, a.cost), 0)
      let before = opening + additions - disposals
      let cca = 0
      let recapture = 0
      let terminalLoss = 0
      let adjustment = 0
      if (before < 0 && ccaClass !== '10.1') {
        recapture = -before
        before = 0
      } else if (before > 0) {
        // Incentive adjustment applies to additions net of this year's disposals.
        const net = Math.max(0, additions - disposals)
        const scale = additions > 0 ? net / additions : 0
        let immediate = 0
        for (const a of added) {
          const f = firstYearFactor(ccaClass, a.acquired_date, a.available_date)
          if (f === Infinity) immediate += a.cost * scale
          else adjustment += a.cost * scale * (f - 1)
        }
        const base = before - immediate + adjustment
        cca = Math.round(Math.max(0, base) * cls.rate * prorate + immediate)
        if (ccaClass === '10.1' && disposed.length > 0) cca = Math.round((opening * cls.rate * prorate) / 2)
        cca = Math.min(cca, before)
        const remaining = inPool.filter((a) => !a.disposed_date || a.disposed_date > fy.end)
        if (remaining.length === 0 && ccaClass !== '10.1' && ucc.has(key) && before - cca > 0 && disposed.length > 0) {
          terminalLoss = before - cca
        }
      }
      let closing = before - cca - terminalLoss
      if (ccaClass === '10.1' && disposed.length > 0) closing = 0
      ucc.set(key, closing)
      if (opening || additions || disposals || cca || closing) {
        rows.push({
          ccaClass: cls.number,
          label: ccaClass === '10.1' ? `${cls.label}: ${inPool[0]?.description ?? ''}` : cls.label,
          ratePct: cls.rate * 100,
          openingUccCents: opening,
          additionsCents: additions,
          disposalsCents: disposals,
          incentiveAdjustmentCents: Math.round(adjustment),
          ccaCents: cca,
          recaptureCents: recapture,
          terminalLossCents: terminalLoss,
          closingUccCents: closing
        })
      }
    }
    if (fy.end >= target.end) break
    fy = fiscalYearOf(addDays(fy.end, 1), fiscalYearEndMonth)
  }

  if (rows.some((r) => r.recaptureCents > 0)) notes.push('Recapture: proceeds exceeded the class balance; the excess is income.')
  if (rows.some((r) => r.terminalLossCents > 0)) notes.push('Terminal loss: the class is empty with a balance left; it is deductible.')
  notes.push('Assumes the maximum CCA was claimed in earlier years. If your T2 claimed less, enter the actual opening balances (UCC).')
  return {
    fiscalYearStart: target.start,
    fiscalYearEnd: target.end,
    rows,
    totalCcaCents: rows.reduce((s, r) => s + r.ccaCents, 0),
    notes
  }
}

export function setOpeningUcc(db: Db, ccaClass: CcaClassId, asOf: string, uccCents: number): void {
  db.run(
    `INSERT INTO cca_opening (cca_class, as_of, ucc) VALUES (?, ?, ?)
     ON CONFLICT(cca_class) DO UPDATE SET as_of = excluded.as_of, ucc = excluded.ucc`,
    ccaClass,
    asOf,
    uccCents
  )
}

export function listAssets(db: Db) {
  return db
    .all<AssetRow & { account_id: number | null }>('SELECT * FROM assets ORDER BY available_date DESC, id DESC')
    .map((a) => ({
      id: a.id,
      description: a.description,
      ccaClass: a.cca_class,
      costCents: a.cost,
      acquiredDate: a.acquired_date,
      availableDate: a.available_date,
      disposedDate: a.disposed_date,
      proceedsCents: a.proceeds
    }))
}

export function disposeAsset(db: Db, id: number, date: string, proceedsCents: number): void {
  db.run('UPDATE assets SET disposed_date = ?, proceeds = ? WHERE id = ? AND disposed_date IS NULL', date, proceedsCents, id)
}
