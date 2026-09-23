import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SDKMessage } from '@canopy/shared'
import { markLiveRunSdkMessage } from './agent-live-run-marker'

function assistantMessage(): SDKMessage {
  return {
    type: 'assistant',
    uuid: 'msg-1',
    message: { content: [{ type: 'text', text: '好的' }] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

describe('实时消息的 run 标记（收上游 #2076）', () => {
  test('Given 一条待推送的 SDK 消息 When 打标 Then 带上起始时间与代际，原内容一字不差', () => {
    const marked = markLiveRunSdkMessage(assistantMessage(), { startedAt: 1_700_000_000_000, runGeneration: 3 }) as unknown as Record<string, unknown>
    expect(marked._canopyLiveRunStartedAt).toBe(1_700_000_000_000)
    expect(marked._canopyLiveRunGeneration).toBe(3)
    expect(marked.uuid).toBe('msg-1')
    expect(marked.message).toEqual({ content: [{ type: 'text', text: '好的' }] })
  })

  test('Given 同一个消息对象还要落盘 When 打标 Then 返回浅拷贝，原对象不带任何运行期标记', () => {
    const original = assistantMessage()
    const marked = markLiveRunSdkMessage(original, { startedAt: 1, runGeneration: 1 })
    expect(marked).not.toBe(original)
    const record = original as unknown as Record<string, unknown>
    expect('_canopyLiveRunStartedAt' in record).toBe(false)
    expect('_canopyLiveRunGeneration' in record).toBe(false)
  })

  test('Given 编排器源码 When 数实时消息的推送点 Then 只有打标那一处直接发 sdk_message', () => {
    // sendMessage 依赖 Electron / Pi SDK，没法单测真跑；按仓库调用点守卫的惯例钉源码：
    // 新增推送点若绕过 emitLiveSdkMessage 直接 emit，渲染层就分不清它属于哪一轮。
    const source = readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf-8')
    const rawEmits = [...source.matchAll(/kind:\s*'sdk_message'/g)]
    expect(rawEmits).toHaveLength(1)
    const emitHelper = source.slice(source.indexOf('const emitLiveSdkMessage = ('))
    expect(emitHelper.slice(0, 400)).toContain('markLiveRunSdkMessage(message, { startedAt: streamStartedAt, runGeneration })')
  })
})
