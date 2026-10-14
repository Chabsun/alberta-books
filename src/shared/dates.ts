/**
 * Calendar dates are stored as 'YYYY-MM-DD' strings in the user's local time.
 * (new Date().toISOString() is UTC and would book an evening sale in Alberta
 * on the next day, so it is never used for business dates.)
 */

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string') return false
  const m = ISO_DATE_RE.exec(s)
  if (!m) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (y < 1900 || y > 2200) return false
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function todayIso(): string {
  return toIsoDate(new Date())
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

export function daysBetween(fromIso: string, toIso: string): number {
  const [y1, m1, d1] = fromIso.split('-').map(Number)
  const [y2, m2, d2] = toIso.split('-').map(Number)
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000)
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * Start and end of the fiscal year containing `iso`, given the fiscal
 * year-end month (1-12). The year end is the last day of that month.
 */
export function fiscalYearOf(iso: string, yearEndMonth: number): { start: string; end: string } {
  const [y, m] = iso.split('-').map(Number)
  const endYear = m > yearEndMonth ? y + 1 : y
  const end = `${endYear}-${pad(yearEndMonth)}-${pad(lastDayOfMonth(endYear, yearEndMonth))}`
  const startMonth = (yearEndMonth % 12) + 1
  const startYear = yearEndMonth === 12 ? endYear : endYear - 1
  const start = `${startYear}-${pad(startMonth)}-01`
  return { start, end }
}

export function monthStart(iso: string): string {
  return iso.slice(0, 8) + '01'
}

export function monthEnd(iso: string): string {
  const [y, m] = iso.split('-').map(Number)
  return `${y}-${pad(m)}-${pad(lastDayOfMonth(y, m))}`
}

/** 'YYYY-MM' keys for the `count` months ending with the month of `iso`. */
export function lastMonths(iso: string, count: number): string[] {
  const [y, m] = iso.split('-').map(Number)
  const out: string[] = []
  for (let i = count - 1; i >= 0; i--) {
    const dt = new Date(Date.UTC(y, m - 1 - i, 1))
    out.push(`${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}`)
  }
  return out
}

/** Calendar quarter containing `iso`. */
export function quarterOf(iso: string): { start: string; end: string } {
  const [y, m] = iso.split('-').map(Number)
  const qStart = Math.floor((m - 1) / 3) * 3 + 1
  return { start: `${y}-${pad(qStart)}-01`, end: monthEnd(`${y}-${pad(qStart + 2)}-01`) }
}

/**
 * Parses dates found in bank CSV exports. Returns 'YYYY-MM-DD' or null.
 * 'ymd' covers 2026-10-14 / 2026/10/14; 'mdy' and 'dmy' cover slash formats.
 */
export type CsvDateFormat = 'ymd' | 'mdy' | 'dmy'

export function parseCsvDate(raw: string, format: CsvDateFormat): string | null {
  const s = raw.trim()
  const parts = s.split(/[-/.\s]+/)
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return null
  let y: number, m: number, d: number
  if (format === 'ymd') [y, m, d] = parts.map(Number)
  else if (format === 'mdy') [m, d, y] = parts.map(Number)
  else [d, m, y] = parts.map(Number)
  if (y < 100) y += 2000
  const iso = `${y}-${pad(m)}-${pad(d)}`
  return isIsoDate(iso) ? iso : null
}
