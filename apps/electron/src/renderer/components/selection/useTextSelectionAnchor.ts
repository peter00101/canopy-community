import * as React from 'react'

/**
 * 通用文本选区锚点：监听指定容器内的文本选择，给出浮层应该出现的位置。
 *
 * 与 Agent 侧的 `AgentHistorySelectionLayer` 的分工：那个要构造可回插输入框的
 * 引用（消息 id / role / 字符偏移，460 行），这里只服务「选中即可复制」的场景
 * （Chat 会话、Vault 笔记正文），因此只算坐标，不碰消息结构。
 */

export interface TextSelectionAnchor {
  x: number
  y: number
}

/** 浮层与选区顶边的间距（px）。 */
const POPOVER_GAP = 8

function getElement(node: Node | null): Element | null {
  if (!node) return null
  return node instanceof Element ? node : node.parentElement
}

/** 祖先链上单个元素与判定相关的特征（抽出来是为了让规则可单测，不必造 DOM）。 */
export interface SelectionNodeTraits {
  isPopover: boolean
  isExplicitlyExcluded: boolean
  isHidden: boolean
  isEditable: boolean
  isRoot: boolean
}

/**
 * 从选区节点向上走到容器根的排除判定。
 *
 * 排除：浮层自身（点按钮时选区仍在浮层外，但保险）、显式标记排除的子树、隐藏子树；
 * 可编辑区默认排除（输入框里选中通常是要改写而不是复制），但笔记库这类
 * 「正文由编辑器承载」的场景要用 includeEditable 打开。
 * 走完整条链都没遇到 root，说明选区根本不在本容器内，同样排除。
 */
export function shouldExcludeSelection(chain: readonly SelectionNodeTraits[], includeEditable: boolean): boolean {
  for (const node of chain) {
    if (node.isPopover || node.isExplicitlyExcluded || node.isHidden) return true
    if (!includeEditable && node.isEditable) return true
    if (node.isRoot) return false
  }
  return true
}

function readTraits(element: Element, root: HTMLElement): SelectionNodeTraits {
  return {
    isPopover: element.hasAttribute('data-selection-action-popover'),
    isExplicitlyExcluded: element.getAttribute('data-text-selection-excluded') === 'true',
    isHidden: element.getAttribute('aria-hidden') === 'true' || element.hasAttribute('hidden'),
    isEditable: (element instanceof HTMLElement && element.isContentEditable)
      || element.tagName === 'INPUT'
      || element.tagName === 'TEXTAREA',
    isRoot: element === root,
  }
}

function isExcluded(node: Node, root: HTMLElement, includeEditable: boolean): boolean {
  const chain: SelectionNodeTraits[] = []
  let element = getElement(node)
  while (element) {
    chain.push(readTraits(element, root))
    if (element === root) break
    element = element.parentElement
  }
  return shouldExcludeSelection(chain, includeEditable)
}

/** 选区完全滚出容器可视区时不弹（否则浮层会飘在无关位置）。 */
function getVisibleRect(range: Range, root: HTMLElement): DOMRect | null {
  const rect = range.getBoundingClientRect()
  const anchor = rect.width > 0 || rect.height > 0 ? rect : range.getClientRects()[0]
  if (!anchor) return null
  const rootRect = root.getBoundingClientRect()
  if (
    anchor.bottom <= rootRect.top
    || anchor.top >= rootRect.bottom
    || anchor.right <= rootRect.left
    || anchor.left >= rootRect.right
  ) {
    return null
  }
  return anchor as DOMRect
}

export function useTextSelectionAnchor(
  rootRef: React.RefObject<HTMLElement | null>,
  enabled = true,
  includeEditable = false,
): { anchor: TextSelectionAnchor | null; clear: () => void } {
  const [anchor, setAnchor] = React.useState<TextSelectionAnchor | null>(null)

  const clear = React.useCallback(() => {
    setAnchor(null)
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) selection.removeAllRanges()
  }, [])

  React.useEffect(() => {
    if (!enabled) {
      setAnchor(null)
      return
    }
    const root = rootRef.current
    if (!root) return

    const evaluate = (): void => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setAnchor(null)
        return
      }
      if (!selection.toString().trim()) {
        setAnchor(null)
        return
      }
      const range = selection.getRangeAt(0)
      if (isExcluded(range.startContainer, root, includeEditable) || isExcluded(range.endContainer, root, includeEditable)) {
        setAnchor(null)
        return
      }
      const rect = getVisibleRect(range, root)
      if (!rect) {
        setAnchor(null)
        return
      }
      setAnchor({ x: rect.left + rect.width / 2, y: Math.max(rect.top - POPOVER_GAP, POPOVER_GAP) })
    }

    // selectionchange 在拖选过程中会高频触发；等鼠标/键盘操作落定再算，避免浮层跟着光标抖。
    const onSelectionChange = (): void => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) setAnchor(null)
    }
    const onSettle = (): void => { window.setTimeout(evaluate, 0) }

    document.addEventListener('selectionchange', onSelectionChange)
    root.addEventListener('mouseup', onSettle)
    root.addEventListener('keyup', onSettle)
    // 容器滚动 / 窗口尺寸变化后旧坐标失效，直接收起（用户重新选即可）
    const onInvalidate = (): void => setAnchor(null)
    root.addEventListener('scroll', onInvalidate, true)
    window.addEventListener('resize', onInvalidate)

    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      root.removeEventListener('mouseup', onSettle)
      root.removeEventListener('keyup', onSettle)
      root.removeEventListener('scroll', onInvalidate, true)
      window.removeEventListener('resize', onInvalidate)
    }
  }, [enabled, includeEditable, rootRef])

  return { anchor, clear }
}
