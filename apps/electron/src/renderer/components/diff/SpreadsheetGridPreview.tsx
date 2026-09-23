/**
 * 快速表格视图：大表格（超过 OfficeCLI 5000 行显示上限）与旧版 .xls 的虚拟滚动预览。
 *
 * - 解析在后台线程（office-preview.worker.ts），页面只按可见区域分块取格式化文字；
 * - 只渲染视口附近的行列，5 万行和 50 行的 DOM 数量同一个量级；
 * - 列号 / 行号 / 冻结窗格的滚动同步在 onScroll 里直接改 transform，不等 React 下一帧，避免表头跟不上；
 * - 查找走后台线程搜全部工作表，定位时自动切换工作表并滚到单元格居中。
 * 不还原底色、字体颜色、边框等样式（顶部提示里写明）。
 */

import * as React from 'react'
import type { FileAccessOptions } from '@canopy/shared'
import { cn } from '@/lib/utils'
import type { PreviewFindProvider } from './PreviewFindBar'
import {
  createOfficePreviewWorker,
  toTransferableBuffer,
  type OfficePreviewWorkerClient,
} from '@/lib/office-preview-worker-protocol'
import type { SpreadsheetBlock, SpreadsheetMatch, SpreadsheetSheetMeta } from '@/lib/spreadsheet-worker-core'
import {
  GRID_BLOCK_COLS,
  GRID_BLOCK_ROWS,
  GRID_HEADER_HEIGHT,
  GRID_ROW_HEIGHT,
  blocksForRange,
  columnLabel,
  indexAtOffset,
  isCoveredByMerge,
  mergesIntersecting,
  prefixOffsets,
  rowHeaderWidth,
  visibleRows,
  type GridBlock,
  type GridMerge,
  type GridRange,
} from '@/lib/spreadsheet-grid-layout'

export type SpreadsheetGridSource = 'large' | 'truncated' | 'legacy'

interface SpreadsheetGridPreviewProps {
  filePath: string
  fileAccess: FileAccessOptions
  source: SpreadsheetGridSource
  /** 工作表名 → 冻结行列（主进程从 xlsx 读出；.xls 没有） */
  frozenPanes?: Record<string, { rows: number; cols: number }>
  onFindProviderChange?: (provider: PreviewFindProvider | undefined) => void
}

const MAX_MATCHES = 5000
const MAX_CACHED_BLOCKS = 60
const OVERSCAN_ROWS = 6
const OVERSCAN_PX = 160

type Phase = 'loading' | 'ready' | 'error'

function blockCacheKey(sheet: number, key: string): string {
  return `${sheet}|${key}`
}

export function SpreadsheetGridPreview({ filePath, fileAccess, source, frozenPanes, onFindProviderChange }: SpreadsheetGridPreviewProps): React.ReactElement {
  const [phase, setPhase] = React.useState<Phase>('loading')
  const [errorText, setErrorText] = React.useState('')
  const [sheets, setSheets] = React.useState<SpreadsheetSheetMeta[]>([])
  const [activeSheet, setActiveSheet] = React.useState(0)
  const [scroll, setScroll] = React.useState({ top: 0, left: 0 })
  const [viewport, setViewport] = React.useState({ width: 0, height: 0 })
  const [blocksVersion, setBlocksVersion] = React.useState(0)
  const [matchVersion, setMatchVersion] = React.useState(0)
  const [activeMatch, setActiveMatch] = React.useState<SpreadsheetMatch | null>(null)

  const clientRef = React.useRef<OfficePreviewWorkerClient | null>(null)
  const blockCacheRef = React.useRef(new Map<string, SpreadsheetBlock>())
  const inflightRef = React.useRef(new Set<string>())
  const matchesRef = React.useRef<SpreadsheetMatch[]>([])
  const bodyRef = React.useRef<HTMLDivElement>(null)
  const columnHeaderRef = React.useRef<HTMLDivElement>(null)
  const rowHeaderRef = React.useRef<HTMLDivElement>(null)
  const frozenRowsRef = React.useRef<HTMLDivElement>(null)
  const frozenColsRef = React.useRef<HTMLDivElement>(null)
  const scrollFrameRef = React.useRef(0)
  const pendingScrollRef = React.useRef<{ top: number; left: number } | null>(null)
  const onFindProviderChangeRef = React.useRef(onFindProviderChange)
  onFindProviderChangeRef.current = onFindProviderChange

  // ---------- 加载 ----------
  React.useEffect(() => {
    let cancelled = false
    const client = createOfficePreviewWorker()
    clientRef.current = client
    blockCacheRef.current = new Map()
    inflightRef.current = new Set()
    matchesRef.current = []
    setPhase('loading')
    setSheets([])
    setActiveSheet(0)
    setActiveMatch(null)
    void (async () => {
      try {
        const bytes = await window.electronAPI.readPreviewBinary(filePath, fileAccess)
        if (cancelled) return
        if (!bytes) throw new Error('文件读取失败（可能超过 50 MB 上限或无权访问）')
        const metas = await client.call({ type: 'open-workbook', bytes: toTransferableBuffer(bytes) })
        if (cancelled) return
        if (metas.length === 0) throw new Error('工作簿里没有工作表')
        setSheets(metas)
        setPhase('ready')
      } catch (error) {
        if (cancelled) return
        console.warn('[spreadsheet-preview] 解析失败:', error)
        setErrorText(error instanceof Error ? error.message : String(error))
        setPhase('error')
      }
    })()
    return () => {
      cancelled = true
      client.terminate()
      if (clientRef.current === client) clientRef.current = null
    }
  }, [filePath, fileAccess])

  const sheet = sheets[activeSheet]
  const frozen = React.useMemo(() => {
    const pane = sheet ? frozenPanes?.[sheet.name] : undefined
    return {
      rows: Math.min(pane?.rows ?? 0, sheet?.rowCount ?? 0),
      cols: Math.min(pane?.cols ?? 0, sheet?.colCount ?? 0),
    }
  }, [frozenPanes, sheet])
  const offsets = React.useMemo(() => prefixOffsets(sheet?.colWidths ?? []), [sheet])
  const headerWidth = rowHeaderWidth(sheet?.rowCount ?? 0)
  const frozenWidth = offsets[frozen.cols] ?? 0
  const frozenHeight = frozen.rows * GRID_ROW_HEIGHT
  const totalWidth = offsets[offsets.length - 1] ?? 0

  // ---------- 视口尺寸 ----------
  React.useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const measure = (): void => setViewport({ width: body.clientWidth, height: body.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    return () => observer.disconnect()
  }, [phase, activeSheet])

  // 切换工作表：滚动归零或跳到查找定位的位置
  React.useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const target = pendingScrollRef.current ?? { top: 0, left: 0 }
    pendingScrollRef.current = null
    body.scrollTop = target.top
    body.scrollLeft = target.left
    applyScrollTransforms(target.top, target.left)
    setScroll({ top: body.scrollTop, left: body.scrollLeft })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSheet, phase])

  function applyScrollTransforms(top: number, left: number): void {
    if (columnHeaderRef.current) columnHeaderRef.current.style.transform = `translateX(${-left}px)`
    if (frozenRowsRef.current) frozenRowsRef.current.style.transform = `translateX(${-left}px)`
    if (rowHeaderRef.current) rowHeaderRef.current.style.transform = `translateY(${-top}px)`
    if (frozenColsRef.current) frozenColsRef.current.style.transform = `translateY(${-top}px)`
  }

  const handleScroll = React.useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollLeft } = event.currentTarget
    applyScrollTransforms(scrollTop, scrollLeft)
    if (scrollFrameRef.current) return
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = 0
      const body = bodyRef.current
      if (body) setScroll({ top: body.scrollTop, left: body.scrollLeft })
    })
  }, [])

  React.useEffect(() => () => {
    if (scrollFrameRef.current) cancelAnimationFrame(scrollFrameRef.current)
  }, [])

  // ---------- 可视区 ----------
  const bodyRowCount = Math.max((sheet?.rowCount ?? 0) - frozen.rows, 0)
  const bodyRows: GridRange | null = React.useMemo(() => {
    const range = visibleRows(scroll.top, viewport.height, bodyRowCount, OVERSCAN_ROWS)
    return range ? { first: range.first + frozen.rows, last: range.last + frozen.rows } : null
  }, [bodyRowCount, frozen.rows, scroll.top, viewport.height])
  const bodyCols: GridRange | null = React.useMemo(() => {
    if (!sheet || sheet.colCount <= frozen.cols) return null
    const first = Math.max(frozen.cols, indexAtOffset(offsets, frozenWidth + Math.max(0, scroll.left - OVERSCAN_PX)))
    const last = indexAtOffset(offsets, frozenWidth + scroll.left + viewport.width + OVERSCAN_PX)
    return first <= last ? { first, last } : null
  }, [frozen.cols, frozenWidth, offsets, scroll.left, sheet, viewport.width])
  const frozenRowRange: GridRange | null = frozen.rows > 0 ? { first: 0, last: frozen.rows - 1 } : null
  const frozenColRange: GridRange | null = frozen.cols > 0 ? { first: 0, last: frozen.cols - 1 } : null

  // ---------- 取数 ----------
  const neededBlocks = React.useMemo((): GridBlock[] => {
    if (!sheet) return []
    const ranges: Array<[GridRange | null, GridRange | null]> = [
      [bodyRows, bodyCols],
      [frozenRowRange, bodyCols],
      [bodyRows, frozenColRange],
      [frozenRowRange, frozenColRange],
    ]
    const map = new Map<string, GridBlock>()
    for (const [rows, cols] of ranges) {
      if (!rows || !cols) continue
      for (const block of blocksForRange(rows, cols, sheet.rowCount, sheet.colCount)) map.set(block.key, block)
      // 锚点在视口外的合并单元格也要有文字
      for (const merge of mergesIntersecting(sheet.merges, rows, cols)) {
        for (const block of blocksForRange({ first: merge.s.r, last: merge.s.r }, { first: merge.s.c, last: merge.s.c }, sheet.rowCount, sheet.colCount)) map.set(block.key, block)
      }
    }
    return [...map.values()]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, bodyRows?.first, bodyRows?.last, bodyCols?.first, bodyCols?.last, frozen.rows, frozen.cols])

  React.useEffect(() => {
    const client = clientRef.current
    if (!client || phase !== 'ready') return
    const cache = blockCacheRef.current
    const neededKeys = new Set(neededBlocks.map((block) => blockCacheKey(activeSheet, block.key)))
    for (const block of neededBlocks) {
      const cacheKey = blockCacheKey(activeSheet, block.key)
      if (cache.has(cacheKey) || inflightRef.current.has(cacheKey) || block.rowEnd <= block.rowStart || block.colEnd <= block.colStart) continue
      inflightRef.current.add(cacheKey)
      void client.call({ type: 'read-block', sheet: activeSheet, rowStart: block.rowStart, rowEnd: block.rowEnd, colStart: block.colStart, colEnd: block.colEnd })
        .then((data) => {
          cache.set(cacheKey, data)
          // 超出缓存上限时淘汰最早取的、且当前用不到的块
          for (const key of cache.keys()) {
            if (cache.size <= MAX_CACHED_BLOCKS) break
            if (!neededKeys.has(key)) cache.delete(key)
          }
          setBlocksVersion((version) => version + 1)
        })
        .catch(() => { /* 线程已关闭或块读取失败：格子留空，滚动后会重试 */ })
        .finally(() => inflightRef.current.delete(cacheKey))
    }
  }, [activeSheet, neededBlocks, phase])

  const cellAt = React.useCallback((row: number, col: number): { text: string; numeric: boolean } | null => {
    const rowStart = Math.floor(row / GRID_BLOCK_ROWS) * GRID_BLOCK_ROWS
    const colStart = Math.floor(col / GRID_BLOCK_COLS) * GRID_BLOCK_COLS
    const block = blockCacheRef.current.get(blockCacheKey(activeSheet, `${rowStart}:${colStart}`))
    if (!block) return null
    return { text: block.texts[row - rowStart]?.[col - colStart] ?? '', numeric: block.numeric[row - rowStart]?.[col - colStart] ?? false }
    // blocksVersion 让新到的块触发重新读取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSheet, blocksVersion])

  // ---------- 查找 ----------
  const matchKeys = React.useMemo(() => {
    const keys = new Set<string>()
    for (const match of matchesRef.current) if (match.sheet === activeSheet) keys.add(`${match.row}:${match.col}`)
    return keys
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSheet, matchVersion])

  const scrollTargetForCell = React.useCallback((meta: SpreadsheetSheetMeta, row: number, col: number, bodyWidth: number, bodyHeight: number) => {
    const pane = frozenPanes?.[meta.name]
    const frozenRows = Math.min(pane?.rows ?? 0, meta.rowCount)
    const frozenCols = Math.min(pane?.cols ?? 0, meta.colCount)
    const sheetOffsets = prefixOffsets(meta.colWidths)
    const frozenLeft = sheetOffsets[frozenCols] ?? 0
    const cellLeft = (sheetOffsets[col] ?? 0) - frozenLeft
    const cellWidth = meta.colWidths[col] ?? 0
    return {
      top: row < frozenRows ? null : Math.max(0, (row - frozenRows) * GRID_ROW_HEIGHT - bodyHeight / 2 + GRID_ROW_HEIGHT / 2),
      left: col < frozenCols ? null : Math.max(0, cellLeft - bodyWidth / 2 + cellWidth / 2),
    }
  }, [frozenPanes])

  const sheetsRef = React.useRef(sheets)
  sheetsRef.current = sheets
  const activeSheetRef = React.useRef(activeSheet)
  activeSheetRef.current = activeSheet

  const findProvider = React.useMemo<PreviewFindProvider | undefined>(() => {
    if (phase !== 'ready') return undefined
    return {
      search: async (query, options) => {
        const client = clientRef.current
        if (!client) return 0
        const { matches } = await client.call({ type: 'search', query, options, limit: MAX_MATCHES })
        matchesRef.current = matches
        setActiveMatch(null)
        setMatchVersion((version) => version + 1)
        return matches.length
      },
      activate: (index) => {
        const match = matchesRef.current[index]
        const meta = match ? sheetsRef.current[match.sheet] : undefined
        const body = bodyRef.current
        if (!match || !meta || !body) return
        setActiveMatch(match)
        const target = scrollTargetForCell(meta, match.row, match.col, body.clientWidth, body.clientHeight)
        const next = { top: target.top ?? body.scrollTop, left: target.left ?? body.scrollLeft }
        if (match.sheet !== activeSheetRef.current) {
          pendingScrollRef.current = next
          setActiveSheet(match.sheet)
          return
        }
        body.scrollTop = next.top
        body.scrollLeft = next.left
      },
      clear: () => {
        matchesRef.current = []
        setActiveMatch(null)
        setMatchVersion((version) => version + 1)
      },
    }
  }, [phase, scrollTargetForCell])

  React.useEffect(() => {
    onFindProviderChangeRef.current?.(findProvider)
  }, [findProvider])
  React.useEffect(() => () => onFindProviderChangeRef.current?.(undefined), [])

  // ---------- 渲染 ----------
  if (phase === 'loading') {
    return <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">正在解析表格…</div>
  }
  if (phase === 'error' || !sheet) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-muted-foreground">
        无法加载表格预览：{errorText || '工作簿为空'}
      </div>
    )
  }

  const renderCells = (rows: GridRange | null, cols: GridRange | null, originX: number, originY: number): React.ReactNode[] => {
    if (!rows || !cols) return []
    const nodes: React.ReactNode[] = []
    const merges: GridMerge[] = mergesIntersecting(sheet.merges, rows, cols)
    for (const merge of merges) {
      const data = cellAt(merge.s.r, merge.s.c)
      const key = `${merge.s.r}:${merge.s.c}`
      nodes.push(
        <div
          key={`m-${key}`}
          className={cn('spreadsheet-grid-cell is-merged', data?.numeric && 'is-numeric', matchKeys.has(key) && 'is-match', activeMatch?.sheet === activeSheet && activeMatch.row === merge.s.r && activeMatch.col === merge.s.c && 'is-active-match')}
          style={{
            left: (offsets[merge.s.c] ?? 0) - originX,
            top: merge.s.r * GRID_ROW_HEIGHT - originY,
            width: (offsets[merge.e.c + 1] ?? 0) - (offsets[merge.s.c] ?? 0),
            height: (merge.e.r - merge.s.r + 1) * GRID_ROW_HEIGHT,
          }}
          title={data && data.text.length > 24 ? data.text : undefined}
        >
          {data?.text}
        </div>,
      )
    }
    for (let row = rows.first; row <= rows.last; row += 1) {
      for (let col = cols.first; col <= cols.last; col += 1) {
        if (merges.length > 0 && (isCoveredByMerge(merges, row, col) || merges.some((merge) => merge.s.r === row && merge.s.c === col))) continue
        const data = cellAt(row, col)
        const key = `${row}:${col}`
        nodes.push(
          <div
            key={key}
            className={cn('spreadsheet-grid-cell', data?.numeric && 'is-numeric', matchKeys.has(key) && 'is-match', activeMatch?.sheet === activeSheet && activeMatch.row === row && activeMatch.col === col && 'is-active-match')}
            style={{ left: (offsets[col] ?? 0) - originX, top: row * GRID_ROW_HEIGHT - originY, width: sheet.colWidths[col], height: GRID_ROW_HEIGHT }}
            title={data && data.text.length > 24 ? data.text : undefined}
          >
            {data?.text}
          </div>,
        )
      }
    }
    return nodes
  }

  const columnHeaders = (cols: GridRange | null, originX: number): React.ReactNode[] => {
    if (!cols) return []
    const nodes: React.ReactNode[] = []
    for (let col = cols.first; col <= cols.last; col += 1) {
      nodes.push(
        <div key={col} className="spreadsheet-grid-header" style={{ left: (offsets[col] ?? 0) - originX, top: 0, width: sheet.colWidths[col], height: GRID_HEADER_HEIGHT }}>
          {columnLabel(col)}
        </div>,
      )
    }
    return nodes
  }

  const rowHeaders = (rows: GridRange | null, originY: number): React.ReactNode[] => {
    if (!rows) return []
    const nodes: React.ReactNode[] = []
    for (let row = rows.first; row <= rows.last; row += 1) {
      nodes.push(
        <div key={row} className="spreadsheet-grid-header is-row" style={{ left: 0, top: row * GRID_ROW_HEIGHT - originY, width: headerWidth, height: GRID_ROW_HEIGHT }}>
          {row + 1}
        </div>,
      )
    }
    return nodes
  }

  const noticeParts = [
    source === 'legacy' ? '旧版 Excel（.xls）' : null,
    `本表 ${sheet.rowCount.toLocaleString()} 行 × ${sheet.colCount.toLocaleString()} 列`,
    // 行数是当前工作表的，切换依据是整个工作簿里最大的表，措辞不能让小工作表显得自相矛盾
    source === 'legacy' ? '快速表格视图' : '工作簿较大，已切换为快速表格视图',
    '不显示底色、字体颜色等样式',
    sheet.truncatedColumns ? `列数过多，只显示前 ${sheet.colCount.toLocaleString()} 列` : null,
  ].filter(Boolean)

  return (
    <div className="spreadsheet-grid flex h-full min-h-0 flex-col">
      <div className="spreadsheet-grid-notice shrink-0">{noticeParts.join(' · ')}</div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* 左上角 */}
        <div className="spreadsheet-grid-corner" style={{ width: headerWidth, height: GRID_HEADER_HEIGHT }} />
        {/* 列号：冻结列不动，其余随横向滚动 */}
        <div className="absolute overflow-hidden" style={{ left: headerWidth, top: 0, width: frozenWidth, height: GRID_HEADER_HEIGHT }}>
          {columnHeaders(frozenColRange, 0)}
        </div>
        <div className="absolute overflow-hidden" style={{ left: headerWidth + frozenWidth, top: 0, right: 0, height: GRID_HEADER_HEIGHT }}>
          <div ref={columnHeaderRef} className="absolute left-0 top-0" style={{ width: totalWidth - frozenWidth, height: GRID_HEADER_HEIGHT }}>
            {columnHeaders(bodyCols, frozenWidth)}
          </div>
        </div>
        {/* 行号：冻结行不动，其余随纵向滚动 */}
        <div className="absolute overflow-hidden" style={{ left: 0, top: GRID_HEADER_HEIGHT, width: headerWidth, height: frozenHeight }}>
          {rowHeaders(frozenRowRange, 0)}
        </div>
        <div className="absolute overflow-hidden" style={{ left: 0, top: GRID_HEADER_HEIGHT + frozenHeight, width: headerWidth, bottom: 0 }}>
          <div ref={rowHeaderRef} className="absolute left-0 top-0" style={{ width: headerWidth, height: bodyRowCount * GRID_ROW_HEIGHT }}>
            {rowHeaders(bodyRows, frozenHeight)}
          </div>
        </div>
        {frozen.rows > 0 && frozen.cols > 0 && (
          <div className="spreadsheet-grid-frozen absolute overflow-hidden" style={{ left: headerWidth, top: GRID_HEADER_HEIGHT, width: frozenWidth, height: frozenHeight }}>
            {renderCells(frozenRowRange, frozenColRange, 0, 0)}
          </div>
        )}
        {frozen.rows > 0 && (
          <div className="spreadsheet-grid-frozen absolute overflow-hidden" style={{ left: headerWidth + frozenWidth, top: GRID_HEADER_HEIGHT, right: 0, height: frozenHeight }}>
            <div ref={frozenRowsRef} className="absolute left-0 top-0" style={{ width: totalWidth - frozenWidth, height: frozenHeight }}>
              {renderCells(frozenRowRange, bodyCols, frozenWidth, 0)}
            </div>
          </div>
        )}
        {frozen.cols > 0 && (
          <div className="spreadsheet-grid-frozen absolute overflow-hidden" style={{ left: headerWidth, top: GRID_HEADER_HEIGHT + frozenHeight, width: frozenWidth, bottom: 0 }}>
            <div ref={frozenColsRef} className="absolute left-0 top-0" style={{ width: frozenWidth, height: bodyRowCount * GRID_ROW_HEIGHT }}>
              {renderCells(bodyRows, frozenColRange, 0, frozenHeight)}
            </div>
          </div>
        )}
        {/* 主体：唯一真正滚动的区域 */}
        <div
          ref={bodyRef}
          tabIndex={0}
          aria-label={`${sheet.name} 表格内容`}
          className="spreadsheet-grid-body absolute overflow-auto scrollbar-thin"
          style={{ left: headerWidth + frozenWidth, top: GRID_HEADER_HEIGHT + frozenHeight, right: 0, bottom: 0 }}
          onScroll={handleScroll}
        >
          <div className="relative" style={{ width: Math.max(totalWidth - frozenWidth, 1), height: Math.max(bodyRowCount * GRID_ROW_HEIGHT, 1) }}>
            {renderCells(bodyRows, bodyCols, frozenWidth, frozenHeight)}
          </div>
        </div>
      </div>
      {sheets.length > 1 && (
        <div className="spreadsheet-grid-tabs flex shrink-0 items-center gap-1 overflow-x-auto px-2 py-1 scrollbar-thin" role="tablist" aria-label="工作表">
          {sheets.map((item, index) => (
            <button
              key={`${index}-${item.name}`}
              type="button"
              role="tab"
              aria-selected={index === activeSheet}
              onClick={() => setActiveSheet(index)}
              className={cn(
                'rounded px-2 py-0.5 text-[11px] whitespace-nowrap transition-colors',
                index === activeSheet ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              {item.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
