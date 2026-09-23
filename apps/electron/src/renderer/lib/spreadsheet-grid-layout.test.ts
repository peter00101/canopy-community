import { describe, expect, test } from 'bun:test'
import {
  GRID_BLOCK_COLS,
  GRID_BLOCK_ROWS,
  blocksForRange,
  columnLabel,
  indexAtOffset,
  isCoveredByMerge,
  mergesIntersecting,
  prefixOffsets,
  rowHeaderWidth,
  scrollTargetFor,
  visibleColumns,
  visibleRows,
} from './spreadsheet-grid-layout'

describe('虚拟表格 — 列偏移与可见列', () => {
  const offsets = prefixOffsets([100, 50, 200, 80])

  test('Given 各列宽 When 算前缀和 Then 第 i 项是第 i 列左边缘，末项为总宽', () => {
    expect(offsets).toEqual([0, 100, 150, 350, 430])
  })

  test('Given 任意横向位置 When 找所在列 Then 边界归右侧列，超出末尾夹到最后一列', () => {
    expect(indexAtOffset(offsets, 0)).toBe(0)
    expect(indexAtOffset(offsets, 99)).toBe(0)
    expect(indexAtOffset(offsets, 100)).toBe(1)
    expect(indexAtOffset(offsets, 349)).toBe(2)
    expect(indexAtOffset(offsets, 9999)).toBe(3)
  })

  test('Given 横向滚动与视口宽 When 算可见列（无预渲染余量）Then 只含与视口相交的列', () => {
    expect(visibleColumns(offsets, 120, 100, 0)).toEqual({ first: 1, last: 2 })
    expect(visibleColumns(prefixOffsets([]), 0, 100)).toBeNull()
  })
})

describe('虚拟表格 — 可见行与数据块', () => {
  test('Given 滚到中间 When 算可见行 Then 视口所在行加上下余量，并夹在表格范围内', () => {
    expect(visibleRows(24 * 1000, 240, 50000, 2)).toEqual({ first: 998, last: 1012 })
    expect(visibleRows(0, 240, 5, 8)).toEqual({ first: 0, last: 4 })
    expect(visibleRows(0, 240, 0)).toBeNull()
  })

  test('Given 可视区跨块边界 When 算数据块 Then 按块对齐列出所有需要的块，末块截到表格边缘', () => {
    const blocks = blocksForRange({ first: GRID_BLOCK_ROWS - 5, last: GRID_BLOCK_ROWS + 5 }, { first: 0, last: 3 }, 250, 12)
    expect(blocks).toEqual([
      { key: '0:0', rowStart: 0, rowEnd: GRID_BLOCK_ROWS, colStart: 0, colEnd: 12 },
      { key: `${GRID_BLOCK_ROWS}:0`, rowStart: GRID_BLOCK_ROWS, rowEnd: 250, colStart: 0, colEnd: 12 },
    ])
  })

  test('Given 宽表横向跨块 When 算数据块 Then 列方向也分块', () => {
    const blocks = blocksForRange({ first: 0, last: 1 }, { first: GRID_BLOCK_COLS - 1, last: GRID_BLOCK_COLS }, 10, GRID_BLOCK_COLS * 3)
    expect(blocks.map((block) => block.key)).toEqual(['0:0', `0:${GRID_BLOCK_COLS}`])
  })
})

describe('虚拟表格 — 合并单元格', () => {
  const merges = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 3 } },
    { s: { r: 100, c: 2 }, e: { r: 120, c: 2 } },
  ]

  test('Given 锚点在视口上方、区域跨进视口 When 取相交合并区 Then 仍被选中（要画出跨进来的部分）', () => {
    expect(mergesIntersecting(merges, { first: 110, last: 130 }, { first: 0, last: 5 })).toEqual([merges[1]!])
    expect(mergesIntersecting(merges, { first: 10, last: 20 }, { first: 0, last: 5 })).toEqual([])
  })

  test('Given 合并区域内的格子 When 判断是否被盖住 Then 锚点不算、其余算、区域外不算', () => {
    expect(isCoveredByMerge(merges, 0, 0)).toBe(false)
    expect(isCoveredByMerge(merges, 0, 3)).toBe(true)
    expect(isCoveredByMerge(merges, 105, 2)).toBe(true)
    expect(isCoveredByMerge(merges, 1, 0)).toBe(false)
  })
})

describe('虚拟表格 — 杂项', () => {
  test('Given 列号 When 转列名 Then 与 Excel 一致', () => {
    expect([0, 25, 26, 51, 701, 702].map(columnLabel)).toEqual(['A', 'Z', 'AA', 'AZ', 'ZZ', 'AAA'])
  })

  test('Given 行数位数 When 算行号列宽 Then 至少 44px，随位数增长', () => {
    expect(rowHeaderWidth(9)).toBe(44)
    expect(rowHeaderWidth(1000000)).toBe(74)
  })

  test('Given 要定位的单元格 When 算滚动目标 Then 单元格居中且不为负', () => {
    const offsets = prefixOffsets([100, 100, 100])
    expect(scrollTargetFor(offsets, 1000, 2, 300, 240)).toEqual({ top: 24 * 1000 - 120 + 12, left: 200 - 150 + 50 })
    expect(scrollTargetFor(offsets, 0, 0, 300, 240)).toEqual({ top: 0, left: 0 })
  })
})
