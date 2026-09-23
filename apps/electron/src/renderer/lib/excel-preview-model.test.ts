import { describe, expect, test } from 'bun:test'
import { utils } from '@e965/xlsx'
import { MAX_EXCEL_COLUMNS, MAX_EXCEL_ROWS, buildSheetModel, columnLabel } from './excel-preview-model'

describe('Excel 预览数据模型', () => {
  test('Given 普通表格 When 构建模型 Then 单元格文本按格式化值读取', () => {
    const sheet = utils.aoa_to_sheet([
      ['名称', '数量'],
      ['苹果', 3],
    ])
    const model = buildSheetModel('Sheet1', sheet)

    expect(model.rows.length).toBe(2)
    expect(model.rows[0]?.map((c) => c.text)).toEqual(['名称', '数量'])
    expect(model.rows[1]?.[1]?.text).toBe('3')
    expect(model.truncatedRows).toBe(false)
  })

  test('Given 含合并区域的表格 When 构建模型 Then 起点扩 span 且覆盖区标记 skip', () => {
    const sheet = utils.aoa_to_sheet([
      ['标题', '', 'C1'],
      ['', '', 'C2'],
    ])
    sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 1, c: 1 } }]
    const model = buildSheetModel('合并', sheet)

    const start = model.rows[0]?.[0]
    expect(start?.rowSpan).toBe(2)
    expect(start?.colSpan).toBe(2)
    expect(model.rows[0]?.[1]?.skip).toBe(true)
    expect(model.rows[1]?.[0]?.skip).toBe(true)
    expect(model.rows[1]?.[1]?.skip).toBe(true)
    expect(model.rows[0]?.[2]?.skip).toBe(false)
  })

  test('Given 超出行列上限的表格 When 构建模型 Then 截断并保留真实规模', () => {
    const bigRows = Array.from({ length: MAX_EXCEL_ROWS + 5 }, (_, i) => [`r${i}`])
    const sheet = utils.aoa_to_sheet(bigRows)
    const model = buildSheetModel('大表', sheet)

    expect(model.rows.length).toBe(MAX_EXCEL_ROWS)
    expect(model.truncatedRows).toBe(true)
    expect(model.totalRows).toBe(MAX_EXCEL_ROWS + 5)
    expect(model.truncatedColumns).toBe(false)
    expect(model.totalColumns).toBeLessThanOrEqual(MAX_EXCEL_COLUMNS)
  })

  test('Given 空 sheet When 构建模型 Then 返回空网格不抛错', () => {
    const model = buildSheetModel('空', {})
    expect(model.rows).toEqual([])
    expect(model.totalRows).toBe(0)
  })

  test('Given 列索引 When 求列名 Then 符合 Excel 命名规则', () => {
    expect(columnLabel(0)).toBe('A')
    expect(columnLabel(25)).toBe('Z')
    expect(columnLabel(26)).toBe('AA')
    expect(columnLabel(27)).toBe('AB')
  })
})
