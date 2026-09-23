import * as React from 'react'
import { ArrowDownIcon, CheckCircle2, CircleAlert, ListTodo, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { ToolActivity } from '@/atoms/agent-atoms'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import { TaskProgressCard } from './TaskProgressCard'
import { aggregateTaskItems, getTaskProgressCounts, isTerminalTaskStatus, type TaskItem } from './task-progress'

const FINISH_RETENTION_MS = 4_000
const FADE_OUT_DURATION_MS = 200

function taskSignature(items: TaskItem[]): string {
  return items
    .map((item) => `${item.id}:${item.status}:${item.subject}:${item.activeForm ?? ''}`)
    .join('|')
}

function getCurrentTask(items: TaskItem[]): TaskItem | undefined {
  return [...items].reverse().find((item) => item.status === 'in_progress')
    ?? [...items].reverse().find((item) => !isTerminalTaskStatus(item.status))
}

export interface ContextCompactionProgress {
  status: 'running' | 'success' | 'noop' | 'failed'
  label: string
  detail?: string
  summary?: string
}

interface TaskProgressOverlayProps {
  /** 当前 run 全部 live turn 的任务工具活动（压缩边界会把一个 run 拆成多段），不传历史 run。 */
  activities: ToolActivity[]
  streaming: boolean
  /** 与 Agent 任务并列的系统级短时操作；当前用于上下文压缩。 */
  contextCompaction?: ContextCompactionProgress
  /**
   * 浮层是否正在占位。浮层是绝对定位的，会压住贴底时的尾部内容（维护者 2026-08-22 报障：
   * 8 分钟长任务提示被进度浮块盖掉一半）——由会话内容区据此预留净空，见 `task-progress-reserve.ts`。
   */
  onReserveSpaceChange?: (reserved: boolean) => void
}

function compactionSignature(progress: ContextCompactionProgress): string {
  return `${progress.status}:${progress.label}:${progress.detail ?? ''}:${progress.summary ?? ''}`
}

export function shouldRestoreCompactionProgress(signature: string, dismissedSignature: string): boolean {
  return signature !== dismissedSignature
}

/**
 * 压缩成功后，如果同一个 stream 已恢复正常工作，保留的终态反馈不能继续覆盖新的任务进度。
 * 手动压缩直接结束时 streaming 会变为 false，因此仍可保留短时成功反馈。
 */
export function shouldClearRetainedCompactionForResumedStream(
  streaming: boolean,
  contextCompaction: ContextCompactionProgress | undefined,
  retainedCompaction: ContextCompactionProgress | undefined,
): boolean {
  return streaming && !contextCompaction && !!retainedCompaction
}

/**
 * 任务完成反馈只能在整个 Agent run 结束后才开始 4 秒倒计时（收上游 #2076）。
 * 旧口径「任务全到终态」就开始倒计时：Agent 把任务全勾完后还在写总结，进度提示却先消失了。
 */
export function shouldRetainTaskProgress(streaming: boolean, hasTasks: boolean): boolean {
  return hasTasks && !streaming
}

function CompactionProgressDetails({ progress }: { progress: ContextCompactionProgress }): React.ReactElement {
  const isRunning = progress.status === 'running'
  const isFailed = progress.status === 'failed'

  return (
    <div className="space-y-3 p-1">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
          {isRunning && <Loader2 className="size-4 animate-spin text-info" />}
          {progress.status === 'success' && <CheckCircle2 className="size-4 text-success" />}
          {progress.status === 'noop' && <CheckCircle2 className="size-4 text-muted-foreground" />}
          {isFailed && <CircleAlert className="size-4 text-destructive" />}
        </span>
        <div className="min-w-0 space-y-1">
          <div className="text-[13px] font-medium text-foreground">{progress.label}</div>
          {progress.detail && <p className="text-xs text-muted-foreground">{progress.detail}</p>}
        </div>
      </div>
      {progress.summary && !isRunning && (
        <p className="max-h-28 overflow-y-auto rounded-md bg-muted/50 px-2.5 py-2 text-xs leading-5 text-muted-foreground">
          {progress.summary}
        </p>
      )}
    </div>
  )
}

/**
 * 取代单独的“回到最下方”按钮：任务进行时展示单行进度，点击展开完整任务卡；
 * 无任务时自动退化为原箭头按钮。
 */
export function TaskProgressOverlay({ activities, streaming, contextCompaction, onReserveSpaceChange }: TaskProgressOverlayProps): React.ReactElement | null {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()
  const liveItems = React.useMemo(
    () => aggregateTaskItems(activities, false),
    [activities],
  )
  const liveSignature = taskSignature(liveItems)
  const hasLiveTasks = liveItems.length > 0
  const [retainedActivities, setRetainedActivities] = React.useState<ToolActivity[]>([])
  const [retainedSignature, setRetainedSignature] = React.useState('')
  const [retainedCompaction, setRetainedCompaction] = React.useState<ContextCompactionProgress | undefined>()
  const [retainedCompactionSignature, setRetainedCompactionSignature] = React.useState('')
  const [dismissedCompactionSignature, setDismissedCompactionSignature] = React.useState('')
  const [visible, setVisible] = React.useState(false)
  const [fading, setFading] = React.useState(false)
  const [open, setOpen] = React.useState(false)

  // liveMessages 在收尾时会被清空；保留最后一份任务快照，才能完成 4 秒反馈。
  React.useEffect(() => {
    if (!hasLiveTasks || liveSignature === retainedSignature) return
    setRetainedActivities(activities)
    setRetainedSignature(liveSignature)
    setFading(false)
    setVisible(true)
  }, [activities, hasLiveTasks, liveSignature, retainedSignature])

  const liveCompactionSignature = contextCompaction ? compactionSignature(contextCompaction) : ''
  React.useEffect(() => {
    if (!contextCompaction) return
    if (contextCompaction.status === 'running' && dismissedCompactionSignature) {
      setDismissedCompactionSignature('')
    }
    if (
      liveCompactionSignature === retainedCompactionSignature
      || !shouldRestoreCompactionProgress(liveCompactionSignature, dismissedCompactionSignature)
    ) return
    setRetainedCompaction(contextCompaction)
    setRetainedCompactionSignature(liveCompactionSignature)
    setFading(false)
    setVisible(true)
  }, [contextCompaction, dismissedCompactionSignature, liveCompactionSignature, retainedCompactionSignature])

  React.useEffect(() => {
    if (!shouldClearRetainedCompactionForResumedStream(streaming, contextCompaction, retainedCompaction)) return
    setRetainedCompaction(undefined)
    setRetainedCompactionSignature('')
    setFading(false)
    setVisible(hasLiveTasks)
  }, [streaming, contextCompaction, retainedCompaction, hasLiveTasks])

  const displayActivities = hasLiveTasks ? activities : retainedActivities
  // run 结束后按终态聚合：仍标着进行中的任务退回待办，不再转圈、不再挂「正在 xxx」。
  const displayItems = hasLiveTasks
    ? aggregateTaskItems(activities, !streaming)
    : aggregateTaskItems(retainedActivities, !streaming)
  const displaySignature = hasLiveTasks ? liveSignature : retainedSignature
  const displayCompaction = contextCompaction ?? retainedCompaction
  // 上游每次 liveMessages 更新都会重建 progress 对象；超时 effect 必须依赖稳定签名，不能依赖对象引用。
  const displayCompactionSignature = displayCompaction ? compactionSignature(displayCompaction) : ''
  const hasDisplayTasks = displayItems.length > 0
  const compactionIsRunning = displayCompaction?.status === 'running'
  const shouldRetainFinishedProgress = displayCompaction
    ? !compactionIsRunning && displayCompaction.status !== 'failed'
    : shouldRetainTaskProgress(streaming, hasDisplayTasks)
  const hideKey = shouldRetainFinishedProgress
    ? displayCompactionSignature
      ? `${displayCompactionSignature}:${streaming}`
      : `${displaySignature}:${streaming}`
    : null

  React.useEffect(() => {
    if (!hideKey) {
      if (hasDisplayTasks) {
        setFading(false)
        setVisible(true)
      }
      return
    }

    const fadeTimer = window.setTimeout(() => {
      setFading(true)
    }, FINISH_RETENTION_MS - FADE_OUT_DURATION_MS)
    const hideTimer = window.setTimeout(() => {
      if (displayCompactionSignature) {
        setDismissedCompactionSignature(displayCompactionSignature)
      }
      setVisible(false)
      setOpen(false)
      setRetainedActivities([])
      setRetainedSignature('')
      setRetainedCompaction(undefined)
      setRetainedCompactionSignature('')
    }, FINISH_RETENTION_MS)
    return () => {
      window.clearTimeout(fadeTimer)
      window.clearTimeout(hideTimer)
    }
  }, [hasDisplayTasks, displayCompactionSignature, hideKey])

  // 失败 / 取消的任务不计入「已完成」，否则 3/3 实际只成了 1 个。
  const { completed: completedCount } = getTaskProgressCounts(displayItems)
  const currentTask = getCurrentTask(displayItems)
  const showTaskProgress = visible && (hasDisplayTasks || !!displayCompaction)

  // 占位状态上报给内容区。淡出的 200ms 里 showTaskProgress 仍为 true，净空保留到浮层真正消失，
  // 避免内容在淡出过程中先跳上去。
  const reserveRef = React.useRef(onReserveSpaceChange)
  reserveRef.current = onReserveSpaceChange
  React.useEffect(() => {
    reserveRef.current?.(showTaskProgress)
  }, [showTaskProgress])
  // 切会话时本组件按 key 重建，卸载必须撤销占位，否则新会话带着一段空白开场。
  React.useEffect(() => () => reserveRef.current?.(false), [])

  if (!showTaskProgress && isAtBottom) return null

  if (!showTaskProgress) {
    return (
      <Button
        className="absolute bottom-[26px] left-1/2 size-10 -translate-x-1/2 rounded-md border border-border/60 bg-background/85 shadow-sm backdrop-blur-sm transition-[background-color,transform] duration-200 hover:bg-accent/80 active:scale-[0.96]"
        onClick={() => scrollToBottom()}
        type="button"
        variant="ghost"
      >
        <ArrowDownIcon className="size-4" />
      </Button>
    )
  }

  return (
    <div className={cn(
      'pointer-events-none absolute bottom-[22px] left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 transition-opacity duration-200',
      fading && 'opacity-0',
    )}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'pointer-events-auto flex min-h-10 max-w-[min(460px,calc(100vw-9rem))] items-center gap-2 rounded-md border border-border/60 bg-background/85 py-2 pr-3 pl-2.5 text-left shadow-sm backdrop-blur-sm',
              'transition-[background-color,transform] duration-200 hover:bg-accent/80 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          >
            {displayCompaction ? (
              <>
                {displayCompaction.status === 'running' && <Loader2 className="size-3.5 shrink-0 animate-spin text-info" />}
                {displayCompaction.status === 'success' && <CheckCircle2 className="size-3.5 shrink-0 text-success" />}
                {displayCompaction.status === 'noop' && <CheckCircle2 className="size-3.5 shrink-0 text-muted-foreground" />}
                {displayCompaction.status === 'failed' && <CircleAlert className="size-3.5 shrink-0 text-destructive" />}
                <span className="truncate text-[13px] text-foreground/90">{displayCompaction.label}</span>
              </>
            ) : (
              <>
                {currentTask?.status === 'in_progress'
                  ? <Loader2 className="size-3.5 shrink-0 animate-spin text-info" />
                  : <ListTodo className="size-3.5 shrink-0 text-muted-foreground" />}
                <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                  {completedCount}/{displayItems.length}
                </span>
                <span className="truncate text-[13px] text-foreground/90">
                  {currentTask?.activeForm ?? currentTask?.subject ?? '任务已完成'}
                </span>
              </>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[min(420px,calc(100vw-2rem))] rounded-md border-border/60 bg-background/95 p-2 backdrop-blur-sm" side="top" align="center">
          {displayCompaction
            ? <CompactionProgressDetails progress={displayCompaction} />
            : <TaskProgressCard activities={displayActivities} streamEnded={!streaming} alwaysExpanded />}
        </PopoverContent>
      </Popover>

      {!isAtBottom && (
        <Button
          aria-label="回到最下方"
          className="pointer-events-auto size-10 rounded-md border border-border/60 bg-background/85 shadow-sm backdrop-blur-sm transition-[background-color,transform] duration-200 hover:bg-accent/80 active:scale-[0.96]"
          onClick={() => scrollToBottom()}
          type="button"
          variant="ghost"
        >
          <ArrowDownIcon className="size-3.5" />
        </Button>
      )}
    </div>
  )
}
