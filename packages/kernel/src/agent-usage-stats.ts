/**
 * Agent token 用量统计。
 *
 * 数据来源是会话 JSONL 里已经落盘的 usage，不新增任何采集链路。
 *
 * **口径按实测定（2026-09-09，12 个真实会话）**：
 * - 按 **assistant 消息**累加，不用 result。实测同一批会话里 assistant 有 106 条、result 只有 40 条，
 *   result.usage 等于该轮最后一次 API 调用的值而非整轮累加——拿 result 统计会严重低估多轮工具调用。
 * - 模型名取 `message.model`（实测 106/106 条都有）。`result.modelUsage` 里只有 contextWindow，
 *   没有分模型的 token 数，指望不上。
 * - **时间维度用消息自带的 `_createdAt`**（毫秒时间戳，实测 106/106 条全有、零缺失）。
 *   ⚠️ 按天分组一律走**本地时区**：用 UTC 的话，东八区晚上 8 点之后的调用会被算进第二天。
 * - 渠道维度取 `_channelProvider`（实测同批会话 openai-responses 42 / deepseek 64）。
 *
 * 只统计 token，不算钱：各渠道单价不同、部分渠道计价随时可调，内置价格表迟早算错。
 * （result 里虽有上游填的 total_cost_usd，但那是按它自己的价格表算的，不采信。）
 *
 * **四类 token 的口径（2026-09-17 核对 Pi 0.85.1 各协议适配源码 + 本机两份数据目录 105 条带 usage 的记录）**：
 * 落盘的 `message.usage` 由 runtime-pi `pi-message-adapter.ts` 的 `usageFromAssistant` 从 Pi 的 `Usage`
 * 逐项映射而来；各供应商字段名的差异 **Pi 已在协议层统一**，归一成**互不重叠**的四段：
 * - `input_tokens` ← Pi `usage.input`：**不含缓存**的输入。OpenAI Chat（`openai-completions`）/ Responses、Gemini
 *   上报的提示词总数本来含缓存，Pi 已先减去缓存读取（与 cache_write_tokens）；Anthropic 协议（anthropic / deepseek 等
 *   默认走 `anthropic-messages` 的渠道，见 runtime-pi `resolvePiApi`）的 input_tokens 按协议本就不含缓存，原样取。
 *   本机开发数据目录实测佐证：deepseek 57 条合计输入 196,785 < 缓存读取 1,211,264，openai-responses 42 条输入
 *   331,647 < 缓存读取 551,424——若输入里含缓存，不可能小于后者。
 * - `cache_read_input_tokens` ← Pi `usage.cacheRead`：Anthropic `cache_read_input_tokens`、OpenAI
 *   `prompt_tokens_details.cached_tokens` / `input_tokens_details.cached_tokens`（Chat 端另认 `prompt_cache_hit_tokens`）、
 *   Gemini `cachedContentTokenCount`。
 * - `cache_creation_input_tokens` ← Pi `usage.cacheWrite`：Anthropic `cache_creation_input_tokens`、OpenAI 兼容端的
 *   `cache_write_tokens`；不报写入的供应商恒为 0（本机 105 条实测全为 0）。
 * - `output_tokens` ← Pi `usage.output`（已含推理 token）。
 *
 * 所以「合计 = 四项相加」不会重复计数；「完整提示词 = 输入 + 缓存读取 + 缓存写入」，缓存命中率以它为分母
 * （渲染层 `renderer/lib/usage-stats-format.ts` 的 `cacheHitRatio`）。
 * 缺缓存字段的老记录按 0 计（见 `parseUsageLine` 的 `num`），不影响其余字段。
 * ⚠️ 前提是上游按协议如实报数：若某个 Anthropic 兼容中转把含缓存的总数塞进 input_tokens，这里无从识别，输入会偏大。
 *
 * Chat 模式不在统计内：Chat 消息（`ChatMessage`）根本不落 usage，没有数据可读。
 */

import { existsSync, readFileSync } from 'node:fs'
import type { AgentSessionMeta } from '@canopy/shared'
import { getAgentSessionMessagesFilePath, listAgentSessions } from './agent-session-store'

/** 一组用量累加值。 */
export interface UsageTotals {
  /** 非缓存的输入 token（Pi 已归一：**不含** cacheRead / cacheWrite，三者互不重叠） */
  inputTokens: number
  /** 输出 token（含推理 token） */
  outputTokens: number
  /** 命中缓存读取的输入 token；老记录缺该字段时为 0 */
  cacheReadTokens: number
  /** 写入缓存所消耗的输入 token（UI 上叫「缓存写入」）；老记录缺该字段、或供应商不报写入时为 0 */
  cacheCreationTokens: number
  /** 计入统计的模型调用次数（assistant 消息条数） */
  calls: number
}

export interface ModelUsageStat extends UsageTotals {
  modelId: string
}

export interface ChannelUsageStat extends UsageTotals {
  /**
   * 渠道实例 id。**早期记录没有这个字段**（实测 106 条里仅 39 条有），
   * 缺失时该行代表「某 provider 下无法归属到具体渠道的历史用量」，由渲染层决定怎么合并显示。
   */
  channelId?: string
  /** 渠道 provider（deepseek / openai-responses / anthropic-compatible …），实测 106/106 全有 */
  provider: string
}

export interface DailyUsageStat extends UsageTotals {
  /** 本地时区的日期键，形如 2026-09-09 */
  date: string
}

/** 统计的时间范围；两端都可省，省略即不设限 */
export interface UsageStatsRange {
  /** 起点（含），毫秒时间戳 */
  since?: number
  /** 终点（含），毫秒时间戳 */
  until?: number
}

export interface SessionUsageStat extends UsageTotals {
  sessionId: string
  title: string
  /** 会话最后活跃时间（毫秒时间戳）。注意这是**会话级**时间，消息级没有时间戳 */
  updatedAt?: number
  /** 该会话里出现过的模型，按用量降序 */
  modelIds: string[]
}

export interface AgentUsageStats {
  total: UsageTotals
  /** 按总 token 降序 */
  byModel: ModelUsageStat[]
  /** 按总 token 降序；渠道实例优先，早期无 channelId 的记录单独成行 */
  byChannel: ChannelUsageStat[]
  /** 按日期升序（本地时区），只含有用量的日子 */
  byDay: DailyUsageStat[]
  /** 按总 token 降序，只含真正有用量的会话 */
  bySession: SessionUsageStat[]
  /** 扫描到的会话总数 */
  sessionCount: number
  /** 其中在本次时间范围内含用量数据的会话数 */
  countedSessionCount: number
  /** 本次统计采用的时间范围，回显给 UI */
  range: UsageStatsRange
  /** 全部记录里最早 / 最晚的一次调用，供 UI 决定可选范围（不受本次筛选影响） */
  earliestAt?: number
  latestAt?: number
  /** 统计生成时间，供 UI 显示「截至」 */
  generatedAt: string
}

/** 一条 assistant 消息里提取出来的用量。 */
export interface ParsedMessageUsage {
  modelId: string
  usage: UsageTotals
  /** 消息落盘时间（毫秒）；极老的记录可能没有 */
  createdAt?: number
  /** 渠道 provider */
  provider?: string
  /** 渠道实例 id；早期记录没有 */
  channelId?: string
}

export function createEmptyTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, calls: 0 }
}

/** 总 token = 输入 + 输出 + 两类缓存，与 UI 上的「合计」一致。 */
export function totalTokensOf(totals: UsageTotals): number {
  return totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheCreationTokens
}

export function addTotals(target: UsageTotals, delta: UsageTotals): void {
  target.inputTokens += delta.inputTokens
  target.outputTokens += delta.outputTokens
  target.cacheReadTokens += delta.cacheReadTokens
  target.cacheCreationTokens += delta.cacheCreationTokens
  target.calls += delta.calls
}

const UNKNOWN_MODEL_ID = '(未记录模型)'
const UNKNOWN_PROVIDER = '(未记录渠道)'

/**
 * 从一行 JSONL 里提取 assistant 的用量；不是带用量的 assistant 消息则返回 null。
 *
 * 先用字符串预筛跳过绝大多数行（工具结果、用户消息往往很长），命中才 JSON.parse。
 */
export function parseUsageLine(line: string): ParsedMessageUsage | null {
  if (!line.includes('"type":"assistant"')) return null
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    return null // 落盘被截断的半行：跳过而不是让整份统计失败
  }
  if (typeof message !== 'object' || message === null) return null
  const record = message as {
    type?: unknown
    _createdAt?: unknown
    _channelProvider?: unknown
    _channelId?: unknown
    message?: {
      model?: unknown
      usage?: {
        input_tokens?: unknown
        output_tokens?: unknown
        cache_read_input_tokens?: unknown
        cache_creation_input_tokens?: unknown
      }
    }
  }
  if (record.type !== 'assistant') return null
  const usage = record.message?.usage
  if (!usage) return null

  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
  const parsed: UsageTotals = {
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheCreationTokens: num(usage.cache_creation_input_tokens),
    calls: 1,
  }
  // 四项全 0 的空壳 assistant（中止 / 错误占位）不计入调用次数，否则会虚增"调用了多少次"
  if (totalTokensOf(parsed) === 0) return null

  const modelId = typeof record.message?.model === 'string' && record.message.model.trim()
    ? record.message.model.trim()
    : UNKNOWN_MODEL_ID
  const createdAt = typeof record._createdAt === 'number' && Number.isFinite(record._createdAt)
    ? record._createdAt
    : undefined
  const provider = typeof record._channelProvider === 'string' && record._channelProvider.trim()
    ? record._channelProvider.trim()
    : undefined
  const channelId = typeof record._channelId === 'string' && record._channelId.trim()
    ? record._channelId.trim()
    : undefined
  return { modelId, usage: parsed, createdAt, provider, channelId }
}

/**
 * 本地时区的日期键。**不能用 toISOString().slice(0,10)**——那是 UTC 日期，
 * 东八区晚上 8 点之后的调用会被算进第二天。
 */
export function localDayKey(timestamp: number): string {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 时间戳是否落在范围内；两端都是闭区间，缺失时间戳的记录只在无筛选时计入。 */
export function isWithinRange(createdAt: number | undefined, range: UsageStatsRange): boolean {
  const hasBound = range.since !== undefined || range.until !== undefined
  if (createdAt === undefined) return !hasBound
  if (range.since !== undefined && createdAt < range.since) return false
  if (range.until !== undefined && createdAt > range.until) return false
  return true
}

/** 一份会话正文的汇总结果。 */
export interface SessionUsageCollection {
  totals: UsageTotals
  byModel: Map<string, UsageTotals>
  /** key 优先用 channelId；早期记录没有该字段时退化成 `provider:<名字>` */
  byChannel: Map<string, { provider: string; channelId?: string; totals: UsageTotals }>
  /** 本地时区日期 → 该日用量 */
  byDay: Map<string, UsageTotals>
  /** 该会话最早 / 最晚一次调用；**不受 range 影响**，供 UI 决定可选的时间范围 */
  earliestAt?: number
  latestAt?: number
}

/** 汇总一份会话正文；给了 range 就只统计范围内的调用。 */
export function collectUsageFromContent(content: string, range: UsageStatsRange = {}): SessionUsageCollection {
  const totals = createEmptyTotals()
  const byModel = new Map<string, UsageTotals>()
  const byChannel = new Map<string, { provider: string; channelId?: string; totals: UsageTotals }>()
  const byDay = new Map<string, UsageTotals>()
  let earliestAt: number | undefined
  let latestAt: number | undefined

  const bump = (map: Map<string, UsageTotals>, key: string, usage: UsageTotals): void => {
    const bucket = map.get(key) ?? createEmptyTotals()
    addTotals(bucket, usage)
    map.set(key, bucket)
  }

  for (const line of content.split('\n')) {
    if (!line) continue
    const parsed = parseUsageLine(line)
    if (!parsed) continue

    // 先记录全量时间跨度，再做范围过滤——否则筛过之后 UI 就不知道还有多少数据可选
    if (parsed.createdAt !== undefined) {
      if (earliestAt === undefined || parsed.createdAt < earliestAt) earliestAt = parsed.createdAt
      if (latestAt === undefined || parsed.createdAt > latestAt) latestAt = parsed.createdAt
    }
    if (!isWithinRange(parsed.createdAt, range)) continue

    addTotals(totals, parsed.usage)
    bump(byModel, parsed.modelId, parsed.usage)
    if (parsed.createdAt !== undefined) bump(byDay, localDayKey(parsed.createdAt), parsed.usage)

    // 渠道：有 channelId 就按实例分，没有（早期记录）就按 provider 归一堆，
    // 让渲染层拿现存渠道列表去决定能不能并进某个具体渠道
    const provider = parsed.provider ?? UNKNOWN_PROVIDER
    const channelKey = parsed.channelId ?? `provider:${provider}`
    const channelBucket = byChannel.get(channelKey)
      ?? { provider, channelId: parsed.channelId, totals: createEmptyTotals() }
    addTotals(channelBucket.totals, parsed.usage)
    byChannel.set(channelKey, channelBucket)
  }

  return { totals, byModel, byChannel, byDay, earliestAt, latestAt }
}

/** 读一个会话正文；文件不存在或读失败时返回空串（统计不该因单个坏文件整体失败）。 */
function readSessionContent(sessionId: string): string {
  try {
    const path = getAgentSessionMessagesFilePath(sessionId)
    if (!existsSync(path)) return ''
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** 聚合只用到会话索引里的这几个字段 */
export type UsageSessionMeta = Pick<AgentSessionMeta, 'id' | 'title' | 'updatedAt'>

/**
 * 汇总全部 Agent 会话的 token 用量。
 *
 * `readContent` / `listSessions` 可注入，供测试用假数据；生产走真实索引与文件。
 */
export function aggregateAgentUsage(
  range: UsageStatsRange = {},
  readContent: (sessionId: string) => string = readSessionContent,
  listSessions: () => readonly UsageSessionMeta[] = () => listAgentSessions('all'),
): AgentUsageStats {
  const sessions = listSessions()
  const total = createEmptyTotals()
  const modelTotals = new Map<string, UsageTotals>()
  const channelTotals = new Map<string, { provider: string; channelId?: string; totals: UsageTotals }>()
  const dayTotals = new Map<string, UsageTotals>()
  const bySession: SessionUsageStat[] = []
  let earliestAt: number | undefined
  let latestAt: number | undefined

  const merge = (target: Map<string, UsageTotals>, source: Map<string, UsageTotals>): void => {
    for (const [key, usage] of source) {
      const bucket = target.get(key) ?? createEmptyTotals()
      addTotals(bucket, usage)
      target.set(key, bucket)
    }
  }

  for (const session of sessions) {
    const collected = collectUsageFromContent(readContent(session.id), range)

    // 时间跨度取全量口径，不受本次筛选影响
    if (collected.earliestAt !== undefined && (earliestAt === undefined || collected.earliestAt < earliestAt)) {
      earliestAt = collected.earliestAt
    }
    if (collected.latestAt !== undefined && (latestAt === undefined || collected.latestAt > latestAt)) {
      latestAt = collected.latestAt
    }

    if (collected.totals.calls === 0) continue
    addTotals(total, collected.totals)
    merge(modelTotals, collected.byModel)
    merge(dayTotals, collected.byDay)
    for (const [key, entry] of collected.byChannel) {
      const bucket = channelTotals.get(key)
        ?? { provider: entry.provider, channelId: entry.channelId, totals: createEmptyTotals() }
      addTotals(bucket.totals, entry.totals)
      channelTotals.set(key, bucket)
    }
    bySession.push({
      ...collected.totals,
      sessionId: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      modelIds: [...collected.byModel.entries()]
        .sort((a, b) => totalTokensOf(b[1]) - totalTokensOf(a[1]))
        .map(([modelId]) => modelId),
    })
  }

  const byModel: ModelUsageStat[] = [...modelTotals.entries()]
    .map(([modelId, usage]) => ({ ...usage, modelId }))
    .sort((a, b) => totalTokensOf(b) - totalTokensOf(a))
  const byChannel: ChannelUsageStat[] = [...channelTotals.values()]
    .map((entry) => ({ ...entry.totals, provider: entry.provider, channelId: entry.channelId }))
    .sort((a, b) => totalTokensOf(b) - totalTokensOf(a))
  const byDay: DailyUsageStat[] = [...dayTotals.entries()]
    .map(([date, usage]) => ({ ...usage, date }))
    .sort((a, b) => a.date.localeCompare(b.date))

  bySession.sort((a, b) => totalTokensOf(b) - totalTokensOf(a))

  return {
    total,
    byModel,
    byChannel,
    byDay,
    bySession,
    sessionCount: sessions.length,
    countedSessionCount: bySession.length,
    range,
    earliestAt,
    latestAt,
    generatedAt: new Date().toISOString(),
  }
}
