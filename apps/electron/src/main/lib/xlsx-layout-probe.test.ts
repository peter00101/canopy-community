import { afterAll, describe, expect, test } from 'bun:test'
import AdmZip from 'adm-zip'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDimensionRows, parseFrozenPane, probeXlsxLayout, resolveSheetParts } from './xlsx-layout-probe'

const dir = mkdtempSync(join(tmpdir(), 'xlsx-probe-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const WORKBOOK = (sheets: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`
const RELS = (rels: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`
const SHEET = (head: string, rows = '') => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${head}<sheetData>${rows}</sheetData></worksheet>`

function writeXlsx(name: string, parts: Record<string, string>, options: { store?: boolean } = {}): string {
  const zip = new AdmZip()
  for (const [path, content] of Object.entries(parts)) {
    zip.addFile(path, Buffer.from(content, 'utf8'))
    if (options.store) zip.getEntry(path)!.header.method = 0
  }
  const file = join(dir, name)
  zip.writeZip(file)
  return file
}

describe('xlsx 结构探测 — 纯解析', () => {
  test('Given dimension 各种写法 When 解析行数 Then 起止行差 +1，单格引用算 1 行，缺失为 undefined', () => {
    expect(parseDimensionRows('<dimension ref="A1:L50001"/>')).toBe(50001)
    expect(parseDimensionRows('<dimension ref="B3:C7"/>')).toBe(5)
    expect(parseDimensionRows('<x:dimension ref="$A$1:$D$10"/>')).toBe(10)
    expect(parseDimensionRows('<dimension ref="A1"/>')).toBe(1)
    expect(parseDimensionRows('<sheetData/>')).toBeUndefined()
  })

  test('Given 冻结窗格 When 解析 Then 取 ySplit / xSplit；拆分窗格（split）不算冻结', () => {
    const frozen = '<sheetViews><sheetView workbookViewId="0"><pane xSplit="2" ySplit="1" topLeftCell="C2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>'
    expect(parseFrozenPane(frozen)).toEqual({ rows: 1, cols: 2 })
    expect(parseFrozenPane('<sheetView><pane ySplit="3" state="split"/></sheetView>')).toEqual({ rows: 0, cols: 0 })
    expect(parseFrozenPane('<sheetView workbookViewId="0"/>')).toEqual({ rows: 0, cols: 0 })
  })

  test('Given 只看第一个 sheetView When 第二个视图有冻结 Then 不采用', () => {
    const xml = '<sheetViews><sheetView workbookViewId="0"/><sheetView workbookViewId="1"><pane ySplit="4" state="frozen"/></sheetView></sheetViews>'
    expect(parseFrozenPane(xml)).toEqual({ rows: 0, cols: 0 })
  })

  test('Given 相对 / 绝对 Target 与转义的表名 When 解析工作表部件 Then 路径归一、表名解码、外链关系忽略', () => {
    const workbook = WORKBOOK('<sheet name="A &amp; B" sheetId="1" r:id="rId1"/><sheet name="绝对" sheetId="2" r:id="rId2"/><sheet name="孤儿" sheetId="3" r:id="rId9"/>')
    const rels = RELS('<Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="t" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Type="t" Target="https://example.com/x" TargetMode="External"/>')
    expect(resolveSheetParts(workbook, rels)).toEqual([
      { name: 'A & B', part: 'xl/worksheets/sheet1.xml' },
      { name: '绝对', part: 'xl/worksheets/sheet2.xml' },
    ])
  })
})

describe('xlsx 结构探测 — 真实 zip', () => {
  const workbook = WORKBOOK('<sheet name="明细" sheetId="1" r:id="rId1"/><sheet name="汇总" sheetId="2" r:id="rId2"/>')
  const rels = RELS('<Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="t" Target="worksheets/sheet2.xml"/>')

  test('Given 带冻结窗格与大行数的工作簿 When 探测 Then 读出每张表的行数与冻结行列，maxRows 取最大', async () => {
    const file = writeXlsx('frozen.xlsx', {
      'xl/workbook.xml': workbook,
      'xl/_rels/workbook.xml.rels': rels,
      'xl/worksheets/sheet1.xml': SHEET('<dimension ref="A1:H12000"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews>'),
      'xl/worksheets/sheet2.xml': SHEET('<dimension ref="A1:C8"/>'),
    })
    expect(await probeXlsxLayout(file)).toEqual({
      sheets: [
        { name: '明细', rows: 12000, frozenRows: 1, frozenCols: 0 },
        { name: '汇总', rows: 8, frozenRows: 0, frozenCols: 0 },
      ],
      maxRows: 12000,
    })
  })

  test('Given 条目以「存储」方式（不压缩）写入 When 探测 Then 同样读得出', async () => {
    const file = writeXlsx('stored.xlsx', {
      'xl/workbook.xml': workbook,
      'xl/_rels/workbook.xml.rels': rels,
      'xl/worksheets/sheet1.xml': SHEET('<dimension ref="A1:B6001"/>'),
      'xl/worksheets/sheet2.xml': SHEET('<dimension ref="A1:B2"/>'),
    }, { store: true })
    expect((await probeXlsxLayout(file))?.maxRows).toBe(6001)
  })

  test('Given 工作表 XML 的正文很大 When 探测 Then 只读开头也拿得到 dimension（数据在 sheetData 之后）', async () => {
    const rows = Array.from({ length: 30000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>第 ${i + 1} 行的一些文字内容</t></is></c></row>`).join('')
    const file = writeXlsx('big-body.xlsx', {
      'xl/workbook.xml': WORKBOOK('<sheet name="大表" sheetId="1" r:id="rId1"/>'),
      'xl/_rels/workbook.xml.rels': RELS('<Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/>'),
      'xl/worksheets/sheet1.xml': SHEET('<dimension ref="A1:A30000"/>', rows),
    })
    expect(await probeXlsxLayout(file)).toEqual({ sheets: [{ name: '大表', rows: 30000, frozenRows: 0, frozenCols: 0 }], maxRows: 30000 })
  })

  test('Given 工作表没写 dimension When 探测 Then 该表行数未知，maxRows 只看已知的表', async () => {
    const file = writeXlsx('no-dimension.xlsx', {
      'xl/workbook.xml': workbook,
      'xl/_rels/workbook.xml.rels': rels,
      'xl/worksheets/sheet1.xml': SHEET(''),
      'xl/worksheets/sheet2.xml': SHEET('<dimension ref="A1:C20"/>'),
    })
    const layout = await probeXlsxLayout(file)
    expect(layout?.sheets[0]?.rows).toBeUndefined()
    expect(layout?.maxRows).toBe(20)
  })

  test('Given 不是 zip / 缺 workbook.xml / 文件不存在 When 探测 Then 返回 null 而不是抛错', async () => {
    const notZip = join(dir, 'not-zip.xlsx')
    writeFileSync(notZip, 'plain text, not a zip archive')
    expect(await probeXlsxLayout(notZip)).toBeNull()
    expect(await probeXlsxLayout(writeXlsx('no-workbook.xlsx', { 'xl/worksheets/sheet1.xml': SHEET('<dimension ref="A1:A2"/>') }))).toBeNull()
    expect(await probeXlsxLayout(join(dir, 'missing.xlsx'))).toBeNull()
  })
})
