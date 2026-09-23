/**
 * 单个 PTY 的输出泵：把 node-pty 的碎输出攒成块，按「一块 in-flight、收到 ACK 才发下一块」
 * 的限速流控送往主进程。从 terminal-runtime.ts 抽出来是为了能单测——那个文件是 utility
 * 进程入口，一加载就要 parentPort。
 *
 * 合并规则（0.18.64 起）：第一字节到达后起 flushDelayMs 的合并窗口，到期才发；窗口到期时
 * 若上一块还没被 ACK，只记下「已到期」，ACK 一到立刻发出累计内容。ACK 本身不再直接触发
 * 发送——旧实现「收到 ACK 立即 flush」在渲染层 ACK 极快时会把块切到不足 2KB
 * （57MB 洪水切成 3.4 万块），主进程每块都要重做一次 1M 字符的回放缓冲维护。
 * 现在块与块之间至少隔一个合并窗口，块数上限 = 每秒 1000 / flushDelayMs。
 */

export interface TerminalOutputPumpOptions {
  /** 待发缓冲上限；超出部分丢弃并计数，下一块尾部带丢弃标记。 */
  maxPendingChars: number
  /** 合并窗口：既是首字节到发出的最大延迟，也是块与块之间的最小间隔。 */
  flushDelayMs: number
  /** 丢弃标记文案（品牌名由调用方注入，本模块不依赖 brand 包）。 */
  formatLossMarker: (droppedChars: number) => string
  /** 发出一块；sequence 单终端单调递增。 */
  send: (event: { sequence: number; data: string }) => void
  /** 仅测试注入。 */
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export class TerminalOutputPump {
  private output = ''
  private droppedOutputChars = 0
  private nextSequence = 1
  private inFlightSequence: number | undefined
  private flushTimer: unknown
  /** 合并窗口在块在飞期间已到期：ACK 一到立刻发，不再等第二个窗口。 */
  private flushDue = false
  private disposed = false
  private readonly options: Required<TerminalOutputPumpOptions>

  constructor(options: TerminalOutputPumpOptions) {
    this.options = {
      ...options,
      setTimer: options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
      clearTimer: options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
    }
  }

  /** PTY 吐出一段数据：进待发缓冲（超上限即丢弃计数），并保证合并窗口在计时。 */
  enqueue(data: string): void {
    if (this.disposed) return
    const remaining = this.options.maxPendingChars - this.output.length
    if (remaining <= 0) {
      this.droppedOutputChars += data.length
    } else {
      if (data.length > remaining) this.droppedOutputChars += data.length - remaining
      this.output += data.length > remaining ? data.slice(0, remaining) : data
    }
    if (!this.flushTimer && !this.flushDue) {
      this.flushTimer = this.options.setTimer(() => {
        this.flushTimer = undefined
        this.flushNow()
      }, this.options.flushDelayMs)
    }
  }

  /**
   * 立即尝试发一块：没有待发内容则什么都不做；上一块还在飞则只记下「已到期」，
   * 由随后的 ACK 触发发送。退出与销毁路径直接调用它。
   */
  flushNow(): void {
    if (this.disposed) return
    if (this.flushTimer) {
      this.options.clearTimer(this.flushTimer)
      this.flushTimer = undefined
    }
    if (!this.hasPending()) {
      this.flushDue = false
      return
    }
    if (this.inFlightSequence !== undefined) {
      this.flushDue = true
      return
    }
    this.flushDue = false
    const lossMarker = this.droppedOutputChars > 0 ? this.options.formatLossMarker(this.droppedOutputChars) : ''
    const data = this.output + lossMarker
    this.output = ''
    this.droppedOutputChars = 0
    const sequence = this.nextSequence
    this.nextSequence += 1
    this.inFlightSequence = sequence
    this.options.send({ sequence, data })
  }

  /** 收到某块的 ACK：序号不是当前在飞的块则忽略（返回 false）。 */
  acknowledge(sequence: number): boolean {
    if (this.inFlightSequence === undefined || this.inFlightSequence !== sequence) return false
    this.inFlightSequence = undefined
    if (this.flushDue) this.flushNow()
    return true
  }

  hasPending(): boolean {
    return this.output.length > 0 || this.droppedOutputChars > 0
  }

  /** 没有在飞的块、也没有待发内容——退出事件可以发了。 */
  isDrained(): boolean {
    return this.inFlightSequence === undefined && !this.hasPending()
  }

  dispose(): void {
    this.disposed = true
    if (this.flushTimer) {
      this.options.clearTimer(this.flushTimer)
      this.flushTimer = undefined
    }
  }
}
