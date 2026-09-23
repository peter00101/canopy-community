/**
 * TutorialReader — 应用内教程阅读器
 *
 * 挂在「设置 → Canopy 教程」右侧就地阅读，不再打开主区 Tab。
 * - 自带滚动容器：设置面板对本页不套外层 ScrollArea（见 settings-navigation.ts），
 *   目录跳转与滚动联动都基于这里的 scrollRef，不会出现双层滚动。
 * - 目录按阅读器自身宽度摆放（tutorial-reader-layout.ts）：够宽放左侧栏默认展开，
 *   窄时收到顶部折叠条默认收起。
 * - 配图：主进程 getTutorialContent() 已把 `tutorial-images/x.png` 改写为绝对路径，
 *   MarkdownRichEditor 渲染时走 file:resolve-path；主进程预览根集合常驻
 *   resources/tutorial-images，与阅读器挂在哪里无关。
 *   图片宽度额外夹在正文栏内，设置内容区再窄也不溢出。
 */

import * as React from 'react'
import { ChevronDown, ChevronRight, ListTree } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { MarkdownRichEditor } from '@/components/diff/MarkdownRichEditor'
import { MarkdownToc } from '@/components/diff/MarkdownToc'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTocHeadings } from '@/hooks/useTocHeadings'
import { useScrollSpy } from '@/hooks/useScrollSpy'
import {
  computeHeadingScrollTop,
  getTutorialCurrentSectionLabel,
  getTutorialTocMinLevel,
  resolveTutorialTocOpen,
  resolveTutorialTocPlacement,
  toTutorialTocEntries,
  type TutorialTocChoice,
  type TutorialTocEntry,
} from './tutorial-reader-layout'

type TutorialLoadState = 'loading' | 'ready' | 'error'

const noop = (): void => {}

export interface TutorialReaderProps {
  className?: string
}

/** 量元素实际宽度；布局前同步测一次，之后跟随 ResizeObserver */
function useElementWidth(ref: React.RefObject<HTMLElement>): number {
  const [width, setWidth] = React.useState(0)

  React.useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    setWidth(element.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return width
}

export function TutorialReader({ className }: TutorialReaderProps): React.ReactElement {
  const [content, setContent] = React.useState('')
  const [loadState, setLoadState] = React.useState<TutorialLoadState>('loading')
  const [reloadToken, setReloadToken] = React.useState(0)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const topTocListRef = React.useRef<HTMLDivElement>(null)

  const width = useElementWidth(rootRef)
  const placement = resolveTutorialTocPlacement(width)
  const [tocChoice, setTocChoice] = React.useState<TutorialTocChoice | null>(null)
  const tocOpen = resolveTutorialTocOpen(placement, tocChoice)
  const setTocOpen = React.useCallback(
    (open: boolean) => setTocChoice({ placement, open }),
    [placement],
  )

  React.useEffect(() => {
    let cancelled = false
    setLoadState('loading')
    window.electronAPI.getTutorialContent()
      .then((result) => {
        if (cancelled) return
        if (result === null) {
          setLoadState('error')
          return
        }
        setContent(result)
        setLoadState('ready')
      })
      .catch((error) => {
        console.error('[教程] 读取教程内容失败:', error)
        if (!cancelled) setLoadState('error')
      })
    return () => {
      cancelled = true
    }
  }, [reloadToken])

  const ready = loadState === 'ready'
  const contentKey = `${content.length}:${content.slice(0, 100)}`
  const scrollContainerRef = scrollRef as React.RefObject<HTMLElement>
  const headings = useTocHeadings(scrollContainerRef, contentKey, ready)
  const activeId = useScrollSpy(scrollContainerRef, headings)
  const tocEntries = React.useMemo(() => toTutorialTocEntries(headings), [headings])
  const tocMinLevel = getTutorialTocMinLevel(tocEntries)
  const currentSectionLabel = getTutorialCurrentSectionLabel(tocEntries, activeId)
  const hasToc = ready && tocEntries.length > 0

  const navigateToHeading = React.useCallback((entry: Pick<TutorialTocEntry, 'id'>) => {
    const container = scrollRef.current
    const heading = headings.find((item) => item.id === entry.id)
    if (!container || !heading) return
    container.scrollTo({
      top: computeHeadingScrollTop({
        headingTop: heading.el.getBoundingClientRect().top,
        containerTop: container.getBoundingClientRect().top,
        scrollTop: container.scrollTop,
      }),
      behavior: 'smooth',
    })
  }, [headings])

  const showTopToc = hasToc && placement === 'top'
  const topTocExpanded = showTopToc && tocOpen

  // 顶部目录展开时把当前章节滚进列表可视区
  React.useEffect(() => {
    if (!topTocExpanded || !activeId || !topTocListRef.current) return
    const item = topTocListRef.current.querySelector<HTMLElement>(`[data-toc-id="${CSS.escape(activeId)}"]`)
    item?.scrollIntoView({ block: 'nearest' })
  }, [topTocExpanded, activeId])

  /**
   * 顶部目录展开时 Esc 先收起目录；preventDefault 让设置面板的 Esc 退出监听跳过这一次。
   * 挂在 window 捕获阶段而不是根节点 onKeyDown：正文是只读编辑器，在正文里点一下焦点会落到 body，
   * 那时根节点收不到按键，Esc 会直接把整个设置关掉。
   */
  React.useEffect(() => {
    if (!topTocExpanded) return
    const handleWindowKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      setTocOpen(false)
    }
    window.addEventListener('keydown', handleWindowKeyDown, true)
    return () => window.removeEventListener('keydown', handleWindowKeyDown, true)
  }, [topTocExpanded, setTocOpen])

  return (
    <div
      ref={rootRef}
      className={cn('flex h-full min-h-0 min-w-0 flex-col bg-content-area', className)}
    >
      {showTopToc && (
        <div className="flex-shrink-0 border-b border-line-2 px-[calc(var(--layout-page-gutter)-8px)] py-1.5">
          <button
            type="button"
            onClick={() => setTocOpen(!tocOpen)}
            aria-expanded={tocOpen}
            aria-controls="tutorial-reader-top-toc"
            className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-fg-2 transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <ListTree className="size-3.5 shrink-0" />
            <span className="shrink-0 font-medium">目录</span>
            {currentSectionLabel && (
              <span className="min-w-0 truncate text-foreground/55">· {currentSectionLabel}</span>
            )}
            <ChevronDown className={cn('ml-auto size-3.5 shrink-0 transition-transform', tocOpen && 'rotate-180')} />
          </button>
          {tocOpen && (
            <nav
              id="tutorial-reader-top-toc"
              aria-label="教程目录"
              className="mb-1 mt-1 rounded-lg bg-muted/40"
            >
              <div ref={topTocListRef} className="max-h-[min(360px,45vh)] overflow-y-auto px-1 py-1 scrollbar-thin">
                {tocEntries.map((entry) => {
                  const active = entry.id === activeId
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      data-toc-id={entry.id}
                      title={entry.text}
                      onClick={() => {
                        navigateToHeading(entry)
                        setTocOpen(false)
                      }}
                      style={{ paddingLeft: `${(entry.level - tocMinLevel) * 12 + 8}px` }}
                      className={cn(
                        'block w-full truncate rounded border-l-2 py-1 pr-2 text-left text-[12px] leading-snug transition-colors',
                        active
                          ? 'border-primary bg-foreground/[0.04] font-medium text-foreground'
                          : 'border-transparent text-foreground/55 hover:bg-foreground/[0.03] hover:text-foreground/80',
                      )}
                    >
                      {entry.text}
                    </button>
                  )
                })}
              </div>
            </nav>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {hasToc && placement === 'side' && (
          tocOpen ? (
            <MarkdownToc
              containerRef={scrollContainerRef}
              contentKey={contentKey}
              enabled
              onOpenChange={setTocOpen}
              source={{
                headings: tocEntries,
                activeId,
                onNavigate: navigateToHeading,
              }}
            />
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setTocOpen(true)}
                  className="mx-2 mb-2 mt-3 flex size-7 shrink-0 items-center justify-center self-start rounded-md bg-muted/40 text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground/70"
                  aria-label="展开目录"
                >
                  <ChevronRight className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">展开目录</TooltipContent>
            </Tooltip>
          )
        )}

        <div
          ref={scrollRef}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto scrollbar-thin"
        >
          {loadState === 'loading' && (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">加载中...</div>
          )}
          {loadState === 'error' && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-xs text-muted-foreground">
              <span>教程加载失败</span>
              <Button variant="outline" size="sm" onClick={() => setReloadToken((token) => token + 1)}>
                重试
              </Button>
            </div>
          )}
          {ready && (
            <div
              className={cn(
                'min-w-0 px-[calc(var(--layout-page-gutter)-16px)] pb-12 pt-3',
                // 配图夹在正文栏内：figure 自身是 w-fit，窄栏时再兜一层 max-width
                '[&_figure]:max-w-full [&_img]:h-auto [&_img]:max-w-full',
              )}
            >
              <MarkdownRichEditor
                value={content}
                editing={false}
                showToolbar={false}
                onChange={noop}
                onSave={noop}
                onCancel={noop}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
