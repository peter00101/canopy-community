/**
 * 提示缓存保留时长（纯逻辑）。
 *
 * Pi 的 stream 选项 `cacheRetention: 'long'` 会让 Anthropic 协议的请求带上
 * `cache_control: { type: 'ephemeral', ttl: '1h' }`（默认 5 分钟）。用户在上下文徽标弹层里选
 * 「1 小时」时，我们只对 `anthropic-messages` 这一种 API 注入该选项：
 * - OpenAI 兼容端在 Pi 里对应 `prompt_cache_retention: "24h"`，除少数已知网关外默认都会发，
 *   而我方用户的自建网关 / 国产模型对未知字段是否 400 无从逐家实测，故不放开；
 * - 选「5 分钟」或未设置时不传该字段，保持 Pi 默认（仍尊重 `PI_CACHE_RETENTION` 环境变量）。
 */

export type AgentPromptCacheRetention = 'short' | 'long'

/** 读取设置里可能被手改过的值：只认 'long'，其余一律视为默认（短） */
export function normalizeAgentPromptCacheRetention(value: unknown): AgentPromptCacheRetention {
  return value === 'long' ? 'long' : 'short'
}

/** 只有 Anthropic Messages 协议会把 `cacheRetention: 'long'` 翻译成 1 小时 TTL */
export const LONG_CACHE_RETENTION_APIS: ReadonlySet<string> = new Set(['anthropic-messages'])

export interface ResolvePiCacheRetentionInput {
  /** Pi model 的 `api` 字段，如 'anthropic-messages' / 'openai-completions' */
  api: string | undefined
  /** 用户设置（可能为 undefined 或手改的非法值） */
  preference: unknown
}

/** 返回要注入的 `cacheRetention`；undefined = 不注入、走 Pi 默认 */
export function resolvePiCacheRetention(input: ResolvePiCacheRetentionInput): 'long' | undefined {
  if (normalizeAgentPromptCacheRetention(input.preference) !== 'long') return undefined
  if (!input.api || !LONG_CACHE_RETENTION_APIS.has(input.api)) return undefined
  return 'long'
}

/**
 * 把解析结果并进 stream 选项。调用方已显式传了 `cacheRetention` 时不覆盖（Pi 内部的压缩 /
 * 摘要请求会自己传 'none'，不能被用户偏好改掉）。
 */
export function applyPiCacheRetention<T extends object | undefined>(
  options: T,
  retention: 'long' | undefined,
): T {
  if (!retention) return options
  if ((options as { cacheRetention?: unknown } | undefined)?.cacheRetention) return options
  return { ...(options ?? {}), cacheRetention: retention } as T
}
