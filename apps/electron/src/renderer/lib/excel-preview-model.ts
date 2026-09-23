/**
 * Excel 预览数据模型 — 纯函数层
 *
 * 把 @e965/xlsx 的 worksheet 转换为渲染友好的网格模型：
 * - 合并单元格 → rowspan/colspan（被覆盖的格子标记 skip）
 * - 行列上限截断（附截断标记，UI 负责提示）
 * - 优先取 xlsx 格式化文本（cell.w，日期/数字格式已处理）
 *
 * A1 地址解析自行实现，避免静态引入 xlsx 把整库打进主 bundle
 * （xlsx 仅在 OfficeFilePreview 里动态 import）。
 */

/** 行数上限：超出截断（虚拟滚动前的保守值，避免一次性 DOM 卡死） */
export const MAX_EXCEL_ROWS = 2000
/** 列数上限 */
export const MAX_EXCEL_COLUMNS = 100

/** worksheet 的最小结构（与 @e965/xlsx 的 WorkSheet 形状兼容） */
export interface SheetLike {
  '!ref'?: string
  '!merges'?: { s: { r: number; c: number }; e: { r: number; c: number } }[]
  [address: string]: unknown
}

export interface ExcelCell {
  /** 显示文本 */
  text: string
  /** 向下合并行数（1 = 不合并） */
  rowSpan: number
  /** 向右合并列数（1 = 不合并） */
  colSpan: number
  /** 被左/上方合并单元格覆盖，渲染时跳过 */
  skip: boolean
}

export interface ExcelSheetModel {
  name: string
  rows: ExcelCell[][]
  /** 行/列因超限被截断 */
  truncatedRows: boolean
  truncatedColumns: boolean
  /** 截断前的真实规模 */
  totalRows: number
  totalColumns: number
}

/** 解析 A1 单格地址为 0 基行列号 */
function decodeCellAddress(address: string): { r: number; c: number } | null {
  const match = /^([A-Z]+)(\d+)$/.exec(address)
  if (!match || !match[1] || !match[2]) return null
  let c = 0
  for (const ch of match[1]) c = c * 26 + (ch.charCodeAt(0) - 64)
  return { r: parseInt(match[2], 10) - 1, c: c - 1 }
}

/** 解析 "A1:C5" 区域引用；单格引用视为 1×1 区域 */
function decodeRange(ref: string): { s: { r: number; c: number }; e: { r: number; c: number } } | null {
  const parts = ref.split(':')
  const start = decodeCellAddress(parts[0] ?? '')
  if (!start) return null
  const end = parts[1] ? decodeCellAddress(parts[1]) : start
  return end ? { s: start, e: end } : null
}

/** 0 基行列号 → A1 地址 */
function encodeCellAddress(r: number, c: number): string {
  return `${columnLabel(c)}${r + 1}`
}

/** 把一个 worksheet 转为网格模型 */
export function buildSheetModel(name: string, sheet: SheetLike): ExcelSheetModel {
  const ref = sheet['!ref']
  const range = typeof ref === 'string' ? decodeRange(ref) : null
  if (!range) {
    return { name, rows: [], truncatedRows: false, truncatedColumns: false, totalRows: 0, totalColumns: 0 }
  }

  const totalRows = range.e.r - range.s.r + 1
  const totalColumns = range.e.c - range.s.c + 1
  const rowCount = Math.min(totalRows, MAX_EXCEL_ROWS)
  const colCount = Math.min(totalColumns, MAX_EXCEL_COLUMNS)

  const rows: ExcelCell[][] = []
  for (let r = 0; r < rowCount; r++) {
    const row: ExcelCell[] = []
    for (let c = 0; c < colCount; c++) {
      const cell = sheet[encodeCellAddress(range.s.r + r, range.s.c + c)] as
        | { w?: string; v?: unknown }
        | undefined
      const text = cell?.w ?? (cell?.v === undefined || cell?.v === null ? '' : String(cell.v))
      row.push({ text, rowSpan: 1, colSpan: 1, skip: false })
    }
    rows.push(row)
  }

  // 应用合并区域：起点格子扩 span，覆盖区其余格子标记 skip
  for (const merge of sheet['!merges'] ?? []) {
    const sr = merge.s.r - range.s.r
    const sc = merge.s.c - range.s.c
    if (sr < 0 || sc < 0 || sr >= rowCount || sc >= colCount) continue
    const er = Math.min(merge.e.r - range.s.r, rowCount - 1)
    const ec = Math.min(merge.e.c - range.s.c, colCount - 1)
    const startRow = rows[sr]
    if (!startRow) continue
    const startCell = startRow[sc]
    if (!startCell) continue
    startCell.rowSpan = er - sr + 1
    startCell.colSpan = ec - sc + 1
    for (let r = sr; r <= er; r++) {
      for (let c = sc; c <= ec; c++) {
        if (r === sr && c === sc) continue
        const covered = rows[r]?.[c]
        if (covered) covered.skip = true
      }
    }
  }

  return {
    name,
    rows,
    truncatedRows: totalRows > rowCount,
    truncatedColumns: totalColumns > colCount,
    totalRows,
    totalColumns,
  }
}

/** 列号 → Excel 列名（0 → A，26 → AA） */
export function columnLabel(index: number): string {
  let label = ''
  let n = index
  while (n >= 0) {
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26) - 1
  }
  return label
}
