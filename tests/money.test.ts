import { describe, expect, it } from 'vitest'
import { centsToPlain, formatQuantity, gstIncluded, gstOn, lineAmount, mulDivRound, parseMoney, parseQuantity } from '../src/shared/money'
import { addDays, fiscalYearOf, isIsoDate, lastMonths, parseCsvDate, quarterOf } from '../src/shared/dates'

describe('money', () => {
  it('parses typed amounts exactly, without float error', () => {
    expect(parseMoney('0.1')).toBe(10)
    expect(parseMoney('1,234.56')).toBe(123456)
    expect(parseMoney('$12')).toBe(1200)
    expect(parseMoney('-5.5')).toBe(-550)
    expect(parseMoney('(12.00)')).toBe(-1200)
    expect(parseMoney('-$3.10')).toBe(-310)
    expect(parseMoney('.75')).toBe(75)
    expect(parseMoney('19.99')).toBe(1999)
    expect(parseMoney('0.29')).toBe(29) // 0.29 * 100 = 28.999999999999996 in floats
  })

  it('rejects anything that is not an amount', () => {
    for (const bad of ['', 'abc', '1.234', '1,23.00', '12e3', '--1', '1.2.3', '$', '.']) {
      expect(parseMoney(bad), bad).toBeNull()
    }
  })

  it('rounds GST half-up to the cent (CRA rule)', () => {
    expect(gstOn(10000)).toBe(500)
    expect(gstOn(10)).toBe(1) // 0.5 cent rounds up
    expect(gstOn(9)).toBe(0) // 0.45 cent rounds down
    expect(gstOn(-10)).toBe(-1) // symmetric for credits
    expect(gstOn(1999)).toBe(100) // 99.95 -> 100
  })

  it('extracts GST from tax-included amounts', () => {
    expect(gstIncluded(10500)).toBe(500)
    expect(gstIncluded(2100)).toBe(100)
    expect(gstIncluded(1)).toBe(0)
  })

  it('computes line amounts from quantity in thousandths', () => {
    expect(lineAmount(1500, 12000)).toBe(18000) // 1.5 h at $120
    expect(lineAmount(333, 100)).toBe(33)
    expect(lineAmount(1000, -2500)).toBe(-2500)
  })

  it('never loses precision on large products', () => {
    expect(mulDivRound(99_999_999_999, 1_000_000, 1_000_000)).toBe(99_999_999_999)
  })

  it('parses and formats quantities', () => {
    expect(parseQuantity('2.5')).toBe(2500)
    expect(parseQuantity('0.125')).toBe(125)
    expect(parseQuantity('1.2345')).toBeNull()
    expect(parseQuantity('-1')).toBeNull()
    expect(formatQuantity(2500)).toBe('2.5')
    expect(formatQuantity(3000)).toBe('3')
  })

  it('formats plain amounts', () => {
    expect(centsToPlain(-1205)).toBe('-12.05')
    expect(centsToPlain(7)).toBe('0.07')
  })
})

describe('dates', () => {
  it('validates real calendar dates only', () => {
    expect(isIsoDate('2026-02-28')).toBe(true)
    expect(isIsoDate('2026-02-29')).toBe(false)
    expect(isIsoDate('2028-02-29')).toBe(true)
    expect(isIsoDate('2026-13-01')).toBe(false)
    expect(isIsoDate('26-01-01')).toBe(false)
  })

  it('finds fiscal years for any year-end month', () => {
    expect(fiscalYearOf('2026-05-10', 12)).toEqual({ start: '2026-01-01', end: '2026-12-31' })
    expect(fiscalYearOf('2026-08-01', 6)).toEqual({ start: '2026-07-01', end: '2027-06-30' })
    expect(fiscalYearOf('2026-03-31', 6)).toEqual({ start: '2025-07-01', end: '2026-06-30' })
    expect(fiscalYearOf('2028-02-10', 2)).toEqual({ start: '2027-03-01', end: '2028-02-29' })
  })

  it('handles helpers', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(lastMonths('2026-02-15', 3)).toEqual(['2025-12', '2026-01', '2026-02'])
    expect(quarterOf('2026-05-04')).toEqual({ start: '2026-04-01', end: '2026-06-30' })
    expect(parseCsvDate('10/14/2026', 'mdy')).toBe('2026-10-14')
    expect(parseCsvDate('14/10/2026', 'dmy')).toBe('2026-10-14')
    expect(parseCsvDate('2026-10-14', 'ymd')).toBe('2026-10-14')
    expect(parseCsvDate('31/02/2026', 'dmy')).toBeNull()
  })
})
