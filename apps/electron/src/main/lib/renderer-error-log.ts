/**
 * 渲染层根级错误边界日志 → 主进程 crash 日志
 *
 * RootErrorBoundary 捕获渲染错误后只 console.error（不为此新增 IPC），用户那边整窗出错时
 * 维护者拿不到任何日志。这里在挂了根边界的窗口（主窗口、快速任务、独立预览、工作区记忆）的
 * webContents 上监听 'console-message'，只把「level 为 error 且以 [RootErrorBoundary] 开头」的
 * 消息转给 crash-guard 的 logCrashEvent，落进 ~/.canopy/logs/crash-YYYY-MM-DD.log（kind = renderer-error）。
 *
 * Electron 43 的 'console-message' 是事件对象形式：第一个参数自带 level（'info' | 'warning' |
 * 'error' | 'debug' 字符串）与 message；其后的位置参数（数字 level、message 等）已废弃，这里不用。
 * 其他 console 输出一概不转：普通 console.error 量大且多为可恢复错误，混进 crash 日志只会淹没真正的线索。
 *
 * 渲染层那边 console.error 的是一个自包含字符串（buildRootErrorLogMessage），所以堆栈与组件堆栈都在 message 里。
 */

import { ROOT_ERROR_LOG_PREFIX } from '../../renderer/lib/render-error-report'
import { logCrashEvent } from './crash-guard'

/** crash 日志里的事件类型 */
export const RENDERER_ERROR_CRASH_KIND = 'renderer-error'

/** 单条日志正文上限：正常报告几 KB，超长多半是异常数据，截断防止刷大日志文件 */
export const MAX_RENDERER_ERROR_DETAIL_CHARS = 16_000

/** 'console-message' 事件对象里用得到的字段（Electron 的 WebContentsConsoleMessageEventParams 子集） */
export interface RootErrorConsoleMessage {
  level?: string
  message?: string
}

/** 是否是根级错误边界打出的错误日志：level 为 error，且消息以固定前缀开头（不是「包含」） */
export function isRootErrorBoundaryConsoleMessage(details: RootErrorConsoleMessage | null | undefined): boolean {
  return details?.level === 'error'
    && typeof details.message === 'string'
    && details.message.startsWith(ROOT_ERROR_LOG_PREFIX)
}

/** crash 日志正文：`window=<窗口> <原消息>`，超长截断并注明原长度 */
export function formatRendererErrorLogDetail(windowLabel: string, message: string): string {
  const body = message.length > MAX_RENDERER_ERROR_DETAIL_CHARS
    ? `${message.slice(0, MAX_RENDERER_ERROR_DETAIL_CHARS)}\n…（已截断，原文 ${message.length} 字符）`
    : message
  return `window=${windowLabel} ${body}`
}

/** webContents 的最小接口，便于测试注入 */
export interface ConsoleMessageSource {
  on(event: 'console-message', listener: (details: RootErrorConsoleMessage) => void): unknown
}

/**
 * 给窗口的 webContents 挂监听。listener 随 webContents 销毁自动释放；页面 reload 不影响（挂在 webContents 上）。
 * @param windowLabel 写进日志的窗口标识（main / quick-task / detached-preview / workspace-memory）
 * @param log 测试注入；默认 logCrashEvent
 */
export function forwardRootErrorBoundaryLogs(
  contents: ConsoleMessageSource,
  windowLabel: string,
  log: (kind: string, detail: unknown) => void = logCrashEvent,
): void {
  contents.on('console-message', (details) => {
    if (!isRootErrorBoundaryConsoleMessage(details)) return
    log(RENDERER_ERROR_CRASH_KIND, formatRendererErrorLogDetail(windowLabel, details.message as string))
  })
}
