/**
 * 官方已下线的模型名单（所有渠道共用）。
 *
 * 官方停止提供后，官方订阅（Codex）、官方 API、中转网关都不会再有这个模型，
 * 所以不分渠道类型一律处理：渠道配置里的存量条目读取时清掉、拉取模型时过滤、
 * Agent / Chat 仍指向它的会话发送时给出明确提示（不静默换成别的模型）。
 *
 * 以后再有模型下线，只在这里加一行。条目一律写小写。
 */
const RETIRED_MODEL_IDS: ReadonlySet<string> = new Set([
  // 2026-09 从 ChatGPT Codex 订阅与官方 API 下线（上游 #2061 同步）
  'gpt-5.3-codex-spark',
])

/**
 * 判断模型 ID 是否已官方下线。
 *
 * trim + 小写后比较；网关常见的 `openai/xxx` 这类带供应商前缀的写法取最后一段比较。
 */
export function isRetiredModelId(modelId: string | null | undefined): boolean {
  if (typeof modelId !== 'string') return false
  const normalized = modelId.trim().toLowerCase()
  if (!normalized) return false
  if (RETIRED_MODEL_IDS.has(normalized)) return true
  const lastSegment = normalized.slice(normalized.lastIndexOf('/') + 1)
  return RETIRED_MODEL_IDS.has(lastSegment)
}

/** 会话仍指向已下线模型时给用户看的提示。 */
export function formatRetiredModelMessage(modelId: string): string {
  return `模型 ${modelId.trim()} 已下线（官方停止提供），请换一个模型`
}
