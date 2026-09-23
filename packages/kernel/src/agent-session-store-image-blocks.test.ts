import { describe, expect, test } from 'bun:test'
import { serializeSDKMessageForStorage } from './agent-session-store'

type StoredMessage = Parameters<typeof serializeSDKMessageForStorage>[0]

function toolResultMessage(imageBlock: Record<string, unknown>): StoredMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'text', text: '已生成 poster.psd' }, imageBlock] }],
    },
  } as unknown as StoredMessage
}

describe('落盘序列化：超大工具结果里的图片块（0.19.13）', () => {
  const data = 'A'.repeat(300 * 1024)

  test('Given Pi / 内置工具形态的 image 块（data + mimeType）让整条消息超限 When 序列化 Then base64 被剥掉、留下类型与原长', () => {
    const serialized = serializeSDKMessageForStorage(toolResultMessage({ type: 'image', data, mimeType: 'image/png' }))
    expect(serialized.length).toBeLessThan(10_000)
    const parsed = JSON.parse(serialized) as { message: { content: Array<{ content: Array<Record<string, unknown>> }> } }
    expect(parsed.message.content[0]!.content[1]).toEqual({ type: 'image', _truncated: true, _originalLength: data.length, mimeType: 'image/png' })
    expect(parsed.message.content[0]!.content[0]).toEqual({ type: 'text', text: '已生成 poster.psd' })
  })

  test('Given Anthropic 形态的 image 块（source.data） When 序列化 Then 同样剥离', () => {
    const serialized = serializeSDKMessageForStorage(toolResultMessage({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }))
    const parsed = JSON.parse(serialized) as { message: { content: Array<{ content: Array<Record<string, unknown>> }> } }
    expect(parsed.message.content[0]!.content[1]).toEqual({ type: 'image', _truncated: true, _originalLength: data.length })
  })

  test('Given 图片块不大、整条消息未超限 When 序列化 Then 原样保留', () => {
    const small = toolResultMessage({ type: 'image', data: 'AAAA', mimeType: 'image/png' })
    expect(JSON.parse(serializeSDKMessageForStorage(small))).toEqual(JSON.parse(JSON.stringify(small)))
  })
})
