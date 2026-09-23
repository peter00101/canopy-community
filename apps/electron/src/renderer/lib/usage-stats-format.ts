/**
 * 用量统计面板的数字格式化与缓存命中率。
 *
 * 纯函数、零运行时依赖：渲染层不能在运行时 import `@canopy/kernel`（它依赖 node:fs，打不进 bundle），
 * 所以面板要用的算术收在这里，类型仍从 kernel 取。
 *
 * **token 口径**（详见 packages/kernel/src/agent-usage-stats.ts 顶部注释）：落盘的输入 / 缓存读取 /
 * 缓存写入是 Pi 已归一的**三段互不重叠**的输入，三者相加才是一次请求的完整提示词长度。
 */

import type { UsageTotals } from '@canopy/kernel'

/** 无效值与「无法计算」的占位 */
export const EMPTY_VALUE = '—'

/**
 * 紧凑格式的档位，沿用面板原有风格：10 万以下给千分位原数，往上 K 保留 1 位、M 及以上保留 2 位。
 * 每档四舍五入后若到了 1000，就进到下一档（避免出现「1000.0 K」这种比「1.00 M」更长的写法）。
 */
const COMPACT_TIERS: readonly { min: number; divisor: number; digits: number; suffix: string }[] = [
  { min: 1e5, divisor: 1e3, digits: 1, suffix: 'K' },
  { min: 1e6, divisor: 1e6, digits: 2, suffix: 'M' },
  { min: 1e9, divisor: 1e9, digits: 2, suffix: 'B' },
  { min: 1e12, divisor: 1e12, digits: 2, suffix: 'T' },
]

/** 低于这个值直接给千分位原数（最长 6 个字符「99,999」，与压缩后的宽度相当） */
const PLAIN_LIMIT = 1e5

/** 是否是可展示的计数：有限、非负的数字 */
function isValidCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * 计数的紧凑写法，输出长度有上限（最长如「999.99 M」「1.80e+308」），可放进定宽列不撑破。
 *
 * - 0 ~ 99,999：千分位原数
 * - 10 万 ~ 1000 T 以下：K / M / B / T
 * - 更大（1e15 起，token 计数实际不会到）：科学计数法
 * - NaN / ±Infinity / 负数 / 非数字：「—」
 *
 * 精确值请配合 {@link formatExactCount} 放进 title。
 */
export function formatCompactCount(value: unknown): string {
  if (!isValidCount(value)) return EMPTY_VALUE
  const rounded = Math.round(value)
  if (rounded < PLAIN_LIMIT) return rounded.toLocaleString('zh-CN')

  let index = 0
  while (index + 1 < COMPACT_TIERS.length && rounded >= COMPACT_TIERS[index + 1]!.min) index++
  for (; index < COMPACT_TIERS.length; index++) {
    const tier = COMPACT_TIERS[index]!
    const fixed = (rounded / tier.divisor).toFixed(tier.digits)
    if (Number(fixed) < 1000) return `${fixed} ${tier.suffix}`
  }
  return rounded.toExponential(2)
}

/** 计数的完整精确值（千分位），用于 title 悬停提示；无效值给「—」。 */
export function formatExactCount(value: unknown): string {
  if (!isValidCount(value)) return EMPTY_VALUE
  return Math.round(value).toLocaleString('zh-CN')
}

/** 把无效字段当 0 参与求和，避免一个坏值把整行算成 NaN */
function countOrZero(value: unknown): number {
  return isValidCount(value) ? value : 0
}

/**
 * 缓存命中率 = 缓存读取 ÷（输入 + 缓存读取 + 缓存写入）。
 *
 * 分母用完整提示词长度而不是「输入 + 缓存读取」：写入缓存的那部分同样是本次请求发出去的输入，
 * 漏掉它会把首轮建缓存时的命中率算高。三段互不重叠（Pi 已归一），不会重复计数。
 *
 * 分母为 0（没有任何输入记录）返回 null，由调用方显示「—」。
 */
export function cacheHitRatio(
  totals: Pick<UsageTotals, 'inputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'>,
): number | null {
  const cacheRead = countOrZero(totals.cacheReadTokens)
  const promptTokens = countOrZero(totals.inputTokens) + cacheRead + countOrZero(totals.cacheCreationTokens)
  if (promptTokens <= 0 || !Number.isFinite(promptTokens)) return null
  return Math.min(1, cacheRead / promptTokens)
}

/**
 * 比例的百分数写法，保留 1 位小数。
 *
 * 两端特殊处理，免得四舍五入说谎：略大于 0 显示「<0.1%」而不是「0.0%」，
 * 略小于 1 显示「>99.9%」而不是「100.0%」；恰好 0 / 1 给「0%」「100%」。
 */
export function formatRatio(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio) || ratio < 0) return EMPTY_VALUE
  if (ratio === 0) return '0%'
  if (ratio >= 1) return '100%'
  const percent = (ratio * 100).toFixed(1)
  if (percent === '0.0') return '<0.1%'
  if (percent === '100.0') return '>99.9%'
  return `${percent}%`
}

/** 缓存命中率的口径说明，悬停可见 */
export const CACHE_HIT_RATIO_HINT = '缓存命中率 = 缓存读取 ÷（输入 + 缓存读取 + 缓存写入）'

export type UsageTokenKey = 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'

/** 四类 token 的展示名（总览构成条与行内明细共用，避免两处各写一份） */
export const USAGE_TOKEN_LABELS: Readonly<Record<UsageTokenKey, string>> = {
  inputTokens: '输入',
  outputTokens: '输出',
  cacheReadTokens: '缓存读取',
  cacheCreationTokens: '缓存写入',
}

/** 行内明细的展示顺序 */
const BREAKDOWN_TOKEN_KEYS: readonly UsageTokenKey[] = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens']

export interface UsageBreakdownItem {
  key: UsageTokenKey | 'cacheHitRatio'
  label: string
  /** 行内显示的短值（紧凑计数 / 百分比；无法计算为「—」） */
  compact: string
  /** 完整值：计数给千分位原数，命中率与 compact 相同 */
  exact: string
  /** 悬停提示 */
  title: string
}

/**
 * 按日期 / 模型 / 渠道 / 会话各行下方的明细：输入、输出、缓存读取、缓存写入、缓存命中率。
 * 调用次数不在这里（行右侧单独一列）。坏值沿用各格式化函数的兜底，显示「—」。
 */
export function buildUsageBreakdownItems(
  totals: Pick<UsageTotals, UsageTokenKey>,
): UsageBreakdownItem[] {
  const tokenItems = BREAKDOWN_TOKEN_KEYS.map((key): UsageBreakdownItem => {
    const label = USAGE_TOKEN_LABELS[key]
    const exact = formatExactCount(totals[key])
    return { key, label, compact: formatCompactCount(totals[key]), exact, title: `${label} ${exact} token` }
  })
  const ratio = formatRatio(cacheHitRatio(totals))
  return [
    ...tokenItems,
    { key: 'cacheHitRatio', label: '缓存命中率', compact: ratio, exact: ratio, title: CACHE_HIT_RATIO_HINT },
  ]
}
