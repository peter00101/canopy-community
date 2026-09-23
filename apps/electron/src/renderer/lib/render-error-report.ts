/**
 * 界面渲染错误报告
 *
 * 根级错误恢复页（RootErrorBoundary）用：把任意抛出值整理成可展示的摘要与可复制的纯文本报告。
 * 这里必须「自身绝不抛错」——恢复页再抛就只能回到白屏，所以对 null、字符串、奇怪对象、
 * toString 会抛的对象全部兜底。
 *
 * 零依赖纯函数：主进程（main/lib/renderer-error-log.ts）也从这里取日志前缀，两端判定口径同源。
 */

/**
 * 根级错误边界 console.error 的固定前缀。
 * 主进程只把「level 为 error 且以它开头」的 console 消息转进 crash 日志，改名需两端同步（同源即可保证）。
 */
export const ROOT_ERROR_LOG_PREFIX = '[RootErrorBoundary]'

export interface RenderErrorSummary {
  /** 错误类型名（TypeError 等；非 Error 抛出值为空串） */
  name: string
  /** 一行可读的错误说明，永不为空 */
  message: string
  /** JS 堆栈（没有则为空串） */
  stack: string
}

export interface RenderErrorReportInput {
  error: unknown
  /** React ErrorInfo.componentStack */
  componentStack?: string | null
  appVersion?: string
  /** 出错的窗口（main / quick-task 等） */
  scope?: string
  occurredAt?: Date
  userAgent?: string
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 本地时间 `YYYY-MM-DD HH:mm:ss +08:00`（与主进程崩溃日志同一口径，不用 UTC） */
export function formatReportTimestamp(date: Date): string {
  if (Number.isNaN(date.getTime())) return '未知时间'
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())} `
    + `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
}

function safeString(value: unknown): string {
  try {
    return String(value)
  } catch {
    return ''
  }
}

function safeStringifyObject(value: object): string {
  try {
    const json = JSON.stringify(value)
    if (json && json !== '{}') return json
  } catch {
    /* 循环引用等：退回 String() */
  }
  const text = safeString(value)
  return text && text !== '[object Object]' ? text : ''
}

/** 把任意抛出值整理为摘要；对非 Error 抛出值也给出人能看懂的一行说明 */
export function describeRenderError(error: unknown): RenderErrorSummary {
  try {
    if (error instanceof Error) {
      const name = safeString(error.name)
      const message = safeString(error.message).trim()
      return {
        name,
        message: message || name || '未知错误',
        stack: typeof error.stack === 'string' ? error.stack : '',
      }
    }
    if (error === null || error === undefined) {
      return { name: '', message: `未知错误（抛出值为 ${safeString(error)}）`, stack: '' }
    }
    if (typeof error === 'string') {
      return { name: '', message: error.trim() || '未知错误（抛出空字符串）', stack: '' }
    }
    if (typeof error === 'object') {
      const record = error as { name?: unknown; message?: unknown; stack?: unknown }
      const message = typeof record.message === 'string' && record.message.trim()
        ? record.message.trim()
        : safeStringifyObject(error)
      return {
        name: typeof record.name === 'string' ? record.name : '',
        message: message || '未知错误（抛出了无法描述的对象）',
        stack: typeof record.stack === 'string' ? record.stack : '',
      }
    }
    return { name: '', message: safeString(error) || '未知错误', stack: '' }
  } catch {
    return { name: '', message: '未知错误（错误信息无法读取）', stack: '' }
  }
}

/** 摘要的一行展示文本：`TypeError: xxx`（name 已含在 message 里时不重复） */
export function formatRenderErrorHeadline(summary: RenderErrorSummary): string {
  if (!summary.name || summary.message.startsWith(summary.name)) return summary.message
  return `${summary.name}: ${summary.message}`
}

/** 生成「复制错误详情」写入剪贴板的纯文本报告 */
export function buildRenderErrorReport(input: RenderErrorReportInput): string {
  const summary = describeRenderError(input.error)
  const lines: string[] = ['Canopy 界面错误报告']
  lines.push(`时间：${formatReportTimestamp(input.occurredAt ?? new Date())}`)
  if (input.appVersion) lines.push(`版本：${input.appVersion}`)
  if (input.scope) lines.push(`窗口：${input.scope}`)
  if (input.userAgent) lines.push(`环境：${input.userAgent}`)
  lines.push(`错误：${formatRenderErrorHeadline(summary)}`)
  lines.push('', '错误堆栈：', summary.stack.trim() || '（无）')
  lines.push('', '组件堆栈：', input.componentStack?.trim() || '（无）')
  return lines.join('\n')
}

/**
 * 根级边界捕获后写进 console.error 的**单个字符串**：前缀行 + 完整报告（错误、堆栈、组件堆栈）。
 *
 * 必须是一个自包含的字符串而不是 `console.error(前缀, error, componentStack)` 多参数：
 * 主进程靠 webContents 'console-message' 事件拿到的是 Chromium 转成的文本，Error 对象只剩
 * `TypeError: xxx` 一行、没有堆栈；堆栈与组件堆栈只有拼进字符串才能落进 crash 日志。
 */
export function buildRootErrorLogMessage(input: RenderErrorReportInput): string {
  return `${ROOT_ERROR_LOG_PREFIX} 界面渲染异常（窗口：${input.scope || 'unknown'}）\n${buildRenderErrorReport(input)}`
}
