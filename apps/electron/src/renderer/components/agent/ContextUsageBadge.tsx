/**
 * ContextUsageBadge — 上下文使用量指示器
 *
 * 输入框工具栏上的一个 36×36 按钮：
 * - 内部为 16px 圆环，按 displayTokens / displayWindow 比例渲染
 * - hover / click 弹出 Popover，内含 token 明细 + 手动压缩按钮
 * - 压缩中时按钮位置显示 Loader2 旋转图标
 * - 占用接近当前 Agent runtime 的自动压缩阈值时圆环变琥珀色
 * - 无数据时不显示
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Loader2, Minimize2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { inputToolbarButtonClass } from '@/components/ai-elements/input-toolbar-styles'
import { preventHoverPopoverFocusRestore } from '@/components/ai-elements/input-toolbar-popover-focus'
import { agentSessionViewStreamStateAtomFamily } from '@/atoms/agent-atoms'
import { deriveContextUsageFromMessages } from '@/lib/context-usage-restore'
import { resolveDisplayContextWindow } from '@/lib/context-window-resolve'
import { cn } from '@/lib/utils'
import { Slider } from '@/components/ui/slider'
import { useAtom } from 'jotai'
import { agentAutoCompactionRatioAtom, agentPromptCacheRetentionAtom } from '@/atoms/agent-atoms'
import type { AgentPromptCacheRetention } from '@/types/settings'
import {
  calculatePiAutoCompactionThresholdTokens,
  inferContextWindow,
  normalizePiAutoCompactionRatio,
  PI_AUTO_COMPACTION_MIN_RATIO,
  PI_AUTO_COMPACTION_MAX_RATIO,
  type ChannelPlanQuotaWindow,
  type ProviderType,
  type SDKMessage,
} from '@canopy/shared'
import { fetchChannelPlanQuota } from '@/lib/channel-plan-quota'
import { currentPlanQuota, formatPlanQuotaWindowValue, planQuotaAccountKey } from '@/lib/channel-plan-quota-display'
import type { LoadedPlanQuota } from '@/lib/channel-plan-quota-display'

/** 显示警告的阈值（压缩阈值的 80%） */
const WARNING_RATIO = 0.80
/** 阈值滑块步长（5 个百分点） */
const RATIO_SLIDER_STEP = 0.05
/** 提示缓存保留时长的两档（Anthropic cache_control ttl：默认 5 分钟 / 1 小时） */
const PROMPT_CACHE_RETENTION_OPTIONS: ReadonlyArray<{ value: AgentPromptCacheRetention; label: string }> = [
  { value: 'short', label: '5 分钟' },
  { value: 'long', label: '1 小时' },
]
/** Popover hover 关闭延迟（ms），与 AgentThinkingPopover 一致 */
const HOVER_CLOSE_DELAY = 150
const UNSUPPORTED_PLAN_QUOTA_MESSAGE = '当前渠道不支持订阅 Plan 额度查询'

interface ContextUsageBadgeProps {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  costUsd?: number
  contextWindow?: number
  /** 当前上下文 token 是否为 Pi 手动压缩后的预估值 */
  isEstimated?: boolean
  isCompacting?: boolean
  isProcessing: boolean
  onCompact: () => void
  /**
   * 当前会话 ID，用于在切换会话时清空 stableRef，
   * 避免新会话尚未发消息时仍显示上一个会话的 token 数。
   */
  sessionId?: string
  /** 当前 Agent 渠道 ID，用于 hover 时查询订阅 Plan 剩余额度 */
  channelId?: string | null
  /**
   * 已加载的历史消息，用于打开历史会话时回推最近一次用量。
   * 流式用量只由本次运行产生，不从 JSONL 恢复；没有它，历史会话开跑前看不到占用明细。
   * 上游 fb62fbf1 把 usage 订阅下沉到本组件后，这份回填也跟着从 AgentView 搬了进来。
   */
  persistedMessages?: SDKMessage[]
  /** 渠道保存时间；凭据变更后用于使旧额度缓存失效。 */
  channelUpdatedAt?: number
  /**
   * 会话下一轮将使用的模型 ID。进度环分母按它算——切了模型之后，
   * 上一轮实测的上下文窗口属于上一个模型，继续用会让占用率与压缩阈值一起错。
   */
  currentModelId?: string | null
}

/** 格式化 token 数为可读字符串（如 1234 → "1.2k"） */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`
  }
  return `${tokens}`
}

/** 圆环进度指示器 — 16×16 SVG，描边 2px */
interface UsageRingProps {
  ratio: number
  isWarning: boolean
}
function UsageRing({ ratio, isWarning }: UsageRingProps): React.ReactElement {
  const radius = 8
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(1, ratio))
  const dashOffset = circumference * (1 - clamped)

  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      className={cn(
        'shrink-0 transition-colors',
        isWarning ? 'text-warning dark:text-warning' : 'text-foreground/70',
      )}
      aria-hidden="true"
    >
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.2"
        strokeWidth="2"
      />
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        transform="rotate(-90 10 10)"
        style={{ transition: 'stroke-dashoffset 300ms ease-out' }}
      />
    </svg>
  )
}

/** Popover 里的一行 key/value */
interface DetailRowProps {
  label: string
  value: string
  emphasized?: boolean
}
function DetailRow({ label, value, emphasized }: DetailRowProps): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-4 text-xs">
      <span className="text-foreground/70">{label}</span>
      <span className={cn('tabular-nums', emphasized ? 'font-medium text-foreground' : 'text-foreground/90')}>
        {value}
      </span>
    </div>
  )
}

function PlanQuotaRow({ quotaWindow, provider }: { quotaWindow: ChannelPlanQuotaWindow; provider: ProviderType }): React.ReactElement {
  const value = formatPlanQuotaWindowValue(quotaWindow, provider)
  return (
    <div className="space-y-1">
      <DetailRow
        label={quotaWindow.label}
        value={value}
        emphasized={quotaWindow.showProgress !== false && quotaWindow.remainingPercent <= 20}
      />
      {quotaWindow.showProgress !== false ? (
        <div className="h-1 overflow-hidden rounded-full bg-foreground/10">
          <div
            className={cn(
              'h-full rounded-full',
              quotaWindow.remainingPercent <= 20 ? 'bg-warning' : 'bg-foreground/60',
            )}
            style={{ width: `${Math.max(0, Math.min(100, quotaWindow.remainingPercent))}%` }}
          />
        </div>
      ) : null}
    </div>
  )
}

export function ContextUsageBadge({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheCreationTokens,
  contextWindow,
  isEstimated,
  isCompacting,
  isProcessing,
  onCompact,
  sessionId,
  channelId,
  channelUpdatedAt,
  currentModelId,
  persistedMessages,
}: ContextUsageBadgeProps): React.ReactElement | null {
  // usage 高频更新只唤醒这个小组件，不再让 AgentView 和输入框参与 reconciliation。
  const sessionStreamState = useAtomValue(agentSessionViewStreamStateAtomFamily(sessionId ?? ''))
  const liveInputTokens = sessionId ? sessionStreamState.inputTokens : inputTokens

  // 历史用量回填：本次运行没有用量事件时（打开历史会话 / 重启后恢复 Tab），
  // 从已加载消息尾部回推最近一次有效用量，否则阈值滑块入口在开跑前不可用。
  const hasLiveUsage = (liveInputTokens ?? 0) > 0
  const restored = React.useMemo(
    () => (hasLiveUsage ? null : deriveContextUsageFromMessages(persistedMessages ?? [])),
    [hasLiveUsage, persistedMessages],
  )

  const displayInputTokens = liveInputTokens ?? restored?.inputTokens
  const displayOutputTokens = (sessionId ? sessionStreamState.outputTokens : outputTokens) ?? restored?.outputTokens
  const displayCacheReadTokens = (sessionId ? sessionStreamState.cacheReadTokens : cacheReadTokens) ?? restored?.cacheReadTokens
  const displayCacheCreationTokens = (sessionId ? sessionStreamState.cacheCreationTokens : cacheCreationTokens) ?? restored?.cacheCreationTokens
  // 分母跟着"下一轮将使用的模型"走：切了模型之后，上一轮实测的窗口对新模型不再成立
  // （agent-atoms 里 contextWindow 还按 Math.max 累积，不校正的话只增不减）。
  const displayContextWindow = resolveDisplayContextWindow({
    currentModelId,
    reportedWindow: sessionId ? sessionStreamState.contextWindow : contextWindow,
    fallbackModelId: restored?.modelId,
  })
  const displayIsEstimated = sessionId
    ? sessionStreamState.contextUsageIsEstimated === true
    : isEstimated === true
  const displayIsCompacting = sessionId
    ? sessionStreamState.isCompacting === true
    : isCompacting === true

  // 保留最近一次有效的 token 值，避免切换会话时闪烁消失
  const stableRef = React.useRef<{
    inputTokens: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    contextWindow?: number
  } | null>(null)
  // 会话切换时清空陈旧值，避免新会话尚未上报 usage 时显示上个会话的数字
  const lastSessionRef = React.useRef<string | undefined>(sessionId)
  React.useEffect(() => {
    if (lastSessionRef.current !== sessionId) {
      stableRef.current = null
      lastSessionRef.current = sessionId
    }
  }, [sessionId])
  if (displayInputTokens && displayInputTokens > 0) {
    stableRef.current = {
      inputTokens: displayInputTokens,
      outputTokens: displayOutputTokens,
      cacheReadTokens: displayCacheReadTokens,
      cacheCreationTokens: displayCacheCreationTokens,
      contextWindow: displayContextWindow,
    }
  }

  const [open, setOpen] = React.useState(false)
  const closeTimerRef = React.useRef<number | null>(null)
  const popoverReceivedFocusRef = React.useRef(false)
  // 同账号刷新可保留旧值；切换账号或清空渠道时立即隐藏旧结果（上游 #2025 的竞态修复）。
  const [loadedQuota, setLoadedQuota] = React.useState<LoadedPlanQuota | null>(null)
  const quotaKey = planQuotaAccountKey(channelId, channelUpdatedAt)
  const quota = currentPlanQuota(loadedQuota, quotaKey)
  // 自动压缩阈值：atom 即时反映 UI，持久化经 updateSettings 落盘、下一轮 Agent 查询生效
  const [autoCompactionRatio, setAutoCompactionRatio] = useAtom(agentAutoCompactionRatioAtom)
  const effectiveRatio = normalizePiAutoCompactionRatio(autoCompactionRatio)

  const handleRatioChange = React.useCallback((values: number[]): void => {
    // Slider 以整数百分点步进，避免浮点步长在端点处的累计误差
    const ratio = (values[0] ?? 80) / 100
    setAutoCompactionRatio(ratio)
  }, [setAutoCompactionRatio])

  const handleRatioCommit = React.useCallback((values: number[]): void => {
    const ratio = (values[0] ?? 80) / 100
    window.electronAPI.updateSettings({ agentAutoCompactionRatio: ratio }).catch(console.error)
  }, [])

  // 提示缓存保留时长：同样 atom 即时反映、updateSettings 落盘；主进程按请求读取，下一次模型调用生效
  const [promptCacheRetention, setPromptCacheRetention] = useAtom(agentPromptCacheRetentionAtom)
  const effectiveCacheRetention: AgentPromptCacheRetention = promptCacheRetention === 'long' ? 'long' : 'short'
  const handleCacheRetentionSelect = React.useCallback((value: AgentPromptCacheRetention): void => {
    setPromptCacheRetention(value)
    window.electronAPI.updateSettings({ agentPromptCacheRetention: value }).catch(console.error)
  }, [setPromptCacheRetention])

  const cancelClose = React.useCallback(() => {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const scheduleClose = React.useCallback(() => {
    cancelClose()
    closeTimerRef.current = window.setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY)
  }, [cancelClose])

  React.useEffect(() => cancelClose, [cancelClose])

  React.useEffect(() => {
    if (!open || !channelId || !quotaKey) return

    let cancelled = false

    fetchChannelPlanQuota(channelId, channelUpdatedAt)
      .then((result) => {
        if (!cancelled) setLoadedQuota({ channelKey: quotaKey, result })
      })

    return () => {
      cancelled = true
    }
  }, [open, channelId, channelUpdatedAt, quotaKey])

  // 压缩中 → 按钮位置显示 spinner
  if (displayIsCompacting) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(inputToolbarButtonClass, 'text-muted-foreground cursor-default')}
        disabled
      >
        <Loader2 className="size-4 animate-spin" />
      </Button>
    )
  }

  // 使用稳定值：优先当前数据，回退到上次有效数据
  const stable = stableRef.current
  const hasCurrent = displayInputTokens != null && displayInputTokens > 0
  const displayTokens = hasCurrent ? displayInputTokens : stable?.inputTokens
  const displayWindow = hasCurrent ? displayContextWindow : stable?.contextWindow
  const displayOutput = hasCurrent ? displayOutputTokens : stable?.outputTokens
  const displayCacheRead = hasCurrent ? displayCacheReadTokens : stable?.cacheReadTokens
  const displayCacheCreation = hasCurrent ? displayCacheCreationTokens : stable?.cacheCreationTokens

  // 尚无用量（新建会话，或历史消息里也回推不出用量）时不再整体隐藏：本徽标是自动压缩
  // 阈值的唯一入口，藏起来会让用户在开跑前无处可设。此时显示空圆环，弹层只保留阈值滑块。
  const usedTokens = displayTokens ?? 0
  const hasUsage = usedTokens > 0

  // 警告阈值：Pi 在自动压缩阈值的 80% 时预警。
  const compactThreshold = displayWindow
    ? calculatePiAutoCompactionThresholdTokens(displayWindow, effectiveRatio)
    : undefined
  const isWarning = hasUsage && compactThreshold
    ? usedTokens / compactThreshold >= WARNING_RATIO
    : false

  const ratio = hasUsage && displayWindow ? usedTokens / displayWindow : 0

  const percent = hasUsage && displayWindow
    ? Math.round((usedTokens / displayWindow) * 100)
    : undefined

  const handleCompactClick = (): void => {
    if (isProcessing || !hasUsage) return
    onCompact()
    setOpen(false)
  }

  const shouldShowPlanQuota = quota != null && (
    quota.supported
    || quota.windows.length > 0
    || quota.message !== UNSUPPORTED_PLAN_QUOTA_MESSAGE
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            inputToolbarButtonClass,
            isWarning ? 'text-warning dark:text-warning' : 'text-foreground/60 hover:text-foreground',
          )}
          aria-label="上下文占用与自动压缩阈值"
          onMouseEnter={() => {
            cancelClose()
            setOpen(true)
          }}
          onMouseLeave={scheduleClose}
        >
          <UsageRing ratio={ratio} isWarning={isWarning} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={8}
        className="w-auto min-w-[220px] p-2.5"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
        onFocusCapture={() => {
          popoverReceivedFocusRef.current = true
        }}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(event) => {
          preventHoverPopoverFocusRestore(event, popoverReceivedFocusRef.current)
          popoverReceivedFocusRef.current = false
        }}
      >
        <div className="flex flex-col gap-1.5">
          {/* 零用量也渲染徽标与滑块（上游是隐藏纯指示器，我方改为常驻设置入口） */}
          {!hasUsage ? (
            <p className="text-[11px] leading-snug text-foreground/50">
              本会话还没有上下文占用，发出第一条消息后这里会显示明细。
            </p>
          ) : displayIsEstimated ? (
            <DetailRow
              label="压缩后"
              value={`预估 ${formatTokens(usedTokens)} tokens${percent != null ? `（${percent}%）` : ''}`}
              emphasized
            />
          ) : (
            <>
              {displayOutput ? <DetailRow label="输出" value={displayOutput.toLocaleString()} /> : null}
              {displayCacheCreation ? <DetailRow label="缓存写入" value={displayCacheCreation.toLocaleString()} /> : null}
              {displayCacheRead ? <DetailRow label="缓存读取" value={displayCacheRead.toLocaleString()} /> : null}

              {displayWindow ? (
                <>
                  <DetailRow
                    label="上下文"
                    value={`${formatTokens(usedTokens)} / ${formatTokens(displayWindow)}`}
                    emphasized
                  />
                  {percent != null && (
                    <DetailRow
                      label="占用"
                      value={`${percent}%`}
                      emphasized={isWarning}
                    />
                  )}
                </>
              ) : null}
            </>
          )}

          {shouldShowPlanQuota ? (
            <>
              <div className="h-px bg-border my-0.5" />
              <div className="text-[11px] font-medium text-foreground/70">
                订阅额度{quota?.planName ? ` · ${quota.planName}` : ''}
              </div>
              {quota?.supported && quota.windows.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  {quota.windows.map((quotaWindow) => (
                    <PlanQuotaRow key={`${quotaWindow.type}-${quotaWindow.label}`} quotaWindow={quotaWindow} provider={quota.provider} />
                  ))}
                </div>
              ) : (
                <div className="text-[11px] text-foreground/50">
                  {quota?.message ?? '订阅额度查询失败'}
                </div>
              )}
            </>
          ) : null}

          <div className="h-px bg-border my-0.5" />
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-4 text-xs">
              <span className="text-foreground/70">自动压缩阈值</span>
              <span className="tabular-nums font-medium text-foreground">
                {Math.round(effectiveRatio * 100)}%
                {compactThreshold ? ` · ${formatTokens(compactThreshold)}` : ''}
              </span>
            </div>
            <Slider
              value={[Math.round(effectiveRatio * 100)]}
              onValueChange={handleRatioChange}
              onValueCommit={handleRatioCommit}
              min={PI_AUTO_COMPACTION_MIN_RATIO * 100}
              max={PI_AUTO_COMPACTION_MAX_RATIO * 100}
              step={RATIO_SLIDER_STEP * 100}
              aria-label="自动压缩阈值百分比"
            />
            <p className="text-[11px] leading-snug text-foreground/50">
              占用达此比例时自动压缩历史，下一轮对话生效。
            </p>
          </div>

          <div className="h-px bg-border my-0.5" />
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-4 text-xs">
              <span className="text-foreground/70">提示缓存保留</span>
              <div className="inline-flex overflow-hidden rounded-md border border-border" role="radiogroup" aria-label="提示缓存保留时长">
                {PROMPT_CACHE_RETENTION_OPTIONS.map((option) => {
                  const active = effectiveCacheRetention === option.value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={cn(
                        'h-6 px-2 text-[11px] font-medium transition-colors',
                        active ? 'bg-primary text-primary-foreground' : 'text-foreground/70 hover:bg-muted/60 hover:text-foreground',
                      )}
                      onClick={() => handleCacheRetentionSelect(option.value)}
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            </div>
            <p className="text-[11px] leading-snug text-foreground/50">
              Claude 系（Anthropic 协议）模型生效，下一次请求起；1 小时的缓存写入单价更高，适合两轮之间常隔几分钟以上的对话。
            </p>
          </div>

          <div className="h-px bg-border my-0.5" />
          <Button
            type="button"
            variant={isWarning ? 'default' : 'outline'}
            size="sm"
            className={cn(
              'h-7 text-xs gap-1.5',
              isWarning && 'bg-warning hover:bg-warning/90 text-white',
            )}
            onClick={handleCompactClick}
            disabled={isProcessing || !hasUsage}
          >
            <Minimize2 className="size-3.5" />
            {isProcessing ? '对话进行中' : hasUsage ? '手动压缩' : '暂无可压缩内容'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
