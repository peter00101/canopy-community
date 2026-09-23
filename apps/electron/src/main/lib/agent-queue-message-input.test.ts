import { describe, expect, test } from 'bun:test'
import { validateAgentQueueMessageInput } from './agent-queue-message-input'

describe('排队消息入参校验', () => {
  test('Given 完整合法入参 When 校验 Then 原样规范化返回', () => {
    const input = {
      sessionId: 's1',
      userMessage: '继续',
      rawUserMessage: '继续',
      uuid: 'u1',
      interrupt: true,
      mentionedSkills: ['canopy-coach'],
    }
    expect(validateAgentQueueMessageInput(input)).toEqual({
      sessionId: 's1',
      userMessage: '继续',
      rawUserMessage: '继续',
      uuid: 'u1',
      interrupt: true,
      mentionedSkills: ['canopy-coach'],
      mentionedMcpServers: undefined,
      mentionedSessionIds: undefined,
      mentionedTodoIds: undefined,
      mentionedCalendarEventIds: undefined,
    })
  })

  test('Given 缺 userMessage（踩过的畸形入参） When 校验 Then 抛出带字段名的明确错误而不是 TypeError', () => {
    expect(() => validateAgentQueueMessageInput({ sessionId: 's1', text: '错字段' })).toThrow('缺少 userMessage')
  })

  test('Given 缺 sessionId / 非对象 / 数组 When 校验 Then 各自抛明确错误', () => {
    expect(() => validateAgentQueueMessageInput({ userMessage: 'x' })).toThrow('缺少 sessionId')
    expect(() => validateAgentQueueMessageInput(null)).toThrow('入参必须是对象')
    expect(() => validateAgentQueueMessageInput([])).toThrow('入参必须是对象')
  })

  test('Given 可选字段类型不对 When 校验 Then 报出具体字段', () => {
    expect(() => validateAgentQueueMessageInput({ sessionId: 's', userMessage: 'x', mentionedSkills: 'not-array' })).toThrow('mentionedSkills')
    expect(() => validateAgentQueueMessageInput({ sessionId: 's', userMessage: 'x', interrupt: 'yes' })).toThrow('interrupt')
    expect(() => validateAgentQueueMessageInput({ sessionId: 's', userMessage: 'x', uuid: 42 })).toThrow('uuid')
  })

  test('Given 空字符串 userMessage When 校验 Then 放行（是否允许空消息由编排层决定）', () => {
    expect(validateAgentQueueMessageInput({ sessionId: 's', userMessage: '' }).userMessage).toBe('')
  })
})
