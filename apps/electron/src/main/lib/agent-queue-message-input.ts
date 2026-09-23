/**
 * 排队消息 IPC 入参校验（纯逻辑，可测）。
 *
 * `agent:queue-message` 的 handler 此前直接把 input 透传给编排层，缺 `userMessage` 时在
 * 深处炸出 `Cannot read properties of undefined (reading 'matchAll')`（踩过）。
 * 渲染层正常路径不会传畸形入参，但 handler 是进程边界，必须给出明确错误而不是 TypeError。
 */

import type { AgentQueueMessageInput } from '@canopy/shared'

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`[Agent 队列] ${field} 必须是字符串数组`)
  }
  return value as string[]
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`[Agent 队列] ${field} 必须是字符串`)
  return value
}

/** 校验并规范化排队消息入参；非法时抛带字段名的中文错误 */
export function validateAgentQueueMessageInput(input: unknown): AgentQueueMessageInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('[Agent 队列] 入参必须是对象')
  }
  const raw = input as Record<string, unknown>
  if (typeof raw.sessionId !== 'string' || raw.sessionId.trim().length === 0) {
    throw new Error('[Agent 队列] 缺少 sessionId')
  }
  if (typeof raw.userMessage !== 'string') {
    throw new Error('[Agent 队列] 缺少 userMessage（应为字符串）')
  }
  if (raw.interrupt !== undefined && typeof raw.interrupt !== 'boolean') {
    throw new Error('[Agent 队列] interrupt 必须是布尔值')
  }
  return {
    sessionId: raw.sessionId,
    userMessage: raw.userMessage,
    rawUserMessage: optionalString(raw.rawUserMessage, 'rawUserMessage'),
    uuid: optionalString(raw.uuid, 'uuid'),
    interrupt: raw.interrupt as boolean | undefined,
    mentionedSkills: optionalStringArray(raw.mentionedSkills, 'mentionedSkills'),
    mentionedMcpServers: optionalStringArray(raw.mentionedMcpServers, 'mentionedMcpServers'),
    mentionedSessionIds: optionalStringArray(raw.mentionedSessionIds, 'mentionedSessionIds'),
    mentionedTodoIds: optionalStringArray(raw.mentionedTodoIds, 'mentionedTodoIds'),
    mentionedCalendarEventIds: optionalStringArray(raw.mentionedCalendarEventIds, 'mentionedCalendarEventIds'),
  }
}
