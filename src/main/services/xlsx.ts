/**
 * Minimal .xlsx writer and reader (Office Open XML), built on fflate's zip.
 *
 * Writer: every text cell is an inline string, never a formula, so exported
 * workbooks cannot execute anything when opened. Money columns get a number
 * format; the header row is bold and frozen.
 *
 * Reader: first worksheet as rows of strings (shared strings, inline strings,
 * numbers, and Excel date serials in date-formatted cells), for importing
 * QuickBooks/Zoho journal exports.
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'

export type Cell = string | number | null

export interface Sheet {
  name: string
  /** Rows before the header (title lines). */
  title?: string[]
  header: string[]
  rows: Cell[][]
  /** Column indexes holding dollar amounts (2 decimals). */
  moneyColumns?: number[]
  /** Bold rows (e.g. totals), as indexes into `rows`. */
  boldRows?: number[]
}

const esc = (s: string) =>
  s
    // Characters not allowed in XML 1.0
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

function colName(i: number): string {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

function safeSheetName(name: string, used: Set<string>): string {
  const base = name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31).trim() || 'Sheet'
  let n = base
  for (let i = 2; used.has(n.toLowerCase()); i++) n = `${base.slice(0, 28)} ${i}`
  used.add(n.toLowerCase())
  return n
}

// Style indexes in styles.xml: 0 default, 1 bold, 2 money, 3 bold money, 4 title
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00;-#,##0.00"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="0"/>
</styleSheet>`

function sheetXml(sheet: Sheet): string {
  const money = new Set(sheet.moneyColumns ?? [])
  const bold = new Set(sheet.boldRows ?? [])
  const rows: string[] = []
  let r = 0
  const cell = (c: number, value: Cell, style: number) => {
    const ref = `${colName(c)}${r}`
    if (value === null || value === '') return ''
    if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}" s="${style}"><v>${value}</v></c>`
    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(String(value))}</t></is></c>`
  }
  for (const [i, t] of (sheet.title ?? []).entries()) {
    r++
    rows.push(`<row r="${r}">${cell(0, t, i === 0 ? 4 : 0)}</row>`)
  }
  if (sheet.title?.length) {
    r++
    rows.push(`<row r="${r}"/>`)
  }
  r++
  const headerRow = r
  rows.push(`<row r="${r}">${sheet.header.map((h, c) => cell(c, h, 1)).join('')}</row>`)
  sheet.rows.forEach((row, i) => {
    r++
    const b = bold.has(i)
    rows.push(`<row r="${r}">${row.map((v, c) => cell(c, v, money.has(c) ? (b ? 3 : 2) : b ? 1 : 0)).join('')}</row>`)
  })
  const widths = sheet.header.map((h, c) => {
    const longest = Math.max(h.length, ...sheet.rows.slice(0, 400).map((row) => String(row[c] ?? '').length))
    return Math.min(60, Math.max(10, longest + 2))
  })
  const cols = `<cols>${widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
  const pane = `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${cols}<sheetData>${rows.join('')}</sheetData></worksheet>`
}

export function writeXlsx(sheets: Sheet[]): Uint8Array {
  const used = new Set<string>()
  const names = sheets.map((s) => safeSheetName(s.name, used))
  const files: Zippable = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names
      .map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'xl/styles.xml': strToU8(STYLES)
  }
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s))
  })
  return zipSync(files, { level: 6 })
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

const unesc = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')

function textOf(xml: string): string {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unesc(m[1])).join('')
}

function colIndex(ref: string): number {
  const letters = ref.replace(/\d+/g, '')
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** Excel serial date → YYYY-MM-DD (1900 date system). */
function serialToIso(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000)
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

const MAX_UNZIPPED = 50 * 1024 * 1024

/** Reads the first worksheet of an .xlsx file into rows of strings. */
export function readXlsxFirstSheet(data: Uint8Array): string[][] {
  let total = 0
  const files = unzipSync(data, {
    filter: (f) => {
      total += f.originalSize
      if (total > MAX_UNZIPPED) throw new Error('The spreadsheet is too large.')
      return /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/sheet\d+\.xml)$/.test(f.name)
    }
  })
  const get = (p: string) => (files[p] ? strFromU8(files[p]) : '')

  const workbook = get('xl/workbook.xml')
  const rels = get('xl/_rels/workbook.xml.rels')
  const firstRid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1]
  const target = firstRid ? new RegExp(`Id="${firstRid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ?? new RegExp(`Target="([^"]+)"[^>]*Id="${firstRid}"`).exec(rels)?.[1] : undefined
  const sheetPath = target ? `xl/${target.replace(/^\/?xl\//, '').replace(/^\//, '')}` : 'xl/worksheets/sheet1.xml'
  const sheet = get(sheetPath) || get('xl/worksheets/sheet1.xml')
  if (!sheet) throw new Error('No worksheet found in the spreadsheet.')

  const shared = [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]))

  // Which style indexes are dates (built-in date formats 14-22, 45-47, or custom with d/m/y).
  const styles = get('xl/styles.xml')
  const customDate = new Set(
    [...styles.matchAll(/<numFmt\s+numFmtId="(\d+)"\s+formatCode="([^"]*)"/g)]
      .filter((m) => /[dy]/i.test(m[2].replace(/"[^"]*"/g, '')) && !/[#0]/.test(m[2]))
      .map((m) => Number(m[1]))
  )
  const cellXfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? ''
  const dateStyles = new Set<number>()
  ;[...cellXfs.matchAll(/<xf\b([^>]*)\/?>/g)].forEach((m, i) => {
    const id = Number(/numFmtId="(\d+)"/.exec(m[1])?.[1] ?? 0)
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || customDate.has(id)) dateStyles.add(i)
  })

  const out: string[][] = []
  for (const rowM of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row: string[] = []
    for (const cM of (rowM[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cM[1]
      const inner = cM[2] ?? ''
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1]
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1]
      const style = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? 0)
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]
      let value = ''
      if (type === 's') value = shared[Number(v)] ?? ''
      else if (type === 'inlineStr') value = textOf(inner)
      else if (type === 'str' || type === 'e') value = v ? unesc(v) : ''
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE'
      else if (v !== undefined) value = dateStyles.has(style) ? serialToIso(Number(v)) : v
      const c = ref ? colIndex(ref) : row.length
      while (row.length < c) row.push('')
      row[c] = value
    }
    out.push(row)
  }
  return out
}

/** Builds a zip file from name → content. */
export function makeZip(entries: Record<string, Uint8Array | string>): Uint8Array {
  const files: Zippable = {}
  for (const [name, content] of Object.entries(entries)) {
    files[name] = typeof content === 'string' ? strToU8(content) : content
  }
  return zipSync(files, { level: 6 })
}
