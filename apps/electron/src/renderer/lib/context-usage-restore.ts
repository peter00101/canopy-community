/**
 * 历史会话上下文用量回填
 *
 * 上下文占用原本只来自本次运行的流式事件（usage_update / result），打开一个历史会话时
 * 为空——上下文圆环徽标（连同其中的自动压缩阈值滑块）因此完全不渲染，用户在开跑前
 * 没有任何入口。这里从已加载的会话消息里回推最近一次真实用量作为兜底。
 *
 * 口径与 useGlobalAgentListeners 的 usage_update 保持一致：
 * - 只认主会话的 assistant 消息（`parent_tool_use_id` 非空的子代理用量不计入主上下文）
 * - inputTokens = input_tokens + cache_read + cache_creation
 * - 模型 ID 优先取 `_channelModelId`（渠道原始 ID，带 [1m] 等规格后缀），其次 `message.model`
 */

import type { SDKAssistantMessage, SDKMessage } from '@canopy/shared'

export interface RestoredContextUsage {
  /** 含缓存读写在内的上下文占用 */
  inputTokens: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  /** 产生该用量的模型 ID，调用方据此推断上下文窗口 */
  modelId?: string
}

/**
 * 从会话消息尾部回推最近一次有效用量；没有任何可用用量时返回 null。
 *
 * 从尾部向前扫描，命中首条即返回——正常会话最后一条就是 assistant，成本接近 O(1)。
 */
export function deriveContextUsageFromMessages(
  messages: readonly SDKMessage[] | undefined,
): RestoredContextUsage | null {
  if (!messages || messages.length === 0) return null

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message || message.type !== 'assistant') continue
    // 子代理（Task/协作）的用量属于它自己的上下文，不能算进主会话
    if (message.parent_tool_use_id) continue

    // SDKMessage 联合里有 `{ type: string; [key: string]: unknown }` 兜底分支，
    // 按 type 判别无法收窄到 assistant，这里在已确认 type 后显式转换。
    const assistantMessage = message as SDKAssistantMessage
    const usage = assistantMessage.message?.usage
    if (!usage) continue

    const cacheReadTokens = usage.cache_read_input_tokens
    const cacheCreationTokens = usage.cache_creation_input_tokens
    const inputTokens = usage.input_tokens + (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0)
    // 全零用量（如出错中断的空轮次）视为无效，继续向前找
    if (!Number.isFinite(inputTokens) || inputTokens <= 0) continue

    return {
      inputTokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens,
      cacheCreationTokens,
      modelId: assistantMessage._channelModelId ?? assistantMessage.message?.model,
    }
  }

  return null
}
