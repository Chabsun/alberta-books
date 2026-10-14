import { addDays, fiscalYearOf, monthEnd, monthStart, quarterOf, todayIso } from '../../../shared/dates'

export interface Period {
  id: string
  label: string
  from: string
  to: string
}

/** Standard reporting periods relative to today and the fiscal year end. */
export function standardPeriods(fiscalYearEndMonth: number): Period[] {
  const today = todayIso()
  const fy = fiscalYearOf(today, fiscalYearEndMonth)
  const lastFy = fiscalYearOf(addDays(fy.start, -1), fiscalYearEndMonth)
  const q = quarterOf(today)
  const lastQ = quarterOf(addDays(q.start, -1))
  const lastMonthEnd = addDays(monthStart(today), -1)
  return [
    { id: 'fy', label: 'This fiscal year', from: fy.start, to: fy.end },
    { id: 'lastfy', label: 'Last fiscal year', from: lastFy.start, to: lastFy.end },
    { id: 'q', label: 'This quarter', from: q.start, to: q.end },
    { id: 'lastq', label: 'Last quarter', from: lastQ.start, to: lastQ.end },
    { id: 'm', label: 'This month', from: monthStart(today), to: monthEnd(today) },
    { id: 'lastm', label: 'Last month', from: monthStart(lastMonthEnd), to: lastMonthEnd }
  ]
}
