/**
 * 受管浏览器 view 崩溃语义（纯逻辑，无 Electron 依赖，可普通 Bun 测试）。
 *
 * 背景：`WebContentsView` 的渲染进程 OOM / 崩溃后，view 变白，但 BrowserController 内部
 * 仍认为 tab 存活——Agent 继续发 CDP 命令 → 8s/30s 超时 → 重连调试器 → 再超时，陷入
 * 重试循环，且崩溃日志里没有任何记录（审查报告 B-2，0.17.24 修）。
 *
 * 这里只回答两个问题：某个 `render-process-gone` 的 reason 算不算崩溃；崩溃后给
 * 用户/Agent 看的文案是什么。真正的监听与快速失败在 browser-controller.ts。
 */

/** Electron `RenderProcessGoneDetails.reason` 的取值；`clean-exit` 是正常退出（关标签 / 导航换进程），不算崩溃。 */
const NON_CRASH_REASONS: ReadonlySet<string> = new Set(['clean-exit'])

const REASON_LABELS: Readonly<Record<string, string>> = {
  'oom': '页面内存耗尽被系统终止',
  'crashed': '页面渲染进程崩溃',
  'killed': '页面进程被外部终止',
  'launch-failed': '页面进程启动失败',
  'abnormal-exit': '页面进程异常退出',
  'integrity-failure': '页面进程完整性校验失败',
}

export function isBrowserRendererCrash(reason: string): boolean {
  return !NON_CRASH_REASONS.has(reason)
}

export interface BrowserRendererCrashText {
  /** 写进活动条 / 账本的一句话 */
  trace: string
  /** 崩溃后 Agent 再发 CDP 命令时抛给它的错误文案（要能指导下一步动作） */
  agentError: string
}

export function describeBrowserRendererCrash(reason: string, exitCode?: number): BrowserRendererCrashText {
  const label = REASON_LABELS[reason] ?? `页面进程已退出（${reason}）`
  const code = typeof exitCode === 'number' ? `，退出码 ${exitCode}` : ''
  return {
    trace: `${label}${code}，该标签当前无法操作`,
    agentError: `${label}${code}。该标签的页面已不存在：请用 BrowserNavigate 重新加载它，或 BrowserCloseTab 关闭后 BrowserNewTab 新建；不要重复发送观察/点击命令。`,
  }
}
