import { join } from 'node:path'
import { MessageChannelMain, utilityProcess, type MessagePortMain, type UtilityProcess } from 'electron'
import { CANOPY_BRAND } from '@canopy/brand'
import { startUtilityProcessWithRetry } from '@canopy/shared'
import type {
  TerminalCreateInput,
  TerminalExitEvent,
  TerminalInput,
  TerminalOutputAck,
  TerminalOutputEvent,
  TerminalResizeInput,
  TerminalState,
} from '@canopy/shared'

type RuntimePort = Pick<MessagePortMain, 'close' | 'postMessage' | 'start'> & {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
}

type PendingCreate = {
  promise: Promise<TerminalState>
  resolve: (state: TerminalState) => void
  reject: (reason: Error) => void
}

type RuntimeTerminalCreateInput = TerminalCreateInput & {
  strictCwd?: boolean
}

type RuntimeMessage =
  | { type: 'terminal.ready'; pid: number }
  | { type: 'terminal.created'; state: TerminalState }
  | { type: 'terminal.output'; event: TerminalOutputEvent }
  | { type: 'terminal.exit'; event: TerminalExitEvent }
  | { type: 'terminal.error'; terminalId: string; message: string }

const STARTUP_TIMEOUT_MS = 10_000

/**
 * 一个 utility process 管理全部本地 PTY：与 Agent runtime 隔离，又不会为每个 Tab
 * 创建一个 Node 进程。Renderer 始终经由此 client 接收已批处理的输出。
 */
export class TerminalRuntimeClient {
  private runtimeProcess: UtilityProcess | undefined
  private port: RuntimePort | undefined
  private starting: Promise<void> | undefined
  /** 启动代际：stop 与每次新启动都 +1，用于让旧一代的回调与超时自行收束 */
  private generation = 0
  private readonly pendingCreates = new Map<string, PendingCreate>()
  private readonly outputListeners = new Set<(event: TerminalOutputEvent) => void>()
  private readonly exitListeners = new Set<(event: TerminalExitEvent) => void>()

  onOutput(listener: (event: TerminalOutputEvent) => void): () => void {
    this.outputListeners.add(listener)
    return () => this.outputListeners.delete(listener)
  }

  onExit(listener: (event: TerminalExitEvent) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  async create(input: TerminalCreateInput, options: { strictCwd?: boolean } = {}): Promise<TerminalState> {
    await this.start()
    const pending = this.pendingCreates.get(input.terminalId)
    if (pending) return pending.promise

    let resolveCreate!: (state: TerminalState) => void
    let rejectCreate!: (reason: Error) => void
    const promise = new Promise<TerminalState>((resolve, reject) => {
      resolveCreate = resolve
      rejectCreate = reject
    })
    this.pendingCreates.set(input.terminalId, { promise, resolve: resolveCreate, reject: rejectCreate })
    const runtimeInput: RuntimeTerminalCreateInput = options.strictCwd
      ? { ...input, strictCwd: true }
      : input
    this.port?.postMessage({ type: 'terminal.create', input: runtimeInput })
    return promise
  }

  async input(input: TerminalInput): Promise<void> {
    await this.start()
    this.port?.postMessage({ type: 'terminal.input', input })
  }

  async resize(input: TerminalResizeInput): Promise<void> {
    await this.start()
    this.port?.postMessage({ type: 'terminal.resize', input })
  }

  acknowledgeOutput(input: TerminalOutputAck): void {
    this.port?.postMessage({ type: 'terminal.ack-output', input })
  }

  kill(terminalId: string): void {
    this.port?.postMessage({ type: 'terminal.kill', terminalId })
  }

  async stop(): Promise<void> {
    this.generation++
    const port = this.port
    const runtimeProcess = this.runtimeProcess
    this.port = undefined
    if (port) {
      port.postMessage({ type: 'terminal.shutdown' })
      port.close()
    }
    try { runtimeProcess?.kill() } catch { /* utility 进程可能已在退出 */ }
    this.runtimeProcess = undefined
    this.starting = undefined
    this.rejectPendingCreates(new Error('终端运行时已停止'))
  }

  private async start(): Promise<void> {
    if (this.port) return
    if (this.starting) return this.starting

    const starting = this.startRuntime(++this.generation)
    this.starting = starting
    try {
      await starting
    } finally {
      // 只清自己那一次：并发的新一代启动已经把 starting 换成它自己的了
      if (this.starting === starting) this.starting = undefined
    }
  }

  private async startRuntime(generation: number): Promise<void> {
    const entryPath = join(__dirname, 'terminal-runtime.cjs')
    const isCurrentStartup = (): boolean => generation === this.generation
    // Windows 上 fork 会同步抛瞬时 ENOTCONN，退避重试（收上游 #2074）
    const runtimeProcess = await startUtilityProcessWithRetry(
      () => utilityProcess.fork(entryPath, [], { serviceName: `${CANOPY_BRAND.productName} Terminal Runtime` }),
      { shouldContinue: isCurrentStartup },
    )
    if (!isCurrentStartup()) {
      try { runtimeProcess.kill() } catch { /* utility 进程可能已在退出 */ }
      throw new Error('终端运行时启动已取消')
    }
    this.runtimeProcess = runtimeProcess

    await new Promise<void>((resolve, reject) => {
      const channel = new MessageChannelMain()
      const port = channel.port2 as unknown as RuntimePort
      const isCurrentRuntime = (): boolean =>
        generation === this.generation
        && this.runtimeProcess === runtimeProcess
        && this.port === port
      const fail = (error: Error): void => {
        clearTimeout(timeout)
        // 旧一代的失败不许去拆现任 runtime 的台
        if (isCurrentRuntime()) this.handleRuntimeFailure(error, runtimeProcess, port)
        reject(error)
      }
      const timeout = setTimeout(() => {
        if (!isCurrentRuntime()) return
        fail(new Error('终端运行时启动超时'))
      }, STARTUP_TIMEOUT_MS)
      const ready = (): void => {
        clearTimeout(timeout)
        resolve()
      }
      this.port = port
      port.on('message', ({ data }) => {
        if (!isCurrentRuntime()) return
        const message = data as RuntimeMessage
        if (message?.type === 'terminal.ready') ready()
        this.handleMessage(message)
      })
      port.start()
      runtimeProcess.on('error', (type) => fail(new Error(`终端运行时错误：${type}`)))
      const processEvents = runtimeProcess as unknown as { on(event: 'exit', listener: (code: number) => void): void }
      processEvents.on('exit', (code) => fail(new Error(`终端运行时已退出（${code}）`)))
      runtimeProcess.postMessage({ type: 'canopy-terminal-runtime-port' }, [channel.port1])
    })
  }

  private handleMessage(message: RuntimeMessage): void {
    if (message.type === 'terminal.created') {
      const pending = this.pendingCreates.get(message.state.terminalId)
      this.pendingCreates.delete(message.state.terminalId)
      pending?.resolve(message.state)
    } else if (message.type === 'terminal.error') {
      const pending = this.pendingCreates.get(message.terminalId)
      this.pendingCreates.delete(message.terminalId)
      pending?.reject(new Error(message.message))
    } else if (message.type === 'terminal.output') {
      for (const listener of this.outputListeners) listener(message.event)
    } else if (message.type === 'terminal.exit') {
      for (const listener of this.exitListeners) listener(message.event)
    }
  }

  private handleRuntimeFailure(
    error: Error,
    runtimeProcess: UtilityProcess | undefined = this.runtimeProcess,
    port: RuntimePort | undefined = this.port,
  ): void {
    port?.close()
    // 只有当前任仍是自己时才清空字段，避免把新一代的 port / 进程误清掉
    if (this.port === port) this.port = undefined
    try { runtimeProcess?.kill() } catch { /* utility 进程可能已在退出 */ }
    if (this.runtimeProcess === runtimeProcess) this.runtimeProcess = undefined
    this.rejectPendingCreates(error)
  }

  private rejectPendingCreates(error: Error): void {
    for (const pending of this.pendingCreates.values()) pending.reject(error)
    this.pendingCreates.clear()
  }
}

export const terminalRuntimeClient = new TerminalRuntimeClient()
