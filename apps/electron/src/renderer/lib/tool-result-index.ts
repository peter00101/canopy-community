/**
 * 工具结果索引 — 纯逻辑，零 React/Electron 依赖
 *
 * 背景：Agent 长会话（数千条消息、上千个工具块）里，每个工具块各自对全量消息
 * 线性扫描找 tool_result 是 O(M×N)；流式期间消息数组每条增量都是新引用，所有
 * 块的 memo 同时失效，单条增量就是数百万次迭代——这是长任务界面卡死、内存雪球
 * 直至渲染进程 OOM 的最大单点。改为每次增量只做一趟 O(N) 建索引，块内 O(1) 查找。
 *
 * 语义与旧线性扫描保持一致：同一 tool_use_id 出现多次时，首个匹配生效。
 */

import type { SDKMessage, SDKSystemMessage, SDKToolResultBlock, SDKUserMessage } from '@canopy/shared'

export interface ToolResultData {
  result?: string
  isError?: boolean
}

export interface SubAgentMeta {
  durationMs: number
  totalTokens: number
  toolUses: number
}

export interface ToolResultIndex {
  /** tool_use_id → 工具结果 */
  results: Map<string, ToolResultData>
  /** tool_use_id → 子代理用量（task_notification 无 usage 时记 null，与旧扫描"找到但无用量返回 null"一致） */
  subAgentMeta: Map<string, SubAgentMeta | null>
}

export function extractToolResultData(resultBlock: SDKToolResultBlock): ToolResultData {
  let result: string | undefined
  if (typeof resultBlock.content === 'string') {
    result = resultBlock.content
  } else if (Array.isArray(resultBlock.content)) {
    result = (resultBlock.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
  }
  return { result, isError: resultBlock.is_error }
}

export function buildToolResultIndex(allMessages: SDKMessage[]): ToolResultIndex {
  const results = new Map<string, ToolResultData>()
  const subAgentMeta = new Map<string, SubAgentMeta | null>()
  for (const msg of allMessages) {
    if (msg.type === 'user') {
      const contentBlocks = (msg as SDKUserMessage).message?.content
      if (!Array.isArray(contentBlocks)) continue
      for (const block of contentBlocks) {
        if (block.type !== 'tool_result') continue
        const resultBlock = block as SDKToolResultBlock
        if (!results.has(resultBlock.tool_use_id)) {
          results.set(resultBlock.tool_use_id, extractToolResultData(resultBlock))
        }
      }
    } else if (msg.type === 'system') {
      const sysMsg = msg as SDKSystemMessage
      if (sysMsg.subtype !== 'task_notification' || typeof sysMsg.tool_use_id !== 'string') continue
      if (subAgentMeta.has(sysMsg.tool_use_id)) continue
      const usage = sysMsg.usage
      subAgentMeta.set(sysMsg.tool_use_id, usage
        ? {
            durationMs: usage.duration_ms ?? 0,
            totalTokens: usage.total_tokens ?? 0,
            toolUses: usage.tool_uses ?? 0,
          }
        : null)
    }
  }
  return { results, subAgentMeta }
}
