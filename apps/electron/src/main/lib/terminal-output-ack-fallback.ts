import type { TerminalOutputAck } from '@canopy/shared'

/**
 * 终端输出流控的主进程兜底。
 *
 * utility 进程的 PTY 输出走「一块 in-flight，收到 ACK 才发下一块」的限速流控，而产品里
 * 唯一的 ACK 发起方是渲染层已挂载的终端标签（TerminalTabContent）。终端标签没挂载时
 * （用户在看别的会话、右侧面板停在文件/预览页、Agent 开了第二个终端把第一个顶成非活动标签），
 * 泵会永远卡在第一块：主进程回放缓冲收不到后续输出，Agent 的 TerminalRead 只读得到命令回显，
 * utility 侧的 exit 事件也因为要等最后一块 ACK 而发不出来。
 *
 * 做法：每收到一块输出就为它计时；渲染层在时限内 ACK 则一切照旧（背压仍由真实绘制速度决定），
 * 超时没人 ACK 就由主进程代发。时限按「渲染层最近是否 ACK 过」分两档——近期 ACK 过说明有人在
 * 消费，给足绘制时间；从没 ACK 或很久没 ACK 说明无人消费，用短节拍持续推进，回放缓冲才跟得上。
 * 重复 ACK 对 utility 无害（它只认当前 in-flight 序号）。
 */

/** 渲染层最近一次 ACK 之后，多长时间内仍视为「有人在消费」。 */
export const RENDERER_ATTACHED_GRACE_MS = 2_000
/** 视为有人消费时，留给渲染层绘制并 ACK 的时间；超过就由主进程代为 ACK。 */
export const ATTACHED_ACK_TIMEOUT_MS = 1_000
/** 无人消费时的推进节拍：只为让 utility 进程继续发下一块，不必等谁绘制。 */
export const DETACHED_ACK_TIMEOUT_MS = 50

export interface TerminalOutputAckFallbackOptions {
  /** 代发 ACK 的出口：把 ACK 送回 utility 进程。 */
  acknowledge: (input: TerminalOutputAck) => void
  attachedGraceMs?: number
  attachedTimeoutMs?: number
  detachedTimeoutMs?: number
  /** 以下三项仅为测试注入时钟与定时器。 */
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
}

interface TerminalAckTracking {
  lastRendererAckAt: number | undefined
  pending: { sequence: number; timer: unknown } | undefined
}

export class TerminalOutputAckFallback {
  private readonly trackings = new Map<string, TerminalAckTracking>()
  private readonly acknowledge: (input: TerminalOutputAck) => void
  private readonly attachedGraceMs: number
  private readonly attachedTimeoutMs: number
  private readonly detachedTimeoutMs: number
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(options: TerminalOutputAckFallbackOptions) {
    this.acknowledge = options.acknowledge
    this.attachedGraceMs = options.attachedGraceMs ?? RENDERER_ATTACHED_GRACE_MS
    this.attachedTimeoutMs = options.attachedTimeoutMs ?? ATTACHED_ACK_TIMEOUT_MS
    this.detachedTimeoutMs = options.detachedTimeoutMs ?? DETACHED_ACK_TIMEOUT_MS
    this.now = options.now ?? (() => Date.now())
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  /** utility 送来一块输出：等渲染层 ACK，超时就代它 ACK。 */
  trackOutput(terminalId: string, sequence: number): void {
    const tracking = this.ensureTracking(terminalId)
    this.cancelPending(tracking)
    const delayMs = this.isAttached(tracking) ? this.attachedTimeoutMs : this.detachedTimeoutMs
    const timer = this.setTimer(() => {
      if (tracking.pending?.sequence !== sequence) return
      tracking.pending = undefined
      this.acknowledge({ terminalId, sequence })
    }, delayMs)
    tracking.pending = { sequence, timer }
  }

  /** 渲染层的 ACK 到了：撤销该序号的兜底，并记下「有人在消费」。 */
  observeRendererAck(terminalId: string, sequence: number): void {
    const tracking = this.ensureTracking(terminalId)
    tracking.lastRendererAckAt = this.now()
    if (tracking.pending && tracking.pending.sequence <= sequence) this.cancelPending(tracking)
  }

  /** 终端退出或被关闭：不再需要兜底。 */
  forget(terminalId: string): void {
    const tracking = this.trackings.get(terminalId)
    if (!tracking) return
    this.cancelPending(tracking)
    this.trackings.delete(terminalId)
  }

  clear(): void {
    for (const terminalId of [...this.trackings.keys()]) this.forget(terminalId)
  }

  /** 当前是否判定为有渲染层在消费该终端的输出。 */
  isRendererAttached(terminalId: string): boolean {
    const tracking = this.trackings.get(terminalId)
    return tracking ? this.isAttached(tracking) : false
  }

  /** 是否还有一块输出在等渲染层 ACK（超时前）。 */
  hasPendingFallback(terminalId: string): boolean {
    return this.trackings.get(terminalId)?.pending !== undefined
  }

  private isAttached(tracking: TerminalAckTracking): boolean {
    return tracking.lastRendererAckAt !== undefined && this.now() - tracking.lastRendererAckAt < this.attachedGraceMs
  }

  private ensureTracking(terminalId: string): TerminalAckTracking {
    let tracking = this.trackings.get(terminalId)
    if (!tracking) {
      tracking = { lastRendererAckAt: undefined, pending: undefined }
      this.trackings.set(terminalId, tracking)
    }
    return tracking
  }

  private cancelPending(tracking: TerminalAckTracking): void {
    if (!tracking.pending) return
    this.clearTimer(tracking.pending.timer)
    tracking.pending = undefined
  }
}
