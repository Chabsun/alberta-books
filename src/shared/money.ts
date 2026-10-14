/**
 * Money and quantity helpers.
 *
 * Every amount in this app is an integer number of cents. Floating point is
 * never used to store or add money: 0.1 + 0.2 !== 0.3 in JavaScript, and a
 * ledger that is off by a cent does not balance.
 *
 * Quantities are integer thousandths ("milli") so that 1.5 hours is 1500.
 */

export const GST_RATE_BPS = 500 // 5.00% in basis points (Alberta: GST only, no PST)

const MAX_SAFE_CENTS = 99_999_999_999_99 // $99 billion; far beyond any real amount

export function isCents(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && Math.abs(n) <= MAX_SAFE_CENTS
}

/**
 * Computes round(a * b / d) with halves rounded away from zero (CRA rounding:
 * fractions of a cent of one-half or more are rounded up).
 * Uses BigInt so intermediate products cannot lose precision.
 */
export function mulDivRound(a: number, b: number, d: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(d) || d === 0) {
    throw new RangeError('mulDivRound expects safe integers and a non-zero divisor')
  }
  const product = BigInt(a) * BigInt(b)
  const divisor = BigInt(d)
  const negative = product < 0n !== divisor < 0n
  const absP = product < 0n ? -product : product
  const absD = divisor < 0n ? -divisor : divisor
  const rounded = (absP * 2n + absD) / (absD * 2n)
  const result = Number(negative ? -rounded : rounded)
  if (!Number.isSafeInteger(result)) throw new RangeError('Amount out of range')
  return result
}

/** GST on a pre-tax amount, rounded to the cent. */
export function gstOn(amountCents: number, rateBps: number = GST_RATE_BPS): number {
  return mulDivRound(amountCents, rateBps, 10_000)
}

/** GST contained in a tax-included amount (e.g. a bank withdrawal of $105.00 holds $5.00). */
export function gstIncluded(grossCents: number, rateBps: number = GST_RATE_BPS): number {
  return mulDivRound(grossCents, rateBps, 10_000 + rateBps)
}

/** Line amount for a quantity (in thousandths) times a unit price (in cents). */
export function lineAmount(qtyMilli: number, unitPriceCents: number): number {
  return mulDivRound(qtyMilli, unitPriceCents, 1000)
}

const MONEY_RE = /^(-)?\$?\s*(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d{0,2}))?$/

/**
 * Parses user-typed money ("1,234.56", "$12", "-5.5", "(12.00)") into cents.
 * Returns null for anything that is not a plain amount with at most 2 decimals.
 * Parses the digits as text, so there is no float rounding.
 */
export function parseMoney(input: string): number | null {
  let s = input.trim().replace(/\s+/g, '')
  if (s === '') return null
  let negative = false
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true
    s = s.slice(1, -1)
  }
  if (s.startsWith('-$')) s = '-' + s.slice(2)
  if (s.startsWith('$-')) s = '-' + s.slice(2)
  const m = MONEY_RE.exec(s)
  if (!m) return null
  const [, sign, whole, frac] = m
  if (whole === undefined && (frac === undefined || frac === '')) return null
  const dollars = Number((whole ?? '0').replace(/,/g, ''))
  const cents = Number((frac ?? '').padEnd(2, '0'))
  const total = dollars * 100 + cents
  if (!isCents(total)) return null
  return (negative || sign === '-') && total !== 0 ? -total : total
}

const QTY_RE = /^(\d+)?(?:\.(\d{0,3}))?$/

/** Parses a quantity like "1", "2.5" or "0.125" into thousandths. */
export function parseQuantity(input: string): number | null {
  const s = input.trim().replace(/,/g, '')
  const m = QTY_RE.exec(s)
  if (!m || (m[1] === undefined && !m[2])) return null
  const milli = Number(m[1] ?? '0') * 1000 + Number((m[2] ?? '').padEnd(3, '0'))
  return Number.isSafeInteger(milli) ? milli : null
}

export function formatQuantity(milli: number): string {
  const whole = Math.trunc(milli / 1000)
  const frac = Math.abs(milli % 1000)
  if (frac === 0) return String(whole)
  return `${whole}.${String(frac).padStart(3, '0').replace(/0+$/, '')}`
}

const cad = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })

/** "$1,234.56" / "-$12.00". Divides by 100 only for display. */
export function formatMoney(cents: number): string {
  return cad.format((cents || 0) / 100) // `|| 0` turns -0 into 0, so it never shows "-$0.00"
}

/** Plain "1234.56" for inputs and CSV files. */
export function centsToPlain(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}
