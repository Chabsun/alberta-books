/** Minimal RFC 4180 CSV reading and writing. */

/**
 * Parses CSV text into rows of cells. Handles quoted fields, escaped quotes,
 * commas and newlines inside quotes, CRLF line endings and a UTF-8 BOM.
 */
export function parseCsv(text: string): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"'
          i++
        } else inQuotes = false
      } else cell += ch
    } else if (ch === '"' && cell === '') inQuotes = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

/**
 * Text cells starting with = + - @ (or tab/CR) can be run as formulas by
 * Excel or Numbers. Such cells are prefixed with an apostrophe so a CSV
 * exported from the app can never execute anything when opened.
 */
function safeCell(v: string | number): string {
  if (typeof v === 'number') return String(v)
  let s = v
  // A plain negative number like -42.00 is data, not a formula.
  if (/^[=+\-@\t\r]/.test(s) && !/^-\d+(\.\d+)?$/.test(s)) s = `'${s}`
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`
  return s
}

export function toCsv(rows: (string | number)[][]): string {
  return '﻿' + rows.map((r) => r.map(safeCell).join(',')).join('\r\n') + '\r\n'
}
