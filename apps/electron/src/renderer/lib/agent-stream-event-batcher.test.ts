import { describe, expect, test } from 'bun:test'
import type { AgentStreamEvent } from '@canopy/shared'
import { createAgentStreamEventBatcher } from './agent-stream-event-batcher'

function deltaEvent(sessionId: string, uuid: string, text: string): AgentStreamEvent {
  return {
    sessionId,
    payload: {
      kind: 'sdk_delta',
      delta: {
        uuid,
        runStartedAt: 1,
        deltas: [{ type: 'text_delta', contentIndex: 0, delta: text }],
      },
    },
  }
}

/** rAF 与兜底定时器都由测试手动触发，模拟前台/后台两种调度环境 */
function createHarness(fallbackDelayMs?: number) {
  const frames: FrameRequestCallback[] = []
  const timers = new Map<number, () => void>()
  const cancelledFrames: number[] = []
  let nextTimerId = 1
  const dispatched: AgentStreamEvent[] = []
  const batcher = createAgentStreamEventBatcher({
    dispatch: (event) => dispatched.push(event),
    requestFrame: (callback) => frames.push(callback),
    cancelFrame: (handle) => cancelledFrames.push(handle),
    scheduleFallback: (callback) => {
      const id = nextTimerId++
      timers.set(id, callback)
      return id
    },
    cancelFallback: (handle) => timers.delete(handle),
    fallbackDelayMs,
  })
  const runNextFrame = (): void => {
    const callback = frames.shift()
    if (callback) callback(performance.now())
  }
  const fireFallback = (): void => {
    const [id, callback] = [...timers.entries()][0] ?? []
    if (id === undefined || !callback) return
    timers.delete(id)
    callback()
  }
  return { batcher, dispatched, timers, frames, cancelledFrames, runNextFrame, fireFallback }
}

describe('Agent 流式事件批处理器的后台兜底交付', () => {
  test('Given rAF 被后台节流从不回调 When push 增量 Then 兜底定时器到点交付', () => {
    const h = createHarness()
    h.batcher.push(deltaEvent('s1', 'u1', 'Hello'))
    // rAF 挂起（不触发）——修复前增量会一直积压到窗口恢复
    expect(h.dispatched).toHaveLength(0)
    expect(h.timers.size).toBe(1)
    h.fireFallback()
    expect(h.dispatched).toHaveLength(1)
    expect(h.dispatched[0]?.payload.kind).toBe('sdk_delta')
  })

  test('Given rAF 正常回调完成交付 Then 兜底定时器被取消不会二次交付', () => {
    const h = createHarness()
    h.batcher.push(deltaEvent('s1', 'u1', 'Hello'))
    h.runNextFrame()
    expect(h.dispatched).toHaveLength(1)
    expect(h.timers.size).toBe(0)
    // 即使此后误触发兜底也没有可交付内容
    h.fireFallback()
    expect(h.dispatched).toHaveLength(1)
  })

  test('Given 兜底先交付 When 窗口恢复后 rAF 回调补跑 Then 不重复交付', () => {
    const h = createHarness()
    h.batcher.push(deltaEvent('s1', 'u1', 'Hello'))
    h.fireFallback()
    expect(h.dispatched).toHaveLength(1)
    h.runNextFrame()
    expect(h.dispatched).toHaveLength(1)
  })

  test('Given 同一帧窗口内连续 push 多个增量 Then 只调度一个兜底定时器且增量合并交付', () => {
    const h = createHarness()
    h.batcher.push(deltaEvent('s1', 'u1', 'Hel'))
    h.batcher.push(deltaEvent('s1', 'u1', 'lo'))
    expect(h.timers.size).toBe(1)
    h.fireFallback()
    expect(h.dispatched).toHaveLength(1)
    const payload = h.dispatched[0]?.payload
    if (payload?.kind !== 'sdk_delta') throw new Error('应为 sdk_delta')
    expect(payload.delta.deltas).toHaveLength(2)
  })

  test('Given 批处理器销毁 Then rAF 与兜底定时器都被取消', () => {
    const h = createHarness()
    h.batcher.push(deltaEvent('s1', 'u1', 'Hello'))
    h.batcher.dispose()
    expect(h.timers.size).toBe(0)
    expect(h.cancelledFrames).toHaveLength(1)
    h.fireFallback()
    expect(h.dispatched).toHaveLength(0)
  })

  test('守护既有行为：非增量事件立即交付且先冲刷同会话积压', () => {
    const h = createHarness()
    h.batcher.push(deltaEvent('s1', 'u1', 'Hello'))
    const statusEvent: AgentStreamEvent = {
      sessionId: 's1',
      payload: { kind: 'app_event', event: { type: 'agent_run_started' } as never },
    }
    h.batcher.push(statusEvent)
    // 顺序：先积压的增量、后状态事件
    expect(h.dispatched).toHaveLength(2)
    expect(h.dispatched[0]?.payload.kind).toBe('sdk_delta')
    expect(h.dispatched[1]?.payload.kind).toBe('app_event')
  })
})
