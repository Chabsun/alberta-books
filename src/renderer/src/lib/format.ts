export { formatMoney, formatQuantity, centsToPlain, parseMoney, parseQuantity } from '../../../shared/money'

const short = new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })
const monthOnly = new Intl.DateTimeFormat('en-CA', { month: 'short' })
const monthYear = new Intl.DateTimeFormat('en-CA', { month: 'long', year: 'numeric' })

function toDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

/** 'Oct 14, 2026' */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return short.format(toDate(iso))
}

/** 'Oct' for '2026-10' */
export function formatMonth(yyyymm: string): string {
  return monthOnly.format(toDate(`${yyyymm}-01`))
}

export function formatMonthYear(iso: string): string {
  return monthYear.format(toDate(iso))
}

export function formatDateTime(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleString('en-CA', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

export function relativeTime(isoTimestamp: string): string {
  const diff = Date.now() - Date.parse(isoTimestamp)
  const min = Math.round(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  return `${d} day${d === 1 ? '' : 's'} ago`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
