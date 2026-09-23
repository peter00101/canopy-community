import { describe, expect, it } from 'bun:test'
import type { SDKMessage } from '@canopy/shared'
import { buildToolResultIndex } from './tool-result-index'

function userWithToolResult(toolUseId: string, content: unknown, isError?: boolean): SDKMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
  } as unknown as SDKMessage
}

function taskNotification(toolUseId: string, usage?: { duration_ms?: number; total_tokens?: number; tool_uses?: number }): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_notification',
    tool_use_id: toolUseId,
    usage,
  } as unknown as SDKMessage
}

describe('buildToolResultIndex', () => {
  it('Given 字符串内容的 tool_result，When 建索引，Then 能按 tool_use_id 取到结果文本与错误标记', () => {
    const index = buildToolResultIndex([
      { type: 'assistant', message: { content: [] } } as unknown as SDKMessage,
      userWithToolResult('tool-1', '命令输出', false),
      userWithToolResult('tool-2', '失败原因', true),
    ])

    expect(index.results.get('tool-1')).toEqual({ result: '命令输出', isError: false })
    expect(index.results.get('tool-2')).toEqual({ result: '失败原因', isError: true })
    expect(index.results.get('tool-999')).toBeUndefined()
  })

  it('Given 数组内容的 tool_result，When 建索引，Then 拼接全部 text 片段并忽略非文本块', () => {
    const index = buildToolResultIndex([
      userWithToolResult('tool-1', [
        { type: 'text', text: '第一段' },
        { type: 'image', source: {} },
        { type: 'text', text: '第二段' },
      ]),
    ])

    expect(index.results.get('tool-1')?.result).toBe('第一段\n第二段')
  })

  it('Given 同一 tool_use_id 出现多次，When 建索引，Then 首个匹配生效（与旧线性扫描语义一致）', () => {
    const index = buildToolResultIndex([
      userWithToolResult('tool-1', '第一次结果'),
      userWithToolResult('tool-1', '重复写入的结果'),
    ])

    expect(index.results.get('tool-1')?.result).toBe('第一次结果')
  })

  it('Given 带 usage 的 task_notification，When 建索引，Then 提取子代理用量并对缺省字段回落 0', () => {
    const index = buildToolResultIndex([
      taskNotification('tool-1', { duration_ms: 1200, total_tokens: 3400, tool_uses: 5 }),
      taskNotification('tool-2', { total_tokens: 100 }),
    ])

    expect(index.subAgentMeta.get('tool-1')).toEqual({ durationMs: 1200, totalTokens: 3400, toolUses: 5 })
    expect(index.subAgentMeta.get('tool-2')).toEqual({ durationMs: 0, totalTokens: 100, toolUses: 0 })
  })

  it('Given 无 usage 的 task_notification 先于有 usage 的同 id 通知，When 建索引，Then 首个匹配生效记为 null', () => {
    const index = buildToolResultIndex([
      taskNotification('tool-1'),
      taskNotification('tool-1', { total_tokens: 100 }),
    ])

    expect(index.subAgentMeta.get('tool-1')).toBeNull()
  })

  it('Given 非 tool_result 的 user 消息与非 task_notification 的 system 消息，When 建索引，Then 不产生任何条目', () => {
    const index = buildToolResultIndex([
      { type: 'user', message: { content: '纯文本用户消息' } } as unknown as SDKMessage,
      { type: 'user', message: { content: [{ type: 'text', text: '普通文本块' }] } } as unknown as SDKMessage,
      { type: 'system', subtype: 'compact_boundary' } as unknown as SDKMessage,
    ])

    expect(index.results.size).toBe(0)
    expect(index.subAgentMeta.size).toBe(0)
  })
})
