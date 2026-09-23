import * as React from 'react'
import { SelectionActionPopover } from './SelectionActionPopover'
import { useTextSelectionAnchor } from './useTextSelectionAnchor'

interface TextSelectionCopyLayerProps {
  /** 监听选区的容器（Chat 消息区、Vault 笔记正文等只读区域）。 */
  rootRef: React.RefObject<HTMLElement | null>
  enabled?: boolean
  /** 正文由编辑器承载时（笔记库）需要打开，否则可编辑区的选区不弹浮层。 */
  includeEditable?: boolean
}

/**
 * 只读区域的「选中即可复制」浮层。
 *
 * Agent 会话用的是功能更全的 `AgentHistorySelectionLayer`（还能把选区作为引用
 * 回插输入框、开探索分支）；Chat 与笔记库没有那些概念，只需要复制，所以复用同一个
 * 浮层组件但不传任何引用类回调——浮层会只渲染「复制文本」一个按钮。
 */
export function TextSelectionCopyLayer({ rootRef, enabled = true, includeEditable = false }: TextSelectionCopyLayerProps): React.ReactElement | null {
  const { anchor, clear } = useTextSelectionAnchor(rootRef, enabled, includeEditable)

  React.useEffect(() => {
    if (!anchor) return
    // 点浮层以外的任何地方就收起（浮层自身 onMouseDown 已 preventDefault，不会触发这里）
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target
      if (target instanceof Element && target.closest('[data-selection-action-popover]')) return
      clear()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') clear()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [anchor, clear])

  if (!anchor) return null
  return <SelectionActionPopover x={anchor.x} y={anchor.y} />
}
