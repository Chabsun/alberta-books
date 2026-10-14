import { describe, expect, it } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { makeZip, readXlsxFirstSheet, writeXlsx } from '../src/main/services/xlsx'

describe('xlsx', () => {
  it('writes workbooks that read back, with formulas kept as plain text', () => {
    const data = writeXlsx([
      {
        name: 'Trial balance',
        title: ['Chabsun Consulting Ltd.', 'As of 2026-08-31'],
        header: ['Code', 'Account', 'Debit', 'Credit'],
        rows: [
          ['1000', 'Chequing <&> "x"', 1234.5, null],
          ['=SUM(A1)', 'Formula-looking', null, 99.99],
          ['', 'Total', 1234.5, 99.99]
        ],
        moneyColumns: [2, 3],
        boldRows: [2]
      },
      { name: 'Trial balance', header: ['A'], rows: [['second sheet, duplicate name']] }
    ])
    const rows = readXlsxFirstSheet(data)
    expect(rows[0][0]).toBe('Chabsun Consulting Ltd.')
    expect(rows[3]).toEqual(['Code', 'Account', 'Debit', 'Credit'])
    expect(rows[4]).toEqual(['1000', 'Chequing <&> "x"', '1234.5'])
    expect(rows[5][0]).toBe('=SUM(A1)')
    const files = unzipSync(data)
    expect(strFromU8(files['xl/worksheets/sheet1.xml'])).not.toContain('<f>')
    expect(strFromU8(files['xl/workbook.xml'])).toContain('Trial balance 2')
  })

  it('reads shared strings and date-formatted serials', () => {
    const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2" s="1"><v>46265</v></c><c r="B2"><v>12.5</v></c></row></sheetData></worksheet>`
    const data = makeZip({
      'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>Date</t></si><si><r><t>Acc</t></r><r><t>ount</t></r></si></sst>',
      'xl/styles.xml': '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
      'xl/worksheets/sheet1.xml': sheet
    })
    expect(readXlsxFirstSheet(data)).toEqual([
      ['Date', '', 'Account'],
      ['2026-08-31', '12.5']
    ])
  })
})
