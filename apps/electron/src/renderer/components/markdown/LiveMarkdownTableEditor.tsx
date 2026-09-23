import * as React from 'react'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Code,
  Trash2,
} from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { renderLiveMarkdownTableCell } from './live-markdown-table-inline'
import {
  LIVE_MARKDOWN_TABLE_MIN_COLUMNS,
  deleteLiveMarkdownTableColumn,
  deleteLiveMarkdownTableRow,
  getLiveMarkdownTableCell,
  insertLiveMarkdownTableColumn,
  insertLiveMarkdownTableRow,
  liveMarkdownTableCellToDraft,
  liveMarkdownTableDraftToCell,
  liveMarkdownTableKeyAction,
  moveLiveMarkdownTableColumn,
  moveLiveMarkdownTableRow,
  nextLiveMarkdownTableCell,
  setLiveMarkdownTableAlignment,
  setLiveMarkdownTableCell,
  type LiveMarkdownTable,
  type LiveMarkdownTableAlignment,
  type LiveMarkdownTableCell,
} from './live-markdown-table'

/** 改动落盘后 widget 会整块重建，用它告诉新实例把焦点放回哪一格、是否直接进入编辑。 */
export interface LiveMarkdownTableFocus {
  cell: LiveMarkdownTableCell
  mode: 'edit' | 'focus'
}

interface LiveMarkdownTableEditorProps {
  table: LiveMarkdownTable
  initialFocus: LiveMarkdownTableFocus | null
  /** 返回 false 表示没写进去（表格源码已被别处改动），调用方要退出编辑态。 */
  onChange: (next: LiveMarkdownTable, focus?: LiveMarkdownTableFocus) => boolean
  onDeleteTable: () => void
  onEditSource: () => void
  /** 编辑框里按 Mod+S：草稿先落进文档，再交给编辑器原本的保存快捷键。 */
  onSaveShortcut: () => void
  /** 焦点停在格子上（不在编辑框）时的撤销 / 重做 / 保存：转交给编辑器，否则 CodeMirror 收不到。 */
  onEditorShortcut: (event: KeyboardEvent) => void
}

/** 焦点在格子上时要转交给编辑器的快捷键：撤销、重做、保存。 */
function isEditorShortcut(event: React.KeyboardEvent): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return false
  const key = event.key.toLowerCase()
  return key === 'z' || key === 'y' || key === 's'
}

const ALIGNMENT_OPTIONS: Array<{ value: string; label: string; icon?: React.ReactNode }> = [
  { value: 'default', label: '默认' },
  { value: 'left', label: '左对齐', icon: <AlignLeft size={14} /> },
  { value: 'center', label: '居中', icon: <AlignCenter size={14} /> },
  { value: 'right', label: '右对齐', icon: <AlignRight size={14} /> },
]

const MENU_ITEM_CLASS = 'text-xs py-1 [&>svg]:size-3.5'

function cellKey(cell: LiveMarkdownTableCell): string {
  return `${cell.row}:${cell.column}`
}

function sameCell(left: LiveMarkdownTableCell | null, right: LiveMarkdownTableCell | null): boolean {
  return Boolean(left && right && left.row === right.row && left.column === right.column)
}

/**
 * LiveMarkdown 里可编辑的表格：点单元格就地编辑，右键出行列操作。
 *
 * 每次改动都序列化回 Markdown 源码交给 CodeMirror——撤销、自动保存、外部改动检测都沿用编辑器原本那条链路，
 * 本组件不持有「表格的真值」，只持有「正在编辑哪一格 + 草稿」。
 */
export function LiveMarkdownTableEditor({
  table,
  initialFocus,
  onChange,
  onDeleteTable,
  onEditSource,
  onSaveShortcut,
  onEditorShortcut,
}: LiveMarkdownTableEditorProps): React.ReactElement {
  const [editing, setEditing] = React.useState<LiveMarkdownTableCell | null>(
    initialFocus?.mode === 'edit' ? initialFocus.cell : null,
  )
  const [draft, setDraft] = React.useState(() => initialFocus?.mode === 'edit'
    ? liveMarkdownTableCellToDraft(getLiveMarkdownTableCell(table, initialFocus.cell))
    : '')
  const [menuCell, setMenuCell] = React.useState<LiveMarkdownTableCell | null>(null)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLTextAreaElement>(null)
  // 一次提交会让整个 widget 重建；重建前的 blur / 二次按键不能再提交一遍。
  const committedRef = React.useRef(false)

  const focusTrigger = React.useCallback((cell: LiveMarkdownTableCell) => {
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-live-markdown-table-cell="${cellKey(cell)}"] .live-markdown-table-cell-trigger`)
      ?.focus({ preventScroll: true })
  }, [])

  // 「把焦点还给某一格」统一走 effect：等本次渲染把编辑框换回格子后再聚焦。
  // 不用 requestAnimationFrame——窗口被遮挡时 Chromium 会暂停 rAF，焦点就丢到 body 上（dev 实测）。
  const [focusRequest, setFocusRequest] = React.useState<LiveMarkdownTableCell | null>(
    initialFocus?.mode === 'focus' ? initialFocus.cell : null,
  )

  React.useEffect(() => {
    if (!focusRequest) return
    focusTrigger(focusRequest)
    setFocusRequest(null)
  }, [focusRequest, focusTrigger])

  React.useLayoutEffect(() => {
    const input = inputRef.current
    if (!input || !editing) return
    input.style.height = '0px'
    input.style.height = `${input.scrollHeight}px`
  }, [editing, draft])

  React.useEffect(() => {
    if (!editing) return
    const input = inputRef.current
    if (!input || document.activeElement === input) return
    input.focus({ preventScroll: false })
    input.setSelectionRange(input.value.length, input.value.length)
  }, [editing])

  const draftValue = (): string => liveMarkdownTableDraftToCell(draft)

  const isDraftChanged = (cell: LiveMarkdownTableCell): boolean => {
    const original = liveMarkdownTableDraftToCell(liveMarkdownTableCellToDraft(getLiveMarkdownTableCell(table, cell)))
    return draftValue() !== original
  }

  /** 把草稿（若有改动）并进表格，供右键操作在「正在编辑」时也不丢字。 */
  const tableWithDraft = (): LiveMarkdownTable => editing && isDraftChanged(editing)
    ? setLiveMarkdownTableCell(table, editing, draftValue())
    : table

  const submit = (next: LiveMarkdownTable, focus?: LiveMarkdownTableFocus): void => {
    if (committedRef.current) return
    committedRef.current = true
    if (!onChange(next, focus)) {
      committedRef.current = false
      setEditing(null)
      setDraft('')
    }
  }

  const startEditing = (cell: LiveMarkdownTableCell): void => {
    if (committedRef.current) return
    if (editing && !sameCell(editing, cell) && isDraftChanged(editing)) {
      submit(setLiveMarkdownTableCell(table, editing, draftValue()), { cell, mode: 'edit' })
      return
    }
    setEditing(cell)
    setDraft(liveMarkdownTableCellToDraft(getLiveMarkdownTableCell(table, cell)))
  }

  /** 结束编辑：有改动就落进文档（widget 随之重建并按 focus 恢复），没改动只在本地收起。 */
  const finishEditing = (focus: LiveMarkdownTableFocus | null): void => {
    if (!editing || committedRef.current) return
    if (isDraftChanged(editing)) {
      submit(setLiveMarkdownTableCell(table, editing, draftValue()), focus ?? undefined)
      return
    }
    setEditing(null)
    setDraft('')
    if (focus?.mode === 'edit') startEditingFresh(focus.cell)
    else if (focus) setFocusRequest(focus.cell)
  }

  const startEditingFresh = (cell: LiveMarkdownTableCell): void => {
    setEditing(cell)
    setDraft(liveMarkdownTableCellToDraft(getLiveMarkdownTableCell(table, cell)))
  }

  const cancelEditing = (): void => {
    if (!editing) return
    const cell = editing
    setEditing(null)
    setDraft('')
    setFocusRequest(cell)
  }

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!editing) return
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault()
      event.stopPropagation()
      if (isDraftChanged(editing)) submit(setLiveMarkdownTableCell(table, editing, draftValue()), { cell: editing, mode: 'edit' })
      onSaveShortcut()
      return
    }
    const action = liveMarkdownTableKeyAction(event.key, event.shiftKey, event.nativeEvent.isComposing, event.keyCode)
    if (!action) return
    event.preventDefault()
    event.stopPropagation()
    if (action === 'commit') {
      finishEditing({ cell: editing, mode: 'focus' })
    } else if (action === 'cancel') {
      cancelEditing()
    } else {
      const { cell, appendRow } = nextLiveMarkdownTableCell(table, editing, action === 'previous')
      if (appendRow) {
        submit(insertLiveMarkdownTableRow(tableWithDraft(), table.rows.length), { cell, mode: 'edit' })
      } else if (!sameCell(cell, editing)) {
        finishEditing({ cell, mode: 'edit' })
      }
    }
  }

  const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLElement>, cell: LiveMarkdownTableCell): void => {
    if (isEditorShortcut(event)) {
      event.preventDefault()
      event.stopPropagation()
      onEditorShortcut(event.nativeEvent)
      return
    }
    if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault()
      startEditing(cell)
    }
  }

  /**
   * 右键菜单的操作推到微任务：Radix 在选中事件里同步提交「关闭菜单」，微任务在那之后执行，
   * 整块 widget 被替换时菜单已经关好。不用 setTimeout——窗口被遮挡时计时器会被节流到秒级（dev 实测），
   * 用户紧接着的输入会跑到操作前面。
   */
  const runMenuAction = (action: () => void): void => {
    queueMicrotask(action)
  }

  const applyStructure = (
    change: (current: LiveMarkdownTable) => LiveMarkdownTable,
    focus?: LiveMarkdownTableFocus,
  ): void => {
    runMenuAction(() => submit(change(tableWithDraft()), focus))
  }

  const renderCell = (cell: LiveMarkdownTableCell): React.ReactElement => {
    const Tag = cell.row === 0 ? 'th' : 'td'
    const isEditing = sameCell(editing, cell)
    const alignment = table.alignments[cell.column]
    return (
      <Tag
        key={cellKey(cell)}
        data-live-markdown-table-cell={cellKey(cell)}
        className={isEditing ? 'is-editing' : undefined}
        style={alignment ? { textAlign: alignment } : undefined}
      >
        {isEditing ? (
          <textarea
            ref={inputRef}
            className="live-markdown-table-input"
            aria-label={cell.row === 0 ? `编辑表头第 ${cell.column + 1} 列` : `编辑第 ${cell.row} 行第 ${cell.column + 1} 列`}
            rows={1}
            value={draft}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleInputKeyDown}
            // 编辑框里右键留给系统的复制粘贴，不弹表格菜单。
            onContextMenu={(event) => event.stopPropagation()}
            onBlur={(event) => {
              const next = event.relatedTarget
              // 焦点去了同一张表的另一格（由那一格的点击接手）或右键菜单：不在这里提交。
              if (next instanceof HTMLElement && (rootRef.current?.contains(next) || next.closest('[role="menu"]'))) return
              const snapshot = { editing, draft }
              // blur 可能发生在 CodeMirror 更新期间（外部改动替换了 widget），推到微任务里再提交。
              queueMicrotask(() => {
                if (!snapshot.editing || committedRef.current) return
                const original = liveMarkdownTableDraftToCell(liveMarkdownTableCellToDraft(getLiveMarkdownTableCell(table, snapshot.editing)))
                const value = liveMarkdownTableDraftToCell(snapshot.draft)
                if (value !== original) submit(setLiveMarkdownTableCell(table, snapshot.editing, value))
                else { setEditing(null); setDraft('') }
              })
            }}
          />
        ) : (
          <div
            role="button"
            tabIndex={0}
            className="live-markdown-table-cell-trigger"
            // 渲染态的格子不支持拖选复制文字（与原先「一点就切源码」同样取舍）：要复制就进编辑框或「编辑源码」。
            onClick={() => startEditing(cell)}
            onKeyDown={(event) => handleTriggerKeyDown(event, cell)}
            // 渲染器只产出 strong / em / code / s / br / span.math，安全边界见 live-markdown-table-inline.ts。
            dangerouslySetInnerHTML={{ __html: renderLiveMarkdownTableCell(getLiveMarkdownTableCell(table, cell)) }}
          />
        )}
      </Tag>
    )
  }

  const columnCount = table.header.length
  const menuRow = menuCell?.row ?? 0
  const menuColumn = menuCell?.column ?? 0
  const menuBodyIndex = menuRow - 1
  const menuAlignment: LiveMarkdownTableAlignment = table.alignments[menuColumn] ?? null

  return (
    <div ref={rootRef} className="live-markdown-table-editor-shell" data-editing={editing ? 'true' : undefined}>
      <div className="live-markdown-table-editor-hint" aria-hidden="true">点击单元格编辑 · 右键更多操作</div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="live-markdown-table-editor"
            onContextMenu={(event) => {
              const target = (event.target as HTMLElement).closest<HTMLElement>('[data-live-markdown-table-cell]')
              const [row, column] = (target?.dataset.liveMarkdownTableCell ?? '').split(':').map(Number)
              setMenuCell(target && Number.isInteger(row) && Number.isInteger(column) ? { row: row!, column: column! } : null)
            }}
          >
            <table aria-label="Markdown 表格">
              <thead>
                <tr>{table.header.map((_, column) => renderCell({ row: 0, column }))}</tr>
              </thead>
              {table.rows.length > 0 && (
                <tbody>
                  {table.rows.map((_, bodyIndex) => (
                    <tr key={bodyIndex}>{table.header.map((_, column) => renderCell({ row: bodyIndex + 1, column }))}</tr>
                  ))}
                </tbody>
              )}
            </table>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent
          className="w-44 min-w-0 p-0.5"
          onCloseAutoFocus={(event) => {
            // 默认会把焦点还给已被替换掉的旧表格；还在编辑就回到编辑框，否则什么都不做。
            event.preventDefault()
            if (editing) inputRef.current?.focus({ preventScroll: true })
          }}
        >
          {menuCell && (
            <>
              {menuRow > 0 && (
                <ContextMenuItem
                  className={MENU_ITEM_CLASS}
                  onSelect={() => applyStructure((current) => insertLiveMarkdownTableRow(current, menuBodyIndex), { cell: { row: menuRow, column: menuColumn }, mode: 'edit' })}
                >
                  <BetweenHorizontalStart size={14} />在上方插入行
                </ContextMenuItem>
              )}
              <ContextMenuItem
                className={MENU_ITEM_CLASS}
                onSelect={() => applyStructure((current) => insertLiveMarkdownTableRow(current, menuRow), { cell: { row: menuRow + 1, column: menuColumn }, mode: 'edit' })}
              >
                <BetweenHorizontalEnd size={14} />在下方插入行
              </ContextMenuItem>
              {menuRow > 0 && (
                <>
                  <ContextMenuItem
                    className={MENU_ITEM_CLASS}
                    disabled={menuBodyIndex <= 0}
                    onSelect={() => applyStructure((current) => moveLiveMarkdownTableRow(current, menuBodyIndex, -1), { cell: { row: menuRow - 1, column: menuColumn }, mode: 'focus' })}
                  >
                    <ChevronUp size={14} />上移本行
                  </ContextMenuItem>
                  <ContextMenuItem
                    className={MENU_ITEM_CLASS}
                    disabled={menuBodyIndex >= table.rows.length - 1}
                    onSelect={() => applyStructure((current) => moveLiveMarkdownTableRow(current, menuBodyIndex, 1), { cell: { row: menuRow + 1, column: menuColumn }, mode: 'focus' })}
                  >
                    <ChevronDown size={14} />下移本行
                  </ContextMenuItem>
                  <ContextMenuItem
                    className={`${MENU_ITEM_CLASS} text-destructive focus:text-destructive`}
                    onSelect={() => applyStructure((current) => deleteLiveMarkdownTableRow(current, menuBodyIndex))}
                  >
                    <Trash2 size={14} />删除本行
                  </ContextMenuItem>
                </>
              )}
              <ContextMenuSeparator className="my-0.5" />
              <ContextMenuItem
                className={MENU_ITEM_CLASS}
                onSelect={() => applyStructure((current) => insertLiveMarkdownTableColumn(current, menuColumn), { cell: { row: menuRow, column: menuColumn }, mode: 'edit' })}
              >
                <BetweenVerticalStart size={14} />在左侧插入列
              </ContextMenuItem>
              <ContextMenuItem
                className={MENU_ITEM_CLASS}
                onSelect={() => applyStructure((current) => insertLiveMarkdownTableColumn(current, menuColumn + 1), { cell: { row: menuRow, column: menuColumn + 1 }, mode: 'edit' })}
              >
                <BetweenVerticalEnd size={14} />在右侧插入列
              </ContextMenuItem>
              <ContextMenuItem
                className={MENU_ITEM_CLASS}
                disabled={menuColumn <= 0}
                onSelect={() => applyStructure((current) => moveLiveMarkdownTableColumn(current, menuColumn, -1), { cell: { row: menuRow, column: menuColumn - 1 }, mode: 'focus' })}
              >
                <ChevronLeft size={14} />左移本列
              </ContextMenuItem>
              <ContextMenuItem
                className={MENU_ITEM_CLASS}
                disabled={menuColumn >= columnCount - 1}
                onSelect={() => applyStructure((current) => moveLiveMarkdownTableColumn(current, menuColumn, 1), { cell: { row: menuRow, column: menuColumn + 1 }, mode: 'focus' })}
              >
                <ChevronRight size={14} />右移本列
              </ContextMenuItem>
              <ContextMenuSub>
                <ContextMenuSubTrigger className={MENU_ITEM_CLASS}>
                  <AlignLeft size={14} />本列对齐
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="w-32 min-w-0 p-0.5">
                  <ContextMenuRadioGroup
                    value={menuAlignment ?? 'default'}
                    onValueChange={(value) => applyStructure(
                      (current) => setLiveMarkdownTableAlignment(current, menuColumn, value === 'default' ? null : value as LiveMarkdownTableAlignment),
                      { cell: { row: menuRow, column: menuColumn }, mode: 'focus' },
                    )}
                  >
                    {ALIGNMENT_OPTIONS.map((option) => (
                      <ContextMenuRadioItem key={option.value} value={option.value} className="text-xs py-1">
                        <span className="flex items-center gap-2">{option.icon}{option.label}</span>
                      </ContextMenuRadioItem>
                    ))}
                  </ContextMenuRadioGroup>
                </ContextMenuSubContent>
              </ContextMenuSub>
              <ContextMenuItem
                className={`${MENU_ITEM_CLASS} text-destructive focus:text-destructive`}
                disabled={columnCount <= LIVE_MARKDOWN_TABLE_MIN_COLUMNS}
                onSelect={() => applyStructure((current) => deleteLiveMarkdownTableColumn(current, menuColumn))}
              >
                <Trash2 size={14} />删除本列
              </ContextMenuItem>
              <ContextMenuSeparator className="my-0.5" />
            </>
          )}
          <ContextMenuItem className={MENU_ITEM_CLASS} onSelect={() => runMenuAction(onEditSource)}>
            <Code size={14} />编辑源码
          </ContextMenuItem>
          <ContextMenuItem
            className={`${MENU_ITEM_CLASS} text-destructive focus:text-destructive`}
            onSelect={() => runMenuAction(onDeleteTable)}
          >
            <Trash2 size={14} />删除表格
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}
