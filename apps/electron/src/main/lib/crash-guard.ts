/**
 * 主进程崩溃防护与落盘日志
 *
 * 背景：Agent runtime（pi）、IM Bridge 长连接、MCP stdio 子进程、文件监听都跑在主进程里。
 * 此前主进程没有任何 uncaughtException / unhandledRejection 防护——长任务期间任何一个
 * 未捕获异步异常都会直接终结整个应用（用户表现为「软件闪退」），且不留任何日志，无法归因。
 *
 * 策略：
 * - uncaughtException：记录到 ~/.canopy/logs/crash-YYYY-MM-DD.log 后**不退出**。桌面应用
 *   记录后维持存活优于直接死亡（VS Code 同款取舍）；状态可疑但用户数据全部经原子写落盘，
 *   继续运行的风险远小于无预警丢失全部工作。
 * - unhandledRejection：仅记录。Node 默认 throw 模式下它会升级成 uncaughtException 终结进程，
 *   注册 handler 即阻断该升级路径。
 * - child-process-gone（GPU / utility 等）：本文件记录留证。
 * - render-process-gone：主窗口的在 index.ts（限次自动 reload）；受管浏览器 view 的在
 *   browser-controller.ts createTab（记录 + 标记 tab 崩溃 + CDP 快速失败），两处都调本文件的
 *   logCrashEvent 落盘。0.17.24 前 view 这一路是空的（审查报告 B-2）。
 * - renderer-error：渲染层根级错误边界（RootErrorBoundary）的 console.error，经 webContents
 *   'console-message' 转进来，见 renderer-error-log.ts（不走 IPC）。
 *
 * 日志按天一个文件，追加写，单文件超过 5MB 后停写（防异常风暴刷爆磁盘）。
 *
 * 文件名与行内时间戳都用**本地时间**（带时区偏移）。曾经用 toISOString()（UTC）：
 * 中国时区早 8 点前的闪退会记进「昨天」的文件，维护者按今天的日期找日志一无所获——
 * 而这份日志是排查闪退的唯一线索（0.17.23 修，审查报告 B-3）。
 */

import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from './config-paths'

const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024
/** 同类错误 10 秒内只落盘一次，防止定时器内的重复异常刷屏。 */
const DUPLICATE_SUPPRESS_MS = 10_000

const recentErrorKeys = new Map<string, number>()

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 本地日期 YYYY-MM-DD（用于按天分文件；不用 toISOString，那是 UTC）。 */
export function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 本地时间戳 `YYYY-MM-DD HH:mm:ss.SSS +08:00`，带偏移量所以跨机器看也不会歧义。 */
export function formatLocalTimestamp(date: Date): string {
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`
  // getTimezoneOffset 是「UTC - 本地」的分钟数，东八区返回 -480，符号要反过来
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  return `${formatLocalDate(date)} ${time} ${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
}

function getCrashLogPath(): string {
  const dir = join(getConfigDir(), 'logs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, `crash-${formatLocalDate(new Date())}.log`)
}

function shouldSuppress(key: string): boolean {
  const now = Date.now()
  const last = recentErrorKeys.get(key)
  // 顺带清理过期条目，Map 不会无界增长
  for (const [k, t] of recentErrorKeys) {
    if (now - t > DUPLICATE_SUPPRESS_MS) recentErrorKeys.delete(k)
  }
  if (last !== undefined && now - last < DUPLICATE_SUPPRESS_MS) return true
  recentErrorKeys.set(key, now)
  return false
}

export function logCrashEvent(kind: string, detail: unknown): void {
  const text = detail instanceof Error ? (detail.stack ?? detail.message) : String(detail)
  const key = `${kind}:${text.slice(0, 200)}`
  if (shouldSuppress(key)) return

  const line = `[${formatLocalTimestamp(new Date())}] [${kind}] ${text}\n`
  try {
    const logPath = getCrashLogPath()
    if (existsSync(logPath) && statSync(logPath).size > MAX_LOG_FILE_BYTES) return
    appendFileSync(logPath, line, 'utf-8')
  } catch {
    /* 日志写入失败不能再抛，否则会递归触发 */
  }
}

/** 必须在 app ready 之前调用，越早越好——启动期异常同样需要留证。 */
export function installCrashGuard(): void {
  process.on('uncaughtException', (error) => {
    console.error('[崩溃防护] uncaughtException（已拦截，进程继续运行）:', error)
    logCrashEvent('uncaughtException', error)
  })

  process.on('unhandledRejection', (reason) => {
    console.error('[崩溃防护] unhandledRejection（已拦截）:', reason)
    logCrashEvent('unhandledRejection', reason)
  })
}

/** app ready 后补挂 Electron 层事件（app 模块的事件在 ready 前也可挂，统一入口便于阅读）。 */
export function installAppCrashListeners(app: Electron.App): void {
  app.on('child-process-gone', (_event, details) => {
    // GPU/utility 进程 Chromium 会自行重启，只留证不干预
    console.error('[崩溃防护] 子进程异常退出:', details)
    logCrashEvent('child-process-gone', `type=${details.type} reason=${details.reason} exitCode=${details.exitCode} name=${details.name ?? ''}`)
  })
}
