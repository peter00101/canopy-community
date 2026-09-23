/**
 * 大表格 / 旧版 .xls 预览的解析层纯逻辑（跑在后台线程 office-preview.worker.ts 里，这里不碰 DOM 与 Worker API）。
 *
 * 工作簿用 SheetJS 的 dense 模式解析（行数组存储，比按 A1 地址存的对象省内存）；
 * 渲染层只按「可见区域所在的块」来取格式化后的文字，不把整张表搬到页面线程。
 */

import { buildPreviewFindMatcher, type PreviewFindOptions } from './preview-find-matcher'

/** 单元格的最小形状（与 @e965/xlsx 的 CellObject 兼容） */
export interface CellLike {
  t?: string
  v?: unknown
  w?: string
}

export interface DenseSheetLike {
  '!data'?: Array<Array<CellLike | null | undefined> | null | undefined>
  '!merges'?: Array<{ s: { r: number; c: number }; e: { r: number; c: number } }>
  '!cols'?: Array<{ width?: number; wpx?: number; wch?: number; hidden?: boolean } | null | undefined>
}

export interface SpreadsheetSheetMeta {
  name: string
  rowCount: number
  colCount: number
  /** 列宽（像素），长度 = colCount */
  colWidths: number[]
  merges: Array<{ s: { r: number; c: number }; e: { r: number; c: number } }>
  /** 列数超过显示上限被截掉 */
  truncatedColumns: boolean
}

export interface SpreadsheetBlock {
  /** texts[行偏移][列偏移] */
  texts: string[][]
  /** 数字单元格右对齐 */
  numeric: boolean[][]
}

export interface SpreadsheetMatch {
  sheet: number
  row: number
  col: number
}

export const DEFAULT_COLUMN_WIDTH = 88
export const MIN_COLUMN_WIDTH = 36
export const MAX_COLUMN_WIDTH = 480
/** 超过这么多列的部分不显示（绝大多数真实表格远小于此；满列 16384 的表格来自格式刷残留） */
export const MAX_GRID_COLUMNS = 2000

export function cellText(cell: CellLike | null | undefined): string {
  if (!cell) return ''
  if (typeof cell.w === 'string') return cell.w
  if (cell.v === undefined || cell.v === null) return ''
  if (cell.v instanceof Date) return cell.v.toISOString().slice(0, 10)
  return String(cell.v)
}

export function isNumericCell(cell: CellLike | null | undefined): boolean {
  return cell?.t === 'n' || cell?.t === 'd'
}

/** Excel 默认字体（11 号）在 96 DPI 下的最大数字宽度 */
const EXCEL_MAX_DIGIT_WIDTH = 7

function columnWidthPx(column: { width?: number; wpx?: number; wch?: number; hidden?: boolean } | null | undefined): number {
  if (!column) return DEFAULT_COLUMN_WIDTH
  if (column.hidden) return MIN_COLUMN_WIDTH
  // SheetJS 的 wpx 按它逐文件猜的字符宽度（6~8px 不等）换算，同样的列宽在不同文件里会忽宽忽窄；
  // 有原始 width（含内边距的字符数）时按 Excel 默认字体换算，并不小于 wpx，避免日期等内容被截断
  const fromWidth = typeof column.width === 'number' ? column.width * EXCEL_MAX_DIGIT_WIDTH : 0
  const fromSheetJs = typeof column.wpx === 'number' ? column.wpx : typeof column.wch === 'number' ? column.wch * EXCEL_MAX_DIGIT_WIDTH + 5 : 0
  const width = Math.max(fromWidth, fromSheetJs) || DEFAULT_COLUMN_WIDTH
  return Math.round(Math.min(Math.max(width, MIN_COLUMN_WIDTH), MAX_COLUMN_WIDTH))
}

/** 按真实数据范围算行列数（`!ref` 常被格式刷撑到很大，不可信） */
export function buildSheetMeta(name: string, sheet: DenseSheetLike): SpreadsheetSheetMeta {
  const data = sheet['!data'] ?? []
  let rowCount = 0
  let colCount = 0
  for (let row = 0; row < data.length; row += 1) {
    const cells = data[row]
    if (!cells) continue
    for (let col = cells.length - 1; col >= 0; col -= 1) {
      if (cellText(cells[col]) !== '') {
        rowCount = row + 1
        if (col + 1 > colCount) colCount = col + 1
        break
      }
    }
  }
  const merges = (sheet['!merges'] ?? []).filter((merge) => merge.s.r < rowCount && merge.s.c < colCount)
  for (const merge of merges) {
    rowCount = Math.max(rowCount, merge.e.r + 1)
    colCount = Math.max(colCount, merge.e.c + 1)
  }
  const truncatedColumns = colCount > MAX_GRID_COLUMNS
  colCount = Math.min(colCount, MAX_GRID_COLUMNS)
  const cols = sheet['!cols'] ?? []
  return {
    name,
    rowCount,
    colCount,
    colWidths: Array.from({ length: colCount }, (_, index) => columnWidthPx(cols[index])),
    merges: merges.filter((merge) => merge.s.c < colCount),
    truncatedColumns,
  }
}

/** 取 [rowStart, rowEnd) × [colStart, colEnd) 的格式化文字 */
export function readBlock(sheet: DenseSheetLike, rowStart: number, rowEnd: number, colStart: number, colEnd: number): SpreadsheetBlock {
  const data = sheet['!data'] ?? []
  const texts: string[][] = []
  const numeric: boolean[][] = []
  for (let row = rowStart; row < rowEnd; row += 1) {
    const cells = data[row]
    const rowTexts: string[] = []
    const rowNumeric: boolean[] = []
    for (let col = colStart; col < colEnd; col += 1) {
      const cell = cells?.[col]
      rowTexts.push(cellText(cell))
      rowNumeric.push(isNumericCell(cell))
    }
    texts.push(rowTexts)
    numeric.push(rowNumeric)
  }
  return { texts, numeric }
}

/** 按「工作表 → 行 → 列」顺序搜全部工作表，最多 limit 个 */
export function searchSheets(
  sheets: ReadonlyArray<{ sheet: DenseSheetLike; meta: SpreadsheetSheetMeta }>,
  query: string,
  options: PreviewFindOptions,
  limit: number,
): { matches: SpreadsheetMatch[]; capped: boolean } {
  const matcher = buildPreviewFindMatcher(query, options)
  const matches: SpreadsheetMatch[] = []
  if (!matcher) return { matches, capped: false }
  for (let sheetIndex = 0; sheetIndex < sheets.length; sheetIndex += 1) {
    const { sheet, meta } = sheets[sheetIndex]!
    const data = sheet['!data'] ?? []
    for (let row = 0; row < meta.rowCount; row += 1) {
      const cells = data[row]
      if (!cells) continue
      const last = Math.min(cells.length, meta.colCount)
      for (let col = 0; col < last; col += 1) {
        const text = cellText(cells[col])
        if (!text) continue
        matcher.lastIndex = 0
        if (matcher.test(text)) {
          if (matches.length >= limit) return { matches, capped: true }
          matches.push({ sheet: sheetIndex, row, col })
        }
      }
    }
  }
  return { matches, capped: false }
}
