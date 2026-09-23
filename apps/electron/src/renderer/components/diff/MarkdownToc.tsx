import * as React from 'react'
import { ChevronLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTocHeadings, type TocHeading } from '@/hooks/useTocHeadings'
import { useScrollSpy } from '@/hooks/useScrollSpy'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** 源码模式的目录条目：来自完整 Markdown 源码，行号对应 CodeMirror 文档行。 */
export interface SourceTocEntry {
  id: string
  level: number
  text: string
  line: number
}

interface MarkdownTocProps {
  /** 预览滚动容器，标题提取与跳转都基于它 */
  containerRef: React.RefObject<HTMLElement>
  /** 文件内容标识，变化时重建目录 */
  contentKey: string
  /** 仅 Markdown 只读预览时为 true */
  enabled: boolean
  /** 用户手动折叠目录 */
  onOpenChange?: (open: boolean) => void
  /**
   * 源码模式（LiveMarkdown 预览用）：标题从完整源码提取、虚拟化安全，
   * 跳转与滚动联动由调用方经 CodeMirror position 完成。
   * 缺省时退回从渲染 DOM 提取（TipTap 等全量渲染的面板）。
   */
  source?: {
    headings: SourceTocEntry[]
    activeId: string | null
    onNavigate: (heading: SourceTocEntry) => void
  }
}

const NO_DOM_HEADINGS: never[] = []

/** 计算标题相对滚动容器的 top（不依赖 offsetParent 链） */
function offsetTopWithin(node: HTMLElement, container: HTMLElement): number {
  return node.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
}

export function MarkdownToc({ containerRef, contentKey, enabled, onOpenChange, source }: MarkdownTocProps): React.ReactElement | null {
  const domHeadings = useTocHeadings(containerRef, contentKey, enabled && !source)
  const domActiveId = useScrollSpy(containerRef, source ? NO_DOM_HEADINGS : domHeadings)
  const headings: ReadonlyArray<TocHeading | SourceTocEntry> = source ? source.headings : domHeadings
  const activeId = source ? source.activeId : domActiveId
  const listRef = React.useRef<HTMLDivElement>(null)

  // active 项保持在侧栏可视区内
  React.useEffect(() => {
    if (!activeId || !listRef.current) return
    const item = listRef.current.querySelector<HTMLElement>(`[data-toc-id="${CSS.escape(activeId)}"]`)
    item?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  const minLevel = React.useMemo(
    () => (headings.length ? Math.min(...headings.map((h) => h.level)) : 1),
    [headings],
  )

  if (!enabled) return null

  const jumpTo = (heading: TocHeading | SourceTocEntry): void => {
    if (!('el' in heading)) {
      source?.onNavigate(heading)
      return
    }
    const container = containerRef.current
    if (!container) return
    const top = offsetTopWithin(heading.el, container)
    container.scrollTo({ top: Math.max(top - 8, 0), behavior: 'smooth' })
  }

  return (
    <nav
      aria-label="文档目录"
      className="m-2 flex h-[calc(100%-1rem)] min-h-0 w-52 shrink-0 self-start flex-col rounded-lg bg-muted/40"
    >
      <div className="flex items-center gap-2 px-3 pt-2 pb-1">
        <div className="min-w-0 flex-1 text-[11px] font-medium text-foreground/40 select-none">目录</div>
        {onOpenChange && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground/70"
                aria-label="收起目录"
              >
                <ChevronLeft className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">收起目录</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-auto scrollbar-thin px-1 pb-2">
        {headings.map((heading) => {
          const active = heading.id === activeId
          return (
            <button
              key={heading.id}
              type="button"
              data-toc-id={heading.id}
              onClick={() => jumpTo(heading)}
              title={heading.text}
              style={{ paddingLeft: `${(heading.level - minLevel) * 12 + 8}px` }}
              className={cn(
                'block w-full text-left truncate rounded py-1 pr-2 text-[12px] leading-snug transition-colors',
                'border-l-2 border-transparent',
                active
                  ? 'border-primary text-foreground font-medium bg-foreground/[0.04]'
                  : 'text-foreground/55 hover:text-foreground/80 hover:bg-foreground/[0.03]',
              )}
            >
              {heading.text}
            </button>
          )
        })}
      </div>
    </nav>
  )
}
