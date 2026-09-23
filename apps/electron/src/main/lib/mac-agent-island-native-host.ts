import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeAgentIslandEvent, NativeAgentIslandSnapshot } from '@canopy/shared'

const PROTOCOL = 1
/**
 * 放弃等待 helper 就绪的上限。
 * 新签名 / 新安装的包首次执行会被系统扫描拖慢（0.18.92 首启主进程到 EventKit 初始化 51s、0.18.97 约 70s），
 * helper 是独立二进制、同样要过扫描；原来 4s 就 dispose，等于每个新装用户的第一次启动都没有灵动岛。
 * 等待期间 snapshot 照常因未就绪而丢弃，就绪后由 onReady 补发一次，所以多等没有代价。
 */
const READY_TIMEOUT_MS = 120_000
/** 超过这个时间还没就绪就在日志里提示一句，方便从启动日志量出真实耗时。 */
const READY_SLOW_NOTICE_MS = 5_000

export interface MacAgentIslandNativeHostOptions {
  onReady: () => void
  onEvent: (event: NativeAgentIslandEvent) => void
  /** helper 不存在、协议不兼容或运行中退出时，调用方应保持 Island 禁用。 */
  onUnavailable: (reason: string) => void
  /** 测试注入：改用指定路径的 helper。生产不传，走包内 / dist 下的真 helper。 */
  helperPath?: string
  /** 测试注入：就绪上限毫秒数。生产不传，用 READY_TIMEOUT_MS。 */
  readyTimeoutMs?: number
}

let child: ChildProcessWithoutNullStreams | null = null
let ready = false
let closing = false
let readyTimer: ReturnType<typeof setTimeout> | null = null
let slowTimer: ReturnType<typeof setTimeout> | null = null
let stdoutBuffer = ''

function helperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'agent-island', 'macos-agent-island-helper')
    : join(__dirname, 'resources', 'agent-island', 'macos-agent-island-helper')
}

/** 就绪上限与「继续等待」提示两个定时器一起清；就绪、超时、退出、dispose 都走这里。 */
function clearReadyTimer(): void {
  if (readyTimer) clearTimeout(readyTimer)
  readyTimer = null
  if (slowTimer) clearTimeout(slowTimer)
  slowTimer = null
}

function parseEvent(line: string): NativeAgentIslandEvent | null {
  try {
    const value: unknown = JSON.parse(line)
    if (!value || typeof value !== 'object') return null
    const event = value as Record<string, unknown>
    // Keep the raw version long enough for the caller to report a useful
    // incompatibility error instead of degrading through a ready timeout.
    if (event.type === 'ready' && typeof event.protocol === 'number') {
      return { type: 'ready', protocol: event.protocol } as NativeAgentIslandEvent
    }
    if (event.type === 'fatal' && typeof event.message === 'string') return { type: 'fatal', message: event.message }
    if (event.type !== 'intent' || typeof event.name !== 'string') return null
    if (event.name === 'set-expanded' && typeof event.expanded === 'boolean') {
      return { type: 'intent', name: 'set-expanded', expanded: event.expanded }
    }
    if (event.name === 'set-hovered' && typeof event.hovered === 'boolean') {
      return { type: 'intent', name: 'set-hovered', hovered: event.hovered }
    }
    if (event.name === 'open-session' && typeof event.sessionId === 'string' && event.sessionId.length > 0) {
      return { type: 'intent', name: 'open-session', sessionId: event.sessionId }
    }
    if (event.name === 'open-main' || event.name === 'dismiss') {
      return { type: 'intent', name: event.name }
    }
    return null
  } catch {
    return null
  }
}

function write(message: unknown): boolean {
  if (!child || child.killed || child.stdin.destroyed) return false
  try {
    child.stdin.write(`${JSON.stringify(message)}\n`)
    return true
  } catch {
    return false
  }
}

export function startMacAgentIslandNativeHost(options: MacAgentIslandNativeHostOptions): boolean {
  if (process.platform !== 'darwin') return false
  if (child && !child.killed) return true

  const path = options.helperPath ?? helperPath()
  if (!existsSync(path)) {
    options.onUnavailable(`native helper missing: ${path}`)
    return false
  }

  closing = false
  ready = false
  stdoutBuffer = ''
  clearReadyTimer()
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS
  try {
    child = spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'], detached: false })
  } catch (error) {
    child = null
    options.onUnavailable(`failed to spawn native helper: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }

  const current = child
  const spawnedAt = Date.now()
  slowTimer = setTimeout(() => {
    if (current !== child || ready) return
    console.warn(`[agent-island] 原生 helper ${READY_SLOW_NOTICE_MS / 1000}s 内未就绪，继续等待（新签名或新安装的包首次启动会被系统扫描拖慢，属正常）`)
  }, READY_SLOW_NOTICE_MS)
  readyTimer = setTimeout(() => {
    if (current !== child || ready) return
    options.onUnavailable(`native helper did not report ready within ${readyTimeoutMs}ms`)
    disposeMacAgentIslandNativeHost()
  }, readyTimeoutMs)

  current.stdout.setEncoding('utf8')
  current.stdout.on('data', (chunk: string) => {
    // 已被放弃（超时 dispose / 应用退出）的 helper 迟到的输出一律忽略：
    // dispose 到 SIGTERM 之间有 800ms，helper 这时补打的 ready 原来会把 ready 置回 true、
    // 并打出一条假的「已就绪」（0.18.92 / 0.18.97 首启日志里那条）。
    if (current !== child || closing) return
    stdoutBuffer += chunk
    let newline = stdoutBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim()
      stdoutBuffer = stdoutBuffer.slice(newline + 1)
      if (line) {
        const event = parseEvent(line)
        if (event?.type === 'ready') {
          if (event.protocol !== PROTOCOL) {
            options.onUnavailable(`unsupported native helper protocol: ${event.protocol}`)
            disposeMacAgentIslandNativeHost()
          } else if (!ready) {
            ready = true
            clearReadyTimer()
            console.info(`[agent-island] 原生 helper 就绪耗时 ${Date.now() - spawnedAt}ms`)
            options.onReady()
          }
        } else if (event?.type === 'fatal') {
          disposeMacAgentIslandNativeHost()
          options.onUnavailable(`native helper fatal: ${event.message}`)
        } else if (event) {
          options.onEvent(event)
        }
      }
      newline = stdoutBuffer.indexOf('\n')
    }
  })

  current.stderr.setEncoding('utf8')
  current.stderr.on('data', (chunk: string) => {
    // Swift diagnostics are deliberately stderr-only so stdout stays JSONL clean.
    console.warn(`[agent-island:native] ${chunk.trim()}`)
  })

  current.once('error', (error) => {
    if (current !== child || closing) return
    options.onUnavailable(`native helper process error: ${error.message}`)
  })
  current.once('exit', (code, signal) => {
    if (current !== child) return
    const wasReady = ready
    child = null
    ready = false
    clearReadyTimer()
    if (!closing) options.onUnavailable(`native helper exited (${wasReady ? 'after ready, ' : ''}code=${code ?? 'null'}, signal=${signal ?? 'none'})`)
  })

  return true
}

export function isMacAgentIslandNativeHostReady(): boolean {
  return ready && child !== null && !child.killed
}

export function publishMacAgentIslandSnapshot(snapshot: NativeAgentIslandSnapshot): boolean {
  if (!isMacAgentIslandNativeHostReady()) return false
  return write(snapshot)
}

export function disposeMacAgentIslandNativeHost(): void {
  closing = true
  clearReadyTimer()
  const current = child
  if (!current || current.killed) {
    child = null
    ready = false
    stdoutBuffer = ''
    return
  }
  // 退出竞态：helper 可能已先退出导致 stdin 管道断裂，write 会异步触发 EPIPE。
  // 必须注册 noop error 监听（try/catch 拦不住异步 error 事件），并检查流是否仍可写。
  const stdin = current.stdin
  if (stdin && !stdin.destroyed) {
    stdin.on('error', () => { /* helper already closing; ignore EPIPE */ })
    try {
      if (stdin.writable) stdin.write('{"type":"shutdown"}\n')
    } catch { /* child may already be closing */ }
    stdin.end()
  }
  child = null
  ready = false
  stdoutBuffer = ''
  const forceTimer = setTimeout(() => {
    if (!current.killed) current.kill('SIGTERM')
  }, 800)
  current.once('exit', () => clearTimeout(forceTimer))
}
