/**
 * 虚拟滚动表格的可视区计算：给定滚动位置与视口尺寸，算出该画哪些行列、该取哪些数据块、哪些合并单元格落在视口里。
 * 行高固定；列宽可变（前缀和 + 二分查找）。
 */

export const GRID_ROW_HEIGHT = 24
export const GRID_HEADER_HEIGHT = 24
/** 数据按块从后台线程取：块太小请求多，太大单次取数慢 */
export const GRID_BLOCK_ROWS = 200
export const GRID_BLOCK_COLS = 50

export interface GridRange {
  first: number
  /** 含 */
  last: number
}

export interface GridMerge {
  s: { r: number; c: number }
  e: { r: number; c: number }
}

/** 列偏移前缀和：offsets[i] 是第 i 列左边缘，offsets[n] 是总宽 */
export function prefixOffsets(sizes: readonly number[]): number[] {
  const offsets = new Array<number>(sizes.length + 1)
  offsets[0] = 0
  for (let index = 0; index < sizes.length; index += 1) offsets[index + 1] = offsets[index]! + sizes[index]!
  return offsets
}

/** 落在 position 处的列：最大的 i 使 offsets[i] <= position，夹在 [0, n-1] */
export function indexAtOffset(offsets: readonly number[], position: number): number {
  const count = offsets.length - 1
  if (count <= 0) return 0
  let low = 0
  let high = count - 1
  let found = 0
  while (low <= high) {
    const middle = (low + high) >> 1
    if (offsets[middle]! <= position) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found
}

export function visibleColumns(offsets: readonly number[], scrollLeft: number, viewportWidth: number, overscanPx = 200): GridRange | null {
  const count = offsets.length - 1
  if (count <= 0) return null
  return {
    first: indexAtOffset(offsets, Math.max(0, scrollLeft - overscanPx)),
    last: indexAtOffset(offsets, Math.max(0, scrollLeft + viewportWidth + overscanPx - 1)),
  }
}

export function visibleRows(scrollTop: number, viewportHeight: number, rowCount: number, overscanRows = 8, rowHeight = GRID_ROW_HEIGHT): GridRange | null {
  if (rowCount <= 0) return null
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscanRows)
  const last = Math.min(rowCount - 1, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscanRows)
  return first > last ? null : { first, last }
}

export interface GridBlock {
  key: string
  rowStart: number
  rowEnd: number
  colStart: number
  colEnd: number
}

/** 覆盖可视区所需的数据块（按块对齐，便于缓存复用） */
export function blocksForRange(rows: GridRange, cols: GridRange, rowCount: number, colCount: number): GridBlock[] {
  const blocks: GridBlock[] = []
  for (let rowStart = Math.floor(rows.first / GRID_BLOCK_ROWS) * GRID_BLOCK_ROWS; rowStart <= rows.last; rowStart += GRID_BLOCK_ROWS) {
    for (let colStart = Math.floor(cols.first / GRID_BLOCK_COLS) * GRID_BLOCK_COLS; colStart <= cols.last; colStart += GRID_BLOCK_COLS) {
      blocks.push({
        key: `${rowStart}:${colStart}`,
        rowStart,
        rowEnd: Math.min(rowStart + GRID_BLOCK_ROWS, rowCount),
        colStart,
        colEnd: Math.min(colStart + GRID_BLOCK_COLS, colCount),
      })
    }
  }
  return blocks
}

/** 与可视区有交集的合并区域（锚点可能在视口外，仍要画出跨进来的部分） */
export function mergesIntersecting(merges: readonly GridMerge[], rows: GridRange, cols: GridRange): GridMerge[] {
  return merges.filter((merge) => merge.s.r <= rows.last && merge.e.r >= rows.first && merge.s.c <= cols.last && merge.e.c >= cols.first)
}

/** (row, col) 是否被某个合并区域盖住（且不是该区域的左上锚点） */
export function isCoveredByMerge(merges: readonly GridMerge[], row: number, col: number): boolean {
  for (const merge of merges) {
    if (row >= merge.s.r && row <= merge.e.r && col >= merge.s.c && col <= merge.e.c) {
      return !(row === merge.s.r && col === merge.s.c)
    }
  }
  return false
}

/** 行号列宽度：按最大行号位数撑开 */
export function rowHeaderWidth(rowCount: number): number {
  return Math.max(44, String(Math.max(rowCount, 1)).length * 8 + 18)
}

export function columnLabel(index: number): string {
  let label = ''
  let n = index
  while (n >= 0) {
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26) - 1
  }
  return label
}

/** 让 (row, col) 所在单元格出现在视口中间的滚动位置 */
export function scrollTargetFor(
  offsets: readonly number[],
  row: number,
  col: number,
  viewportWidth: number,
  viewportHeight: number,
  rowHeight = GRID_ROW_HEIGHT,
): { top: number; left: number } {
  const cellLeft = offsets[col] ?? 0
  const cellWidth = (offsets[col + 1] ?? cellLeft) - cellLeft
  return {
    top: Math.max(0, row * rowHeight - viewportHeight / 2 + rowHeight / 2),
    left: Math.max(0, cellLeft - viewportWidth / 2 + cellWidth / 2),
  }
}
