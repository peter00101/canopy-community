import { describe, expect, test } from 'bun:test'
import { TerminalOutputPump } from './terminal-output-pump'

interface FakeTimer {
  id: number
  dueAt: number
  callback: () => void
}

const FLUSH_DELAY_MS = 16
const MAX_PENDING_CHARS = 1_000

/** 可控时钟 + 定时器；advance 按到期顺序触发回调，回调内看到的 now 即到期时刻。 */
function createHarness(maxPendingChars = MAX_PENDING_CHARS) {
  let now = 0
  let nextTimerId = 1
  const timers: FakeTimer[] = []
  const sent: Array<{ sequence: number; data: string; at: number }> = []
  const pump = new TerminalOutputPump({
    maxPendingChars,
    flushDelayMs: FLUSH_DELAY_MS,
    formatLossMarker: (dropped) => `[已丢弃 ${dropped}]`,
    send: (event) => sent.push({ ...event, at: now }),
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
  return { pump, sent, timers, advance, currentTime: () => now }
}

describe('终端输出泵：合并窗口与一块在飞的限速流控', () => {
  test('Given 首块输出到达 When 合并窗口未到期 Then 不发；到期 Then 一次发出窗口内累计的全部内容（seq 1）', () => {
    const { pump, sent, advance } = createHarness()
    pump.enqueue('ab')
    advance(FLUSH_DELAY_MS - 1)
    pump.enqueue('cd')
    expect(sent).toEqual([])
    advance(1)
    expect(sent).toEqual([{ sequence: 1, data: 'abcd', at: FLUSH_DELAY_MS }])
  })

  test('Given 上一块在飞 When 又来输出且窗口到期 Then 不发第二块（保持一块在飞）；ACK 一到 Then 立即发出累计内容（seq 2）', () => {
    const { pump, sent, advance } = createHarness()
    pump.enqueue('first')
    advance(FLUSH_DELAY_MS)
    expect(sent).toHaveLength(1)
    pump.enqueue('second')
    advance(FLUSH_DELAY_MS * 5)
    expect(sent).toHaveLength(1)
    expect(pump.acknowledge(1)).toBe(true)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual({ sequence: 2, data: 'second', at: FLUSH_DELAY_MS * 6 })
  })

  test('Given 上一块在飞、窗口尚未到期 When ACK 到 Then 不立即发，等窗口到期再发——块与块至少隔一个窗口（修 #34 的核心）', () => {
    const { pump, sent, advance } = createHarness()
    pump.enqueue('first')
    advance(FLUSH_DELAY_MS)
    pump.enqueue('x')
    advance(1)
    expect(pump.acknowledge(1)).toBe(true)
    expect(sent).toHaveLength(1)
    pump.enqueue('y')
    advance(FLUSH_DELAY_MS - 2)
    expect(sent).toHaveLength(1)
    advance(1)
    expect(sent).toHaveLength(2)
    expect(sent[1]?.data).toBe('xy')
    expect((sent[1]?.at ?? 0) - (sent[0]?.at ?? 0)).toBe(FLUSH_DELAY_MS)
  })

  test('Given 洪水：每 1ms 来 10 字符、每块发出后 0.3ms 即 ACK When 跑 1000ms Then 块数 ≈ 每秒 1000/16，而不是每次 ACK 一块', () => {
    const { pump, sent, advance } = createHarness(1_000_000)
    for (let tick = 0; tick < 1000; tick += 1) {
      pump.enqueue('0123456789')
      advance(1)
      // 渲染层极快：上一 tick 发出的块在本 tick 前就已 ACK（重复 ACK 会被忽略）
      const last = sent[sent.length - 1]
      if (last) pump.acknowledge(last.sequence)
    }
    expect(sent.length).toBeGreaterThanOrEqual(55)
    expect(sent.length).toBeLessThanOrEqual(65)
    expect(sent.reduce((total, event) => total + event.data.length, 0)).toBeLessThanOrEqual(10_000)
    const gaps = sent.slice(1).map((event, index) => event.at - (sent[index]?.at ?? 0))
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(FLUSH_DELAY_MS)
  })

  test('Given 待发累计超过上限 When 继续来数据 Then 超出部分计入丢弃，下一块尾部带丢弃标记，之后计数归零', () => {
    const { pump, sent, advance } = createHarness(8)
    pump.enqueue('123456')
    advance(FLUSH_DELAY_MS)
    expect(sent[0]?.data).toBe('123456')
    pump.enqueue('abcdefghij')
    pump.enqueue('KLM')
    expect(pump.acknowledge(1)).toBe(true)
    advance(FLUSH_DELAY_MS)
    expect(sent[1]?.data).toBe('abcdefgh[已丢弃 5]')
    expect(pump.acknowledge(2)).toBe(true)
    pump.enqueue('z')
    advance(FLUSH_DELAY_MS)
    expect(sent[2]?.data).toBe('z')
  })

  test('Given 没有在飞的块或序号不匹配 When ACK Then 返回 false、不发任何块', () => {
    const { pump, sent, advance } = createHarness()
    expect(pump.acknowledge(1)).toBe(false)
    pump.enqueue('a')
    advance(FLUSH_DELAY_MS)
    expect(pump.acknowledge(99)).toBe(false)
    expect(pump.acknowledge(1)).toBe(true)
    expect(pump.acknowledge(1)).toBe(false)
    expect(sent).toHaveLength(1)
  })

  test('Given 进程退出时块在飞且有残留 When flushNow Then 只记下到期、未排空；ACK 后残留立即发出；再 ACK 后排空', () => {
    const { pump, sent, advance } = createHarness()
    pump.enqueue('running')
    advance(FLUSH_DELAY_MS)
    pump.enqueue('tail')
    pump.flushNow()
    expect(sent).toHaveLength(1)
    expect(pump.isDrained()).toBe(false)
    expect(pump.acknowledge(1)).toBe(true)
    expect(sent).toHaveLength(2)
    expect(sent[1]?.data).toBe('tail')
    expect(pump.isDrained()).toBe(false)
    expect(pump.acknowledge(2)).toBe(true)
    expect(pump.isDrained()).toBe(true)
  })

  test('Given 没有待发内容 When flushNow / ACK Then 不发块且 isDrained 为真', () => {
    const { pump, sent } = createHarness()
    pump.flushNow()
    expect(sent).toEqual([])
    expect(pump.isDrained()).toBe(true)
  })

  test('Given 空字符串 enqueue When 窗口到期 Then 不发空块', () => {
    const { pump, sent, advance } = createHarness()
    pump.enqueue('')
    advance(FLUSH_DELAY_MS)
    expect(sent).toEqual([])
    expect(pump.hasPending()).toBe(false)
  })

  test('Given 已 dispose When 定时器到期 / 再 enqueue / flushNow Then 不再发块、定时器清空', () => {
    const { pump, sent, advance, timers } = createHarness()
    pump.enqueue('a')
    pump.dispose()
    expect(timers).toEqual([])
    pump.enqueue('b')
    pump.flushNow()
    advance(FLUSH_DELAY_MS * 2)
    expect(sent).toEqual([])
  })

  test('Given 三块依次 ACK When 发送 Then 序号 1、2、3 单调递增且每块只含各自窗口内的数据', () => {
    const { pump, sent, advance } = createHarness()
    for (const data of ['one', 'two', 'three']) {
      pump.enqueue(data)
      advance(FLUSH_DELAY_MS)
      pump.acknowledge(sent[sent.length - 1]?.sequence ?? -1)
    }
    expect(sent.map((event) => [event.sequence, event.data])).toEqual([[1, 'one'], [2, 'two'], [3, 'three']])
  })
})
