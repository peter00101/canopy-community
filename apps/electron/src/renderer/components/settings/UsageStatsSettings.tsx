/**
 * UsageStatsSettings — token 用量统计面板
 *
 * 数据来自本机已落盘的 Agent 会话记录，不额外采集、不上报（Chat 模式的消息不落 usage，不在统计内）。
 * 只统计 token 不折算金额：各渠道单价不同、部分渠道计价可调，内置价格表迟早算错。
 *
 * 口径与 kernel/agent-usage-stats.ts 一致：按 assistant 消息累加（result 是单轮最后一次
 * 调用的值，拿它统计会低估多轮工具调用）；日期取每条消息自带的 _createdAt，按本机时区分组。
 * 输入 / 缓存读取 / 缓存写入是 Pi 已归一的三段互不重叠的输入：合计 = 四项相加，
 * 缓存命中率 = 缓存读取 ÷（输入 + 缓存读取 + 缓存写入），见 lib/usage-stats-format.ts。
 *
 * 防溢出：数字一律走紧凑格式（长度有上限）+ tabular-nums + 不换行，精确值放 title；
 * 名称类文本 min-w-0 + truncate，窄窗口下截断而不是撑破卡片。
 */

import * as React from 'react'
import { RefreshCw } from 'lucide-react'
import type { AgentUsageStats, UsageStatsRange, UsageTotals } from '@canopy/kernel'
import {
  SettingsSection,
  SettingsCard,
  SettingsSegmentedControl,
  DESCRIPTION_CLASS,
  LABEL_CLASS,
  ROW_CLASS,
} from './primitives'
import { Button } from '../ui/button'
import { cn } from '@/lib/utils'
import {
  buildUsageBreakdownItems,
  CACHE_HIT_RATIO_HINT,
  cacheHitRatio,
  formatCompactCount,
  formatExactCount,
  formatRatio,
  USAGE_TOKEN_LABELS,
} from '@/lib/usage-stats-format'
import type { UsageTokenKey } from '@/lib/usage-stats-format'

function totalOf(totals: UsageTotals): number {
  return totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheCreationTokens
}

/**
 * 求和若干组用量。
 * 这里不复用 kernel 的 addTotals——kernel 依赖 node:fs，运行时 import 会打不进渲染层 bundle，
 * 渲染层只从它取类型。
 */
function sumTotals(items: readonly UsageTotals[]): UsageTotals {
  const sum: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, calls: 0 }
  for (const item of items) {
    sum.inputTokens += item.inputTokens
    sum.outputTokens += item.outputTokens
    sum.cacheReadTokens += item.cacheReadTokens
    sum.cacheCreationTokens += item.cacheCreationTokens
    sum.calls += item.calls
  }
  return sum
}

/** 四类 token 的构成条。颜色全部由 --primary 派生，随主题走。 */
const COMPOSITION: { key: UsageTokenKey; label: string; className: string }[] = [
  { key: 'inputTokens', label: USAGE_TOKEN_LABELS.inputTokens, className: 'bg-primary' },
  { key: 'outputTokens', label: USAGE_TOKEN_LABELS.outputTokens, className: 'bg-primary/60' },
  { key: 'cacheReadTokens', label: USAGE_TOKEN_LABELS.cacheReadTokens, className: 'bg-primary/30' },
  { key: 'cacheCreationTokens', label: USAGE_TOKEN_LABELS.cacheCreationTokens, className: 'bg-primary/15' },
]

/**
 * 数据条入场：挂载后下一帧才铺开到真实宽度。
 *
 * 统计面板是「打开时一次性看个数」的场景，条从 0 长到位能把注意力带到长度差异上；
 * 这类一次性入场不会打扰后续操作，也不需要用户等待——数据早已渲染，动的只是宽度。
 */
function useBarEntrance(): boolean {
  const [entered, setEntered] = React.useState(false)
  React.useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [])
  return entered
}

const BAR_TRANSITION = 'width var(--duration-slow) var(--ease-out-soft)'

function CompositionBar({ totals }: { totals: UsageTotals }): React.ReactElement {
  const sum = totalOf(totals)
  const entered = useBarEntrance()
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" role="presentation">
      {sum > 0 && COMPOSITION.map(({ key, className }) => {
        const value = totals[key]
        if (value <= 0) return null
        return (
          <div
            key={key}
            className={className}
            style={{ width: entered ? `${(value / sum) * 100}%` : '0%', transition: BAR_TRANSITION }}
          />
        )
      })}
    </div>
  )
}

/**
 * 总览里的一格。网格列宽由容器决定，格子本身 min-w-0，
 * 数字再长也只会截断（title 里有完整值），不会把相邻格子挤歪或撑出卡片。
 */
function StatBlock({
  label,
  value,
  valueTitle,
  hint,
}: {
  label: string
  value: string
  /** 悬停显示的完整值；缺省用 value */
  valueTitle?: string
  hint?: string
}): React.ReactElement {
  return (
    <div className="min-w-0">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-xl font-semibold tabular-nums" title={valueTitle ?? value}>{value}</div>
      {hint ? <div className="mt-0.5 truncate text-xs text-muted-foreground tabular-nums" title={hint}>{hint}</div> : null}
    </div>
  )
}

/**
 * 按容器宽度自动排列的网格：放得下几列就几列，窄窗口自动折行。
 * 不用 sm:/md: 断点——它们看的是视口宽，设置页内容区宽度还受左导航与页边距影响。
 */
const AUTO_GRID_CLASS = 'grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))]'

/**
 * 行内明细：四类 token + 缓存命中率（包含哪几项、取值与标签见 buildUsageBreakdownItems）。
 * 每一项整体不换行，放不下时整项折到下一行，仍放不下才截断。
 */
function UsageBreakdown({ totals }: { totals: UsageTotals }): React.ReactElement {
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      {buildUsageBreakdownItems(totals).map((item) => (
        <span key={item.key} className="max-w-full truncate" title={item.title}>
          {item.label} <span className="tabular-nums text-foreground/80">{item.compact}</span>
        </span>
      ))}
    </div>
  )
}

/**
 * 单行：名称 + 明细 + 占比条 + 合计 + 调用次数，用于按日期 / 模型 / 渠道 / 会话四张表。
 *
 * 右侧数字列用 min-w + whitespace-nowrap：紧凑格式长度有上限，定宽能对齐，万一更长就把左侧
 * 名称挤窄（名称 truncate），而不是换行或溢出卡片。不传 maxTotal 时不画条（汇总行），
 * 但留出同宽占位，让合计列与上面各行对齐。
 */
function UsageRow({
  name,
  sub,
  totals,
  maxTotal,
  muted = false,
}: {
  name: string
  sub?: string
  totals: UsageTotals
  maxTotal?: number
  /** 汇总行：合计数字用弱化色 */
  muted?: boolean
}): React.ReactElement {
  const sum = totalOf(totals)
  const ratio = maxTotal !== undefined && maxTotal > 0 ? Math.min(100, (sum / maxTotal) * 100) : 0
  const entered = useBarEntrance()
  return (
    <div className={cn(ROW_CLASS, 'gap-4')}>
      <div className="min-w-0 flex-1">
        <div className={cn(LABEL_CLASS, 'truncate')} title={name}>{name}</div>
        {sub ? <div className={cn(DESCRIPTION_CLASS, 'mt-0.5 truncate')} title={sub}>{sub}</div> : null}
        <UsageBreakdown totals={totals} />
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {maxTotal === undefined ? (
          <div className="w-16" aria-hidden="true" />
        ) : (
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted" role="presentation">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: entered ? `${ratio}%` : '0%', transition: BAR_TRANSITION }}
            />
          </div>
        )}
        <span
          className={cn('min-w-[4.5rem] whitespace-nowrap text-right text-sm tabular-nums', muted && 'text-muted-foreground')}
          title={`合计 ${formatExactCount(sum)} token`}
        >
          {formatCompactCount(sum)}
        </span>
        <span
          className="min-w-[4rem] whitespace-nowrap text-right text-xs text-muted-foreground tabular-nums"
          title={`${formatExactCount(totals.calls)} 次模型调用`}
        >
          {formatCompactCount(totals.calls)} 次
        </span>
      </div>
    </div>
  )
}

const SESSION_PREVIEW_COUNT = 8
const DAY_PREVIEW_COUNT = 10
/**
 * 展开后的渲染上限。
 *
 * 聚合本身对规模不敏感（压测：1000 会话 / 867 MB 数据 692ms、堆无累积），瓶颈在 DOM——
 * 重度用户几百上千个会话全铺出来会明显卡。超出的部分不隐藏，末尾用一行汇总交代清楚，
 * 免得用户以为数据丢了。
 */
const SESSION_EXPAND_LIMIT = 100
const DAY_EXPAND_LIMIT = 60

type RangeKey = 'today' | '7d' | '30d' | 'all'

const RANGE_OPTIONS: { value: RangeKey; label: string }[] = [
  { value: 'today', label: '今天' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: 'all', label: '全部' },
]

/**
 * 把档位换算成时间范围。
 *
 * 起点一律取**本地**当天 0 点再往前推：用 UTC 的话东八区会整体偏 8 小时，
 * 「今天」会把昨天早上的调用算进来。与 kernel 的 localDayKey 同一套时区口径。
 */
function computeRange(key: RangeKey): UsageStatsRange {
  if (key === 'all') return {}
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const backDays = key === 'today' ? 0 : key === '7d' ? 6 : 29
  start.setDate(start.getDate() - backDays)
  return { since: start.getTime() }
}

/** 2026-09-09 → 09-09；今天/昨天给出更好读的名字 */
function formatDayLabel(date: string): string {
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  if (date === today) return `今天 ${date.slice(5)}`
  const yesterdayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  const yesterday = `${yesterdayDate.getFullYear()}-${String(yesterdayDate.getMonth() + 1).padStart(2, '0')}-${String(yesterdayDate.getDate()).padStart(2, '0')}`
  if (date === yesterday) return `昨天 ${date.slice(5)}`
  return date
}

export function UsageStatsSettings(): React.ReactElement {
  const [stats, setStats] = React.useState<AgentUsageStats | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const [showAllSessions, setShowAllSessions] = React.useState(false)
  const [showAllDays, setShowAllDays] = React.useState(false)
  const [rangeKey, setRangeKey] = React.useState<RangeKey>('all')
  /** 渠道 id → 用户起的名字。消息里只存 id，名字要现查。 */
  const [channelNames, setChannelNames] = React.useState<Map<string, string>>(new Map())

  React.useEffect(() => {
    let cancelled = false
    void window.electronAPI.listChannels()
      .then((channels) => {
        if (cancelled) return
        setChannelNames(new Map(channels.map((channel) => [channel.id, channel.name])))
      })
      .catch((e) => console.error('[用量统计] 读取渠道列表失败:', e))
    return () => { cancelled = true }
  }, [])

  const loadStats = React.useCallback(async (key: RangeKey): Promise<void> => {
    setLoading(true)
    setFailed(false)
    try {
      setStats(await window.electronAPI.getAgentUsageStats(computeRange(key)))
    } catch (e) {
      console.error('[用量统计] 获取失败:', e)
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void loadStats(rangeKey) }, [loadStats, rangeKey])

  const total = stats?.total
  const grandTotal = total ? totalOf(total) : 0
  const maxModelTotal = stats?.byModel.length ? totalOf(stats.byModel[0]!) : 0
  const maxSessionTotal = stats?.bySession.length ? totalOf(stats.bySession[0]!) : 0
  const visibleSessions = stats
    ? stats.bySession.slice(0, showAllSessions ? SESSION_EXPAND_LIMIT : SESSION_PREVIEW_COUNT)
    : []
  /** 没渲染出来的部分，用一行汇总交代，避免看着像数据丢了 */
  const hiddenSessions = stats ? stats.bySession.slice(visibleSessions.length) : []
  const hiddenSessionTotals = React.useMemo(() => sumTotals(hiddenSessions), [hiddenSessions])
  // 按天倒序看更符合直觉（最近的在最上面）；kernel 给的是升序
  const daysDesc = React.useMemo(() => (stats ? [...stats.byDay].reverse() : []), [stats])
  const visibleDays = daysDesc.slice(0, showAllDays ? DAY_EXPAND_LIMIT : DAY_PREVIEW_COUNT)
  const hiddenDays = daysDesc.slice(visibleDays.length)
  const hiddenDayTotals = React.useMemo(() => sumTotals(hiddenDays), [hiddenDays])
  const maxDayTotal = daysDesc.length ? Math.max(...daysDesc.map(totalOf)) : 0
  const maxChannelTotal = stats?.byChannel.length ? totalOf(stats.byChannel[0]!) : 0

  return (
    <div className="space-y-6">
      <SettingsSection
        title="用量总计"
        description="只统计本机 Agent 会话已用的 token（Chat 模式暂不记录用量），不含金额。缓存读取按实际计入，与账单口径可能有出入。"
        action={
          <Button variant="ghost" size="sm" onClick={() => void loadStats(rangeKey)} disabled={loading} className="gap-1.5">
            <RefreshCw size={14} className={cn(loading && 'animate-spin')} />
            刷新
          </Button>
        }
      >
        <SettingsCard>
          <SettingsSegmentedControl
            label="统计范围"
            description="按每次模型调用的实际发生时间筛选，日期按本机时区划分"
            value={rangeKey}
            onValueChange={(value) => { setRangeKey(value as RangeKey); setShowAllDays(false) }}
            options={RANGE_OPTIONS}
            disabled={loading}
          />
          <div className="p-4">
            {failed ? (
              <div className="py-6 text-center text-sm text-muted-foreground">读取失败，请点右上角刷新重试</div>
            ) : !stats ? (
              <div className="py-6 text-center text-sm text-muted-foreground">正在统计...</div>
            ) : grandTotal === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                {rangeKey === 'all'
                  ? '还没有 Agent 会话用量（Chat 模式暂不记录用量）'
                  : '这个时间范围内没有 Agent 会话用量，换个范围看看'}
              </div>
            ) : (
              <>
                <div className={cn(AUTO_GRID_CLASS, 'gap-4')}>
                  <StatBlock
                    label="合计 token"
                    value={formatCompactCount(grandTotal)}
                    valueTitle={`${formatExactCount(grandTotal)} token`}
                    hint={formatExactCount(grandTotal)}
                  />
                  <StatBlock
                    label="模型调用"
                    value={formatCompactCount(total!.calls)}
                    valueTitle={`${formatExactCount(total!.calls)} 次`}
                    hint="次 API 调用"
                  />
                  <StatBlock
                    label="涉及会话"
                    value={formatCompactCount(stats.countedSessionCount)}
                    valueTitle={`${formatExactCount(stats.countedSessionCount)} 个`}
                    hint={`共 ${formatExactCount(stats.sessionCount)} 个会话`}
                  />
                  <StatBlock
                    label="缓存命中率"
                    value={formatRatio(cacheHitRatio(total!))}
                    valueTitle={CACHE_HIT_RATIO_HINT}
                    hint="缓存读取占全部输入"
                  />
                </div>
                <div className="mt-4">
                  <CompositionBar totals={total!} />
                  <div className={cn(AUTO_GRID_CLASS, 'mt-3 gap-x-4 gap-y-2')}>
                    {COMPOSITION.map(({ key, label, className }) => (
                      <div key={key} className="min-w-0" title={`${label} ${formatExactCount(total![key])} token`}>
                        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                          <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', className)} />
                          <span className="truncate">{label}</span>
                        </div>
                        <div className="mt-0.5 truncate text-sm font-medium tabular-nums">
                          {formatCompactCount(total![key])}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </SettingsCard>
      </SettingsSection>

      {stats && daysDesc.length > 0 && (
        <SettingsSection
          title="按日期"
          description={`共 ${daysDesc.length} 天有用量，最近的在前`}
          action={
            daysDesc.length > DAY_PREVIEW_COUNT ? (
              <Button variant="ghost" size="sm" onClick={() => setShowAllDays((v) => !v)}>
                {showAllDays ? '收起' : `展开全部 ${daysDesc.length} 天`}
              </Button>
            ) : undefined
          }
        >
          <SettingsCard>
            {visibleDays.map((day) => (
              <UsageRow key={day.date} name={formatDayLabel(day.date)} totals={day} maxTotal={maxDayTotal} />
            ))}
            {hiddenDays.length > 0 ? (
              <UsageRow
                name={`其余 ${hiddenDays.length} 天`}
                sub="未逐条列出，合计如右"
                totals={hiddenDayTotals}
                muted
              />
            ) : null}
          </SettingsCard>
        </SettingsSection>
      )}

      {stats && stats.byModel.length > 0 && (
        <SettingsSection title="按模型" description="同一模型跨会话累计">
          <SettingsCard>
            {stats.byModel.map((model) => (
              <UsageRow key={model.modelId} name={model.modelId} totals={model} maxTotal={maxModelTotal} />
            ))}
          </SettingsCard>
        </SettingsSection>
      )}

      {stats && stats.byChannel.length > 0 && (
        <SettingsSection
          title="按渠道"
          description="按渠道实例统计；早期记录没有留下渠道标识，只能按类型单独列出"
        >
          <SettingsCard>
            {stats.byChannel.map((channel) => {
              const key = channel.channelId ?? `provider:${channel.provider}`
              // 有 id 就报名字；渠道删了或早期记录没 id，如实说明而不是猜一个名字挂上去
              const name = channel.channelId
                ? (channelNames.get(channel.channelId) ?? '已删除的渠道')
                : channel.provider
              const sub = channel.channelId
                ? channel.provider
                : `${channel.provider} · 早期记录，未留渠道标识`
              return (
                <UsageRow key={key} name={name} sub={sub} totals={channel} maxTotal={maxChannelTotal} />
              )
            })}
          </SettingsCard>
        </SettingsSection>
      )}

      {stats && stats.bySession.length > 0 && (
        <SettingsSection
          title="按会话"
          description={`用量最高的会话在前，共 ${stats.bySession.length} 个`}
          action={
            stats.bySession.length > SESSION_PREVIEW_COUNT ? (
              <Button variant="ghost" size="sm" onClick={() => setShowAllSessions((v) => !v)}>
                {showAllSessions ? '收起' : `展开全部 ${stats.bySession.length} 个`}
              </Button>
            ) : undefined
          }
        >
          <SettingsCard>
            {visibleSessions.map((session) => (
              <UsageRow
                key={session.sessionId}
                name={session.title}
                sub={session.modelIds.join('、')}
                totals={session}
                maxTotal={maxSessionTotal}
              />
            ))}
            {hiddenSessions.length > 0 ? (
              <UsageRow
                name={`其余 ${hiddenSessions.length} 个会话`}
                sub={showAllSessions ? `一次最多列 ${SESSION_EXPAND_LIMIT} 个，合计如右` : '未逐条列出，合计如右'}
                totals={hiddenSessionTotals}
                muted
              />
            ) : null}
          </SettingsCard>
        </SettingsSection>
      )}
    </div>
  )
}
