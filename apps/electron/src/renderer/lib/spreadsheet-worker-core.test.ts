import { describe, expect, test } from 'bun:test'
import * as XLSX from '@e965/xlsx'
import {
  DEFAULT_COLUMN_WIDTH,
  MAX_COLUMN_WIDTH,
  MAX_GRID_COLUMNS,
  buildSheetMeta,
  cellText,
  readBlock,
  searchSheets,
  type DenseSheetLike,
} from './spreadsheet-worker-core'

const PLAIN = { caseSensitive: false, wholeWord: false, regex: false }

/** 用 SheetJS 写出 xlsx 再按预览同样的参数读回，保证测的是真实解析结果而不是手搓对象 */
function roundTrip(sheets: Record<string, unknown[][]>, decorate?: (workbook: XLSX.WorkBook) => void): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new()
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name)
  decorate?.(workbook)
  const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx', cellStyles: true }) as ArrayBuffer
  return XLSX.read(new Uint8Array(bytes), { type: 'array', dense: true, cellStyles: true, cellDates: false })
}

describe('表格预览解析层 — 行列范围与列宽', () => {
  test('Given 真实数据只到 C3 When 建元信息 Then 行列数按真实数据算，而不是被样式撑大的 !ref', () => {
    const workbook = roundTrip({ 明细: [['a', 'b', 'c'], [1, 2, 3], ['x', '', 'z']] })
    const sheet = workbook.Sheets['明细'] as unknown as DenseSheetLike & { '!ref'?: string }
    sheet['!ref'] = 'A1:Z9999'
    const meta = buildSheetMeta('明细', sheet)
    expect({ rows: meta.rowCount, cols: meta.colCount }).toEqual({ rows: 3, cols: 3 })
    expect(meta.colWidths).toEqual([DEFAULT_COLUMN_WIDTH, DEFAULT_COLUMN_WIDTH, DEFAULT_COLUMN_WIDTH])
  })

  test('Given 设置了列宽的工作表 When 建元信息 Then 列宽换算成像素并夹在上下限内', () => {
    const workbook = roundTrip({ 表: [['窄', '宽', '超宽']] }, (book) => {
      book.Sheets['表']!['!cols'] = [{ wpx: 10 }, { wpx: 160 }, { wpx: 2000 }]
    })
    const widths = buildSheetMeta('表', workbook.Sheets['表'] as unknown as DenseSheetLike).colWidths
    expect(widths[0]).toBe(36)
    expect(widths[1]).toBeGreaterThanOrEqual(160)
    expect(widths[2]).toBe(MAX_COLUMN_WIDTH)
  })

  test('Given 同样的 Excel 列宽、SheetJS 猜的字符宽度不同 When 建元信息 Then 按 Excel 默认字体换算，不因猜测偏小而截断内容', () => {
    const sheet: DenseSheetLike = {
      '!data': [[{ t: 's', v: 'a' }, { t: 's', v: 'b' }, { t: 's', v: 'c' }]],
      // 12.83 字符宽：SheetJS 按 6px 猜出 77px，Excel 实际显示约 90px；wpx 更大时取 wpx；只有 wpx 时照用
      '!cols': [{ width: 12.83203125, wpx: 77, wch: 12 }, { width: 9.25, wpx: 74, wch: 8.63 }, { wpx: 120 }],
    }
    expect(buildSheetMeta('表', sheet).colWidths).toEqual([90, 74, 120])
  })

  test('Given 合并区域越过最后一格数据 When 建元信息 Then 行列数扩到能容纳合并区域', () => {
    const workbook = roundTrip({ 汇总: [['年度汇总'], ['城市', '订单']] }, (book) => {
      book.Sheets['汇总']!['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }]
    })
    const meta = buildSheetMeta('汇总', workbook.Sheets['汇总'] as unknown as DenseSheetLike)
    expect(meta.colCount).toBe(4)
    expect(meta.merges).toEqual([{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }])
  })

  test('Given 列数超过显示上限 When 建元信息 Then 截到上限并标记', () => {
    const wide: DenseSheetLike = { '!data': [Array.from({ length: MAX_GRID_COLUMNS + 5 }, () => ({ t: 's', v: 'x', w: 'x' }))] }
    const meta = buildSheetMeta('宽表', wide)
    expect(meta.colCount).toBe(MAX_GRID_COLUMNS)
    expect(meta.truncatedColumns).toBe(true)
    expect(meta.colWidths).toHaveLength(MAX_GRID_COLUMNS)
  })
})

describe('表格预览解析层 — 取块与文字', () => {
  test('Given 数字格式与日期 When 取块 Then 用 SheetJS 的格式化文字，数字单元格标记右对齐', () => {
    const workbook = roundTrip({ 表: [['城市', '金额'], ['北京', 2591.23]] }, (book) => {
      const sheet = book.Sheets['表']!
      sheet['B2']!.z = '#,##0.00'
    })
    const sheet = workbook.Sheets['表'] as unknown as DenseSheetLike
    const block = readBlock(sheet, 0, 2, 0, 2)
    expect(block.texts).toEqual([['城市', '金额'], ['北京', '2,591.23']])
    expect(block.numeric).toEqual([[false, false], [false, true]])
  })

  test('Given 块超出数据范围 When 取块 Then 越界部分补空字符串，不抛错', () => {
    const sheet: DenseSheetLike = { '!data': [[{ t: 's', v: 'a', w: 'a' }]] }
    expect(readBlock(sheet, 0, 2, 0, 2).texts).toEqual([['a', ''], ['', '']])
  })

  test('Given 各种单元格值 When 取文字 Then w 优先，其次 v；空与缺失为空串', () => {
    expect(cellText({ t: 'n', v: 3, w: '3.00' })).toBe('3.00')
    expect(cellText({ t: 'b', v: true })).toBe('true')
    expect(cellText({ t: 'z' })).toBe('')
    expect(cellText(null)).toBe('')
  })
})

describe('表格预览解析层 — 跨工作表搜索', () => {
  const workbook = roundTrip({ 明细: [['订单', '城市'], ['A-1', '北京'], ['A-2', '上海北京']], 汇总: [['北京', 12]] })
  const sheets = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name] as unknown as DenseSheetLike
    return { sheet, meta: buildSheetMeta(name, sheet) }
  })

  test('Given 关键词出现在多个工作表 When 搜索 Then 按工作表 → 行 → 列顺序返回位置', () => {
    expect(searchSheets(sheets, '北京', PLAIN, 100)).toEqual({
      matches: [{ sheet: 0, row: 1, col: 1 }, { sheet: 0, row: 2, col: 1 }, { sheet: 1, row: 0, col: 0 }],
      capped: false,
    })
  })

  test('Given 命中数超过上限 When 搜索 Then 截断并标记 capped', () => {
    expect(searchSheets(sheets, '北京', PLAIN, 2)).toEqual({ matches: [{ sheet: 0, row: 1, col: 1 }, { sheet: 0, row: 2, col: 1 }], capped: true })
  })

  test('Given 区分大小写 / 正则 / 非法正则 When 搜索 Then 与查找栏同语义；非法正则返回空', () => {
    expect(searchSheets(sheets, 'a-\\d', { caseSensitive: true, wholeWord: false, regex: true }, 10).matches).toEqual([])
    expect(searchSheets(sheets, 'A-\\d', { caseSensitive: true, wholeWord: false, regex: true }, 10).matches).toHaveLength(2)
    expect(searchSheets(sheets, '(', { caseSensitive: false, wholeWord: false, regex: true }, 10).matches).toEqual([])
  })
})
