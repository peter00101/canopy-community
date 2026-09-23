/**
 * LiveMarkdown 表格的纯逻辑：解析、序列化、单元格与行列操作、键盘动作。
 *
 * 交互口径（2026-09-15 维护者定，参考上游表格编辑器的优点自写）：
 * - 点单元格就地编辑，右键出行列操作菜单；
 * - 源码这条路保留——右键「编辑源码」进入，光标离开表格自动回到渲染态；
 * - 列对齐可改（上游方案里改不了）。
 *
 * 坐标约定：`LiveMarkdownTableCell.row` 0 = 表头，1.. = 正文行；
 * 行操作函数收的是**正文行下标**（0 = 第一条正文行）。
 */

export type LiveMarkdownTableAlignment = 'left' | 'center' | 'right' | null

export interface LiveMarkdownTable {
  header: string[]
  alignments: LiveMarkdownTableAlignment[]
  rows: string[][]
}

export interface LiveMarkdownTableCell {
  row: number
  column: number
}

/** GFM 表格至少两列才会被 `buildBlocks` 认成表格，删列不能删穿这条线。 */
export const LIVE_MARKDOWN_TABLE_MIN_COLUMNS = 2

/**
 * Tables stay rendered for a passive selection (including the initial cursor),
 * but switch to Markdown source after the user explicitly asks for source editing.
 */
export function shouldRenderLiveMarkdownBlockPreview(
  kind: 'table' | 'other',
  hasActiveSelectionInBlock: boolean,
  isExplicitlyEditingTable = false,
): boolean {
  return kind === 'table' ? !isExplicitlyEditingTable : !hasActiveSelectionInBlock
}

/** 位置 `index` 之前连续反斜杠的个数。 */
function backslashesBefore(text: string, index: number): number {
  let count = 0
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) count += 1
  return count
}

/**
 * 按 GFM 规则切一行表格，**无损**：只把 `\|` 还原成 `|`，其余反斜杠原样保留。
 *
 * 旧实现遇到任何 `\x` 都会吞掉反斜杠——`\*` 会变成 `*` 被当成强调、
 * `\$5 和 \$6` 会变成 `$5 和 $6` 被当成公式；单元格还要回写源码，必须无损。
 * 与 cmark-gfm 一致：`\\` 成对消耗，所以 `\\|` 里的竖线仍是分隔符。
 */
export function splitLiveMarkdownTableRow(line: string): string[] {
  let content = line.trim()
  if (content.startsWith('|')) content = content.slice(1)
  if (content.endsWith('|') && backslashesBefore(content, content.length - 1) % 2 === 0) {
    content = content.slice(0, -1)
  }
  const cells: string[] = []
  let cell = ''
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!
    const next = content[index + 1]
    if (character === '\\' && next === '|') {
      cell += '|'
      index += 1
    } else if (character === '\\' && next === '\\') {
      cell += '\\\\'
      index += 1
    } else if (character === '|') {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += character
    }
  }
  cells.push(cell.trim())
  return cells
}

function parseAlignment(cell: string): LiveMarkdownTableAlignment | undefined {
  // GFM：分隔格至少一个短横线、两端可带冒号（`:-` `--:` 都合法）；此前要求三个，`| :-- | --: |` 会显示成原文
  if (!/^:?-+:?$/.test(cell)) return undefined
  if (cell.startsWith(':') && cell.endsWith(':')) return 'center'
  if (cell.startsWith(':')) return 'left'
  if (cell.endsWith(':')) return 'right'
  return null
}

export function isLiveMarkdownTableSeparator(line: string): boolean {
  const cells = splitLiveMarkdownTableRow(line)
  return cells.length >= LIVE_MARKDOWN_TABLE_MIN_COLUMNS && cells.every((cell) => parseAlignment(cell) !== undefined)
}

function padRow(row: readonly string[], width: number): string[] {
  return Array.from({ length: width }, (_, index) => row[index] ?? '')
}

/** 解析一整块表格源码（表头 + 分隔行 + 正文），列数不齐的行补空格子。 */
export function parseLiveMarkdownTable(source: string): LiveMarkdownTable | null {
  const lines = source.split('\n')
  if (lines.length < 2 || !lines[0]!.includes('|') || !isLiveMarkdownTableSeparator(lines[1]!)) return null
  const header = splitLiveMarkdownTableRow(lines[0]!)
  const alignments = splitLiveMarkdownTableRow(lines[1]!).map((cell) => parseAlignment(cell) ?? null)
  const body = lines.slice(2).filter((line) => line.trim() && line.includes('|')).map(splitLiveMarkdownTableRow)
  const width = Math.max(header.length, ...body.map((row) => row.length))
  return {
    header: padRow(header, width),
    alignments: Array.from({ length: width }, (_, index) => alignments[index] ?? null),
    rows: body.map((row) => padRow(row, width)),
  }
}

/**
 * 单元格值 → 源码片段。竖线必须前面有奇数个反斜杠才不会被当成分隔符：
 * 偶数个（含 0 个）补一个；已是奇数说明用户自己写了 `\|`（行内语义本就是字面竖线），保持不动。
 * 换行写成 `<br>`——表格行不能真的换行，`<br>` 是通行写法，行内渲染器认它。
 */
function escapeCell(value: string): string {
  let result = ''
  const normalized = value.replace(/\r\n?|\n/g, '<br>')
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!
    if (character === '|' && backslashesBefore(normalized, index) % 2 === 0) result += '\\'
    result += character
  }
  return result
}

function serializeAlignment(alignment: LiveMarkdownTableAlignment): string {
  if (alignment === 'left') return ':---'
  if (alignment === 'center') return ':---:'
  if (alignment === 'right') return '---:'
  return '---'
}

function formatRow(cells: readonly string[], indent: string): string {
  return `${indent}| ${cells.map(escapeCell).join(' | ')} |`
}

function rowKey(cells: readonly string[]): string {
  return JSON.stringify(cells)
}

/**
 * 序列化成 GFM 表格。给了原始源码时**尽量保留用户原来的排版**：
 * 列结构（列数 + 对齐）没变时，内容没变的行原样沿用原行文本（含手工对齐的空格），
 * 只有改动 / 新增的行按紧凑格式重写——改一个格子不会把整张手排的表格重新格式化。
 * 列结构变了（增删移动列、改对齐）才整表重写。缩进沿用表头行，列表里的表格不会被挪出列表。
 */
export function serializeLiveMarkdownTable(table: LiveMarkdownTable, previousSource?: string): string {
  const width = Math.max(LIVE_MARKDOWN_TABLE_MIN_COLUMNS, table.header.length)
  const header = padRow(table.header, width)
  const alignments = Array.from({ length: width }, (_, index) => table.alignments[index] ?? null)
  const rows = table.rows.map((row) => padRow(row, width))

  const previousLines = previousSource?.split('\n') ?? []
  const previous = previousSource === undefined ? null : parseLiveMarkdownTable(previousSource)
  const indent = previousLines[0]?.match(/^[ \t]*/)?.[0] ?? ''
  const sameColumns = previous !== null
    && previous.header.length === width
    && previous.alignments.every((alignment, index) => alignment === alignments[index])

  if (!previous || !sameColumns) {
    return [
      formatRow(header, indent),
      `${indent}| ${alignments.map(serializeAlignment).join(' | ')} |`,
      ...rows.map((row) => formatRow(row, indent)),
    ].join('\n')
  }

  const bodyLines = previousLines.slice(2).filter((line) => line.trim() && line.includes('|'))
  const reusable = new Map<string, string[]>()
  previous.rows.forEach((row, index) => {
    const key = rowKey(row)
    reusable.set(key, [...(reusable.get(key) ?? []), bodyLines[index]!])
  })
  const headerLine = rowKey(previous.header) === rowKey(header) ? previousLines[0]! : formatRow(header, indent)
  return [
    headerLine,
    previousLines[1]!,
    ...rows.map((row) => reusable.get(rowKey(row))?.shift() ?? formatRow(row, indent)),
  ].join('\n')
}

/** 源码里的 `<br>` 在输入框里显示成真换行。 */
export function liveMarkdownTableCellToDraft(value: string): string {
  return value.replace(/<br\s*\/?>/gi, '\n')
}

/** 输入框内容 → 单元格值；首尾空白 GFM 本来就会去掉。 */
export function liveMarkdownTableDraftToCell(draft: string): string {
  return draft.replace(/\r\n?/g, '\n').trim()
}

export function getLiveMarkdownTableCell(table: LiveMarkdownTable, cell: LiveMarkdownTableCell): string {
  return (cell.row === 0 ? table.header : table.rows[cell.row - 1])?.[cell.column] ?? ''
}

function isCellInTable(table: LiveMarkdownTable, cell: LiveMarkdownTableCell): boolean {
  return Number.isInteger(cell.row) && Number.isInteger(cell.column)
    && cell.row >= 0 && cell.row <= table.rows.length
    && cell.column >= 0 && cell.column < table.header.length
}

export function setLiveMarkdownTableCell(
  table: LiveMarkdownTable,
  cell: LiveMarkdownTableCell,
  value: string,
): LiveMarkdownTable {
  if (!isCellInTable(table, cell)) return table
  if (cell.row === 0) {
    return { ...table, header: table.header.map((current, index) => index === cell.column ? value : current) }
  }
  return {
    ...table,
    rows: table.rows.map((row, index) => index === cell.row - 1
      ? row.map((current, column) => column === cell.column ? value : current)
      : row),
  }
}

/** 在正文行下标 `bodyIndex` 处插入空行；等于行数时追加到末尾。 */
export function insertLiveMarkdownTableRow(table: LiveMarkdownTable, bodyIndex: number): LiveMarkdownTable {
  if (!Number.isInteger(bodyIndex) || bodyIndex < 0 || bodyIndex > table.rows.length) return table
  const rows = [...table.rows]
  rows.splice(bodyIndex, 0, table.header.map(() => ''))
  return { ...table, rows }
}

/** 删除一条正文行；表头永远保留，正文可以删空（只剩表头仍是合法表格）。 */
export function deleteLiveMarkdownTableRow(table: LiveMarkdownTable, bodyIndex: number): LiveMarkdownTable {
  if (!Number.isInteger(bodyIndex) || bodyIndex < 0 || bodyIndex >= table.rows.length) return table
  return { ...table, rows: table.rows.filter((_, index) => index !== bodyIndex) }
}

/** 正文行与相邻行对调；越界（第一行上移 / 最后一行下移）原样返回。 */
export function moveLiveMarkdownTableRow(table: LiveMarkdownTable, bodyIndex: number, offset: -1 | 1): LiveMarkdownTable {
  const target = bodyIndex + offset
  if (!Number.isInteger(bodyIndex) || bodyIndex < 0 || bodyIndex >= table.rows.length || target < 0 || target >= table.rows.length) return table
  const rows = [...table.rows]
  ;[rows[bodyIndex], rows[target]] = [rows[target]!, rows[bodyIndex]!]
  return { ...table, rows }
}

/** 在列下标 `column` 处插入空列（等于列数时追加），对齐默认。 */
export function insertLiveMarkdownTableColumn(table: LiveMarkdownTable, column: number): LiveMarkdownTable {
  if (!Number.isInteger(column) || column < 0 || column > table.header.length) return table
  const insert = <T,>(cells: readonly T[], value: T): T[] => {
    const next = [...cells]
    next.splice(column, 0, value)
    return next
  }
  return {
    header: insert(table.header, ''),
    alignments: insert(table.alignments, null),
    rows: table.rows.map((row) => insert(row, '')),
  }
}

export function deleteLiveMarkdownTableColumn(table: LiveMarkdownTable, column: number): LiveMarkdownTable {
  if (!Number.isInteger(column) || column < 0 || column >= table.header.length) return table
  if (table.header.length <= LIVE_MARKDOWN_TABLE_MIN_COLUMNS) return table
  const remove = <T,>(cells: readonly T[]): T[] => cells.filter((_, index) => index !== column)
  return { header: remove(table.header), alignments: remove(table.alignments), rows: table.rows.map(remove) }
}

/** 整列（表头、对齐、每一行）与相邻列对调。 */
export function moveLiveMarkdownTableColumn(table: LiveMarkdownTable, column: number, offset: -1 | 1): LiveMarkdownTable {
  const target = column + offset
  if (!Number.isInteger(column) || column < 0 || column >= table.header.length || target < 0 || target >= table.header.length) return table
  const swap = <T,>(cells: readonly T[]): T[] => {
    const next = [...cells]
    ;[next[column], next[target]] = [next[target]!, next[column]!]
    return next
  }
  return { header: swap(table.header), alignments: swap(table.alignments), rows: table.rows.map(swap) }
}

export function setLiveMarkdownTableAlignment(
  table: LiveMarkdownTable,
  column: number,
  alignment: LiveMarkdownTableAlignment,
): LiveMarkdownTable {
  if (!Number.isInteger(column) || column < 0 || column >= table.header.length) return table
  return { ...table, alignments: table.alignments.map((current, index) => index === column ? alignment : current) }
}

export type LiveMarkdownTableKeyAction = 'commit' | 'cancel' | 'next' | 'previous' | null

/**
 * 编辑框里的按键 → 动作。输入法选字期间（isComposing / keyCode 229）一律不接管，
 * 否则中文用户按回车选词会被当成提交。Shift+Enter 交给 textarea 自己换行。
 */
export function liveMarkdownTableKeyAction(
  key: string,
  shiftKey: boolean,
  isComposing: boolean,
  keyCode: number,
): LiveMarkdownTableKeyAction {
  if (isComposing || keyCode === 229) return null
  if (key === 'Enter') return shiftKey ? null : 'commit'
  if (key === 'Escape') return 'cancel'
  if (key === 'Tab') return shiftKey ? 'previous' : 'next'
  return null
}

/**
 * Tab 的落点：按「表头 → 正文」逐格前进。
 * 最后一格再按 Tab 返回 `appendRow: true`——像文字处理软件一样在末尾加一行，落到新行第一格；
 * 第一格按 Shift+Tab 停在原地。
 */
export function nextLiveMarkdownTableCell(
  table: LiveMarkdownTable,
  from: LiveMarkdownTableCell,
  backwards: boolean,
): { cell: LiveMarkdownTableCell; appendRow: boolean } {
  const width = table.header.length
  const index = from.row * width + from.column
  const last = (table.rows.length + 1) * width - 1
  if (backwards) {
    const previous = Math.max(0, index - 1)
    return { cell: { row: Math.floor(previous / width), column: previous % width }, appendRow: false }
  }
  if (index >= last) return { cell: { row: table.rows.length + 1, column: 0 }, appendRow: true }
  const next = index + 1
  return { cell: { row: Math.floor(next / width), column: next % width }, appendRow: false }
}
