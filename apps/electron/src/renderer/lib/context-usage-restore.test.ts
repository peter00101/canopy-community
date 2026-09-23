import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@canopy/shared'
import { deriveContextUsageFromMessages } from './context-usage-restore'

interface AssistantUsageInput {
  input: number
  output?: number
  cacheRead?: number
  cacheCreation?: number
}

function assistant(
  usage: AssistantUsageInput | null,
  options: { parentToolUseId?: string; model?: string; channelModelId?: string } = {},
): SDKMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: '回复' }],
      ...(usage
        ? {
          usage: {
            input_tokens: usage.input,
            output_tokens: usage.output,
            cache_read_input_tokens: usage.cacheRead,
            cache_creation_input_tokens: usage.cacheCreation,
          },
        }
        : {}),
      ...(options.model ? { model: options.model } : {}),
    },
    parent_tool_use_id: options.parentToolUseId ?? null,
    ...(options.channelModelId ? { _channelModelId: options.channelModelId } : {}),
  } as SDKMessage
}

function user(text: string): SDKMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  } as SDKMessage
}

describe('历史会话上下文用量回填', () => {
  test('Given 末条 assistant 带用量 When 回填 Then 按输入+缓存读写合计算占用', () => {
    const messages = [
      user('第一问'),
      assistant({ input: 726, output: 173, cacheRead: 32768, cacheCreation: 0 }, { model: 'deepseek-v4-pro' }),
    ]

    expect(deriveContextUsageFromMessages(messages)).toEqual({
      inputTokens: 33494,
      outputTokens: 173,
      cacheReadTokens: 32768,
      cacheCreationTokens: 0,
      modelId: 'deepseek-v4-pro',
    })
  })

  test('Given 尾部是用户消息与无用量回复 When 回填 Then 向前取最近一条有效用量', () => {
    const messages = [
      assistant({ input: 100, cacheRead: 900 }, { model: '旧模型' }),
      assistant({ input: 1000, cacheRead: 4000 }, { model: '新模型' }),
      assistant(null),
      user('追问'),
    ]

    expect(deriveContextUsageFromMessages(messages)?.inputTokens).toBe(5000)
    expect(deriveContextUsageFromMessages(messages)?.modelId).toBe('新模型')
  })

  test('Given 子代理消息带用量 When 回填 Then 跳过它只认主会话用量', () => {
    const messages = [
      assistant({ input: 2000, cacheRead: 0 }, { model: '主模型' }),
      assistant({ input: 999_999 }, { parentToolUseId: 'toolu_sub', model: '子代理模型' }),
    ]

    expect(deriveContextUsageFromMessages(messages)).toMatchObject({
      inputTokens: 2000,
      modelId: '主模型',
    })
  })

  test('Given 末条用量全为零 When 回填 Then 视为无效并继续向前找', () => {
    const messages = [
      assistant({ input: 1500, cacheRead: 500 }, { model: '有效轮次' }),
      assistant({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, { model: '空轮次' }),
    ]

    expect(deriveContextUsageFromMessages(messages)).toMatchObject({
      inputTokens: 2000,
      modelId: '有效轮次',
    })
  })

  test('Given 渠道模型 ID 与 message.model 不一致 When 回填 Then 取渠道原始 ID 保留规格后缀', () => {
    const messages = [
      assistant({ input: 10 }, { model: 'glm-x-preview', channelModelId: 'glm-x-preview[1m]' }),
    ]

    expect(deriveContextUsageFromMessages(messages)?.modelId).toBe('glm-x-preview[1m]')
  })

  test('Given 会话没有任何用量 When 回填 Then 返回 null 交由零用量形态处理', () => {
    expect(deriveContextUsageFromMessages([user('只有提问'), assistant(null)])).toBeNull()
    expect(deriveContextUsageFromMessages([])).toBeNull()
    expect(deriveContextUsageFromMessages(undefined)).toBeNull()
  })
})
