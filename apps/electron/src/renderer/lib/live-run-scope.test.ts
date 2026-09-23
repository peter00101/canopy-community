import { describe, expect, test } from 'bun:test'
import { isLiveMessageInRun } from './live-run-scope'

function message(markers: { generation?: number; startedAt?: number }): Record<string, unknown> {
  return {
    type: 'assistant',
    ...(markers.generation != null ? { _canopyLiveRunGeneration: markers.generation } : {}),
    ...(markers.startedAt != null ? { _canopyLiveRunStartedAt: markers.startedAt } : {}),
  }
}

describe('实时消息的 run 归属（收上游 #2076）', () => {
  test('Given 新协议消息带代际 When 与当前 run 同代 Then 属于本轮', () => {
    expect(isLiveMessageInRun(message({ generation: 5, startedAt: 100 }), { runGeneration: 5, startedAt: 100 })).toBe(true)
  })

  test('Given 用户停止后立刻续跑 When 旧 run 的消息迟到 Then 按代际判为他轮、挡在外面', () => {
    expect(isLiveMessageInRun(message({ generation: 4, startedAt: 90 }), { runGeneration: 5, startedAt: 100 })).toBe(false)
  })

  test('Given 代际不同但起始时间碰巧相同 When 判定 Then 以代际为准', () => {
    expect(isLiveMessageInRun(message({ generation: 4, startedAt: 100 }), { runGeneration: 5, startedAt: 100 })).toBe(false)
  })

  test('Given 当前状态没有代际（旧协议） When 消息起始时间不同 Then 退回比起始时间判为他轮', () => {
    expect(isLiveMessageInRun(message({ generation: 4, startedAt: 90 }), { startedAt: 100 })).toBe(false)
    expect(isLiveMessageInRun(message({ startedAt: 100 }), { startedAt: 100 })).toBe(true)
  })

  test('Given 消息不带任何标记（乐观插入的用户消息 / 旧协议） When 判定 Then 一律放行，不误丢', () => {
    expect(isLiveMessageInRun(message({}), { runGeneration: 5, startedAt: 100 })).toBe(true)
  })

  test('Given 会话还没有流状态 When 判定 Then 放行', () => {
    expect(isLiveMessageInRun(message({ generation: 1, startedAt: 1 }), undefined)).toBe(true)
    expect(isLiveMessageInRun(message({ generation: 1, startedAt: 1 }), null)).toBe(true)
  })

  test('Given 非对象输入 When 判定 Then 放行而不抛错', () => {
    expect(isLiveMessageInRun(null, { runGeneration: 1 })).toBe(true)
    expect(isLiveMessageInRun('x', { runGeneration: 1 })).toBe(true)
  })
})
