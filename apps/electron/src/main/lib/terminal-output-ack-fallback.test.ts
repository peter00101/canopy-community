import { describe, expect, test } from 'bun:test'
import type { TerminalOutputAck } from '@canopy/shared'
import {
  ATTACHED_ACK_TIMEOUT_MS,
  DETACHED_ACK_TIMEOUT_MS,
  RENDERER_ATTACHED_GRACE_MS,
  TerminalOutputAckFallback,
} from './terminal-output-ack-fallback'

interface FakeTimer {
  id: number
  dueAt: number
  callback: () => void
}

/** 可控时钟 + 定时器：advance 按到期顺序触发回调，回调内看到的 now 即到期时刻。 */
function createHarness() {
  let now = 0
  let nextTimerId = 1
  const timers: FakeTimer[] = []
  const acks: TerminalOutputAck[] = []
  const fallback = new TerminalOutputAckFallback({
    acknowledge: (input) => acks.push(input),
    now: () => now,
    setTimer: (callback, delayMs) => {
      const id = nextTimerId++
      timers.push({ id, dueAt: now + delayMs, callback })
      return id
    },
    clearTimer: (handle) => {
      const index = timers.findIndex((timer) => timer.id === handle)
      if (index >= 0) timers.splice(index, 1)
    },
  })
  const advance = (ms: number): void => {
    const target = now + ms
    for (;;) {
      const due = [...timers].filter((timer) => timer.dueAt <= target).sort((left, right) => left.dueAt - right.dueAt)[0]
      if (!due) break
      timers.splice(timers.indexOf(due), 1)
      now = due.dueAt
      due.callback()
    }
    now = target
  }
  return { fallback, acks, advance, timers, currentTime: () => now }
}

describe('终端输出 ACK 兜底（终端标签未挂载时流控泵卡死）', () => {
  test('Given 终端从没被渲染层 ACK 过（标签未挂载） When 收到第 1 块且短节拍内无人 ACK Then 主进程代发 ACK', () => {
    const { fallback, acks, advance } = createHarness()
    fallback.trackOutput('t1', 1)
    expect(fallback.isRendererAttached('t1')).toBe(false)
    expect(fallback.hasPendingFallback('t1')).toBe(true)

    advance(DETACHED_ACK_TIMEOUT_MS - 1)
    expect(acks).toEqual([])
    advance(1)
    expect(acks).toEqual([{ terminalId: 't1', sequence: 1 }])
    expect(fallback.hasPendingFallback('t1')).toBe(false)
  })

  test('Given 无人消费 When 连续三块各自在上一块代 ACK 后到达 Then 三块按序全部被代 ACK（回放缓冲跟得上）', () => {
    const { fallback, acks, advance } = createHarness()
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      fallback.trackOutput('t1', sequence)
      advance(DETACHED_ACK_TIMEOUT_MS)
    }
    expect(acks.map((ack) => ack.sequence)).toEqual([1, 2, 3])
  })

  test('Given 渲染层在时限内 ACK 了 When 时限到期 Then 主进程不代发（背压仍由真实绘制决定）', () => {
    const { fallback, acks, advance } = createHarness()
    fallback.trackOutput('t1', 1)
    advance(10)
    fallback.observeRendererAck('t1', 1)
    expect(fallback.hasPendingFallback('t1')).toBe(false)
    advance(ATTACHED_ACK_TIMEOUT_MS * 2)
    expect(acks).toEqual([])
  })

  test('Given 渲染层刚 ACK 过（有人在消费） When 下一块到来 Then 兜底时限放宽到绘制档，短节拍到期不代发', () => {
    const { fallback, acks, advance } = createHarness()
    fallback.trackOutput('t1', 1)
    fallback.observeRendererAck('t1', 1)
    fallback.trackOutput('t1', 2)
    expect(fallback.isRendererAttached('t1')).toBe(true)

    advance(DETACHED_ACK_TIMEOUT_MS)
    expect(acks).toEqual([])
    advance(ATTACHED_ACK_TIMEOUT_MS - DETACHED_ACK_TIMEOUT_MS - 1)
    expect(acks).toEqual([])
    advance(1)
    expect(acks).toEqual([{ terminalId: 't1', sequence: 2 }])
  })

  test('Given 渲染层最后一次 ACK 已超过宽限期（标签已卸载） When 新块到来 Then 回到短节拍', () => {
    const { fallback, acks, advance } = createHarness()
    fallback.trackOutput('t1', 1)
    fallback.observeRendererAck('t1', 1)
    advance(RENDERER_ATTACHED_GRACE_MS)
    expect(fallback.isRendererAttached('t1')).toBe(false)

    fallback.trackOutput('t1', 2)
    advance(DETACHED_ACK_TIMEOUT_MS)
    expect(acks).toEqual([{ terminalId: 't1', sequence: 2 }])
  })

  test('Given 渲染层慢但一直在 ACK（大输出场景） When 每块都在绘制档时限内 ACK Then 全程零代发、且始终判定为在消费', () => {
    const { fallback, acks, advance } = createHarness()
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      fallback.trackOutput('t1', sequence)
      advance(ATTACHED_ACK_TIMEOUT_MS - 100)
      fallback.observeRendererAck('t1', sequence)
      if (sequence > 1) expect(fallback.isRendererAttached('t1')).toBe(true)
    }
    // 第 1 块时还没有任何 ACK 记录，短节拍到期先代发一次是预期行为；其后四块全由渲染层自己 ACK。
    expect(acks).toEqual([{ terminalId: 't1', sequence: 1 }])
  })

  test('Given 渲染层 ACK 的是旧序号（快照恢复期） When 更新的块还在等 Then 不撤销该块的兜底，但记下有人在消费', () => {
    const { fallback, acks, advance } = createHarness()
    fallback.trackOutput('t1', 3)
    fallback.observeRendererAck('t1', 2)
    expect(fallback.hasPendingFallback('t1')).toBe(true)
    expect(fallback.isRendererAttached('t1')).toBe(true)

    advance(DETACHED_ACK_TIMEOUT_MS)
    expect(acks).toEqual([{ terminalId: 't1', sequence: 3 }])
  })

  test('Given 终端退出或被关闭（forget） When 原时限到期 Then 不再代发', () => {
    const { fallback, acks, advance, timers } = createHarness()
    fallback.trackOutput('t1', 1)
    fallback.forget('t1')
    expect(timers).toEqual([])
    advance(ATTACHED_ACK_TIMEOUT_MS)
    expect(acks).toEqual([])
    expect(fallback.hasPendingFallback('t1')).toBe(false)
    expect(fallback.isRendererAttached('t1')).toBe(false)
  })

  test('Given 多个终端各有一块在等 When clear Then 全部撤销、定时器清空', () => {
    const { fallback, acks, advance, timers } = createHarness()
    fallback.trackOutput('t1', 1)
    fallback.trackOutput('t2', 7)
    fallback.clear()
    expect(timers).toEqual([])
    advance(ATTACHED_ACK_TIMEOUT_MS)
    expect(acks).toEqual([])
  })

  test('Given 同一终端旧块的兜底还没到期新块就到了（防御） When 处理 Then 只为新块兜底，旧块不再代发', () => {
    const { fallback, acks, advance, timers } = createHarness()
    fallback.trackOutput('t1', 1)
    fallback.trackOutput('t1', 2)
    expect(timers).toHaveLength(1)
    advance(DETACHED_ACK_TIMEOUT_MS)
    expect(acks).toEqual([{ terminalId: 't1', sequence: 2 }])
  })

  test('Given 各终端独立计时 When t1 有人消费而 t2 无人消费 Then 两者时限互不影响', () => {
    const { fallback, acks, advance } = createHarness()
    fallback.trackOutput('t1', 1)
    fallback.observeRendererAck('t1', 1)
    fallback.trackOutput('t1', 2)
    fallback.trackOutput('t2', 1)
    advance(DETACHED_ACK_TIMEOUT_MS)
    expect(acks).toEqual([{ terminalId: 't2', sequence: 1 }])
    advance(ATTACHED_ACK_TIMEOUT_MS)
    expect(acks).toEqual([{ terminalId: 't2', sequence: 1 }, { terminalId: 't1', sequence: 2 }])
  })

  test('Given 未注入时钟与定时器 When 构造 Then 走真实 setTimeout 也能代发（默认参数可用）', async () => {
    const acks: TerminalOutputAck[] = []
    const fallback = new TerminalOutputAckFallback({ acknowledge: (input) => acks.push(input), detachedTimeoutMs: 5 })
    fallback.trackOutput('t1', 1)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(acks).toEqual([{ terminalId: 't1', sequence: 1 }])
    fallback.clear()
  })
})
