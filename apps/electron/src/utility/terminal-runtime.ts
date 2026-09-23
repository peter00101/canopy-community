import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawn, type IPty } from 'node-pty'
import {
  isTerminalProfile,
  type TerminalCreateInput,
  type TerminalExitEvent,
  type TerminalInput,
  type TerminalOutputAck,
  type TerminalOutputEvent,
  type TerminalResizeInput,
  type TerminalState,
} from '@canopy/shared'
import { TerminalOutputPump } from './terminal-output-pump'
import { resolveTerminalShell } from './terminal-shell-resolver'
import { CANOPY_BRAND } from '@canopy/brand'

type MessagePortLike = {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
  start(): void
  close(): void
}

type ParentPortLike = {
  on(event: 'message', listener: (event: { data: unknown; ports?: MessagePortLike[] }) => void): void
  start?: () => void
}

type RuntimeTerminalCreateInput = TerminalCreateInput & {
  strictCwd?: boolean
}

type RuntimeRequest =
  | { type: 'terminal.create'; input: RuntimeTerminalCreateInput }
  | { type: 'terminal.input'; input: TerminalInput }
  | { type: 'terminal.resize'; input: TerminalResizeInput }
  | { type: 'terminal.kill'; terminalId: string }
  | { type: 'terminal.ack-output'; input: TerminalOutputAck }
  | { type: 'terminal.shutdown' }

type ManagedTerminal = {
  pty: IPty
  state: TerminalState
  /** 输出合并与一块在飞的限速流控，逻辑在 terminal-output-pump.ts（可单测）。 */
  pump: TerminalOutputPump
  exitEvent: TerminalExitEvent | undefined
}

const MAX_PENDING_OUTPUT_CHARS = 1_000_000
const OUTPUT_FLUSH_DELAY_MS = 16
const terminals = new Map<string, ManagedTerminal>()
const parentPort = (process as typeof process & { parentPort?: ParentPortLike }).parentPort
let runtimePort: MessagePortLike | undefined

if (!parentPort) {
  console.error('[TerminalRuntime] Electron parentPort is unavailable')
  process.exit(1)
}

parentPort.on('message', (event) => {
  const value = event?.data as Record<string, unknown> | undefined
  const transfer = value?.data && typeof value.data === 'object' ? value.data as Record<string, unknown> : value
  if (!transfer || transfer.type !== 'canopy-terminal-runtime-port') return
  const port = event.ports?.[0] ?? value?.port as MessagePortLike | undefined
  if (!port) {
    console.error('[TerminalRuntime] invalid MessagePort bootstrap message')
    process.exit(1)
  }
  runtimePort?.close()
  runtimePort = port
  port.on('message', (message) => handleRequest(message.data))
  port.start()
  port.postMessage({ type: 'terminal.ready', pid: process.pid })
})
parentPort.start?.()

function handleRequest(raw: unknown): void {
  if (!isRuntimeRequest(raw)) return
  switch (raw.type) {
    case 'terminal.create':
      createTerminal(raw.input)
      return
    case 'terminal.input':
      terminals.get(raw.input.terminalId)?.pty.write(raw.input.data)
      return
    case 'terminal.resize': {
      const terminal = terminals.get(raw.input.terminalId)
      if (terminal) terminal.pty.resize(normalizeDimension(raw.input.cols), normalizeDimension(raw.input.rows))
      return
    }
    case 'terminal.kill':
      destroyTerminal(raw.terminalId)
      return
    case 'terminal.ack-output':
      acknowledgeOutput(raw.input)
      return
    case 'terminal.shutdown':
      for (const terminalId of terminals.keys()) destroyTerminal(terminalId)
      runtimePort?.postMessage({ type: 'terminal.stopped' })
      return
  }
}

function createTerminal(input: RuntimeTerminalCreateInput): void {
  const existing = terminals.get(input.terminalId)
  if (existing) {
    runtimePort?.postMessage({ type: 'terminal.created', state: existing.state })
    return
  }
  const profile = isTerminalProfile(input.profile) ? input.profile : 'default'
  try {
    const shell = resolveTerminalShell(profile)
    const cwd = getSafeCwd(input.cwd, input.strictCwd === true)
    const pty = spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: normalizeDimension(input.cols),
      rows: normalizeDimension(input.rows),
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    })
    const state: TerminalState = {
      terminalId: input.terminalId,
      title: shell.title,
      cwd,
      profile,
      pid: pty.pid,
    }
    const managed: ManagedTerminal = {
      pty,
      state,
      pump: new TerminalOutputPump({
        maxPendingChars: MAX_PENDING_OUTPUT_CHARS,
        flushDelayMs: OUTPUT_FLUSH_DELAY_MS,
        formatLossMarker: (dropped) => `\r\n\x1b[33m[${CANOPY_BRAND.productName}：终端输出过快，已丢弃 ${dropped} 个字符]\x1b[0m\r\n`,
        send: (event) => {
          const output: TerminalOutputEvent = { terminalId: input.terminalId, ...event }
          runtimePort?.postMessage({ type: 'terminal.output', event: output })
        },
      }),
      exitEvent: undefined,
    }
    terminals.set(input.terminalId, managed)
    runtimePort?.postMessage({ type: 'terminal.created', state })
    pty.onData((data) => managed.pump.enqueue(data))
    pty.onExit(({ exitCode, signal }) => {
      const event: TerminalExitEvent = { terminalId: input.terminalId, exitCode, ...(signal === undefined ? {} : { signal }) }
      const terminal = terminals.get(input.terminalId)
      if (!terminal) {
        runtimePort?.postMessage({ type: 'terminal.exit', event })
        return
      }
      terminal.exitEvent = event
      terminal.pump.flushNow()
      emitExitWhenDrained(input.terminalId)
    })
  } catch (error) {
    runtimePort?.postMessage({
      type: 'terminal.error',
      terminalId: input.terminalId,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

function acknowledgeOutput(input: TerminalOutputAck): void {
  const terminal = terminals.get(input.terminalId)
  if (!terminal?.pump.acknowledge(input.sequence)) return
  emitExitWhenDrained(input.terminalId)
}

function emitExitWhenDrained(terminalId: string): void {
  const terminal = terminals.get(terminalId)
  if (!terminal?.exitEvent || !terminal.pump.isDrained()) return
  terminals.delete(terminalId)
  terminal.pump.dispose()
  runtimePort?.postMessage({ type: 'terminal.exit', event: terminal.exitEvent })
}

function destroyTerminal(terminalId: string): void {
  const terminal = terminals.get(terminalId)
  if (!terminal) return
  terminal.pump.flushNow()
  terminal.pump.dispose()
  terminals.delete(terminalId)
  try {
    terminal.pty.kill()
  } catch {
    // 进程已退出时 node-pty 可能抛错；终端生命周期在此收束即可。
  }
}

function getSafeCwd(cwd: string | undefined, strict: boolean): string {
  if (isDirectory(cwd)) return cwd
  if (strict) throw new Error('终端工作目录不存在或不是目录')
  return homedir()
}

function isDirectory(path: string | undefined): path is string {
  if (!path || !existsSync(path)) return false
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function normalizeDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1
}

function isRuntimeRequest(value: unknown): value is RuntimeRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as { type?: unknown }
  return request.type === 'terminal.create' || request.type === 'terminal.input' || request.type === 'terminal.resize' || request.type === 'terminal.kill' || request.type === 'terminal.ack-output' || request.type === 'terminal.shutdown'
}
