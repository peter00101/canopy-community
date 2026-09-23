/**
 * RootErrorBoundary - 根级界面错误恢复页
 *
 * 渲染层此前只有 Tab / 预览 / @ 菜单等局部边界，侧栏、设置、初始化组件等任何一处渲染期
 * 抛错都会让 React 卸载整棵树 = 整窗白屏且没有任何恢复入口。本边界包在各窗口 React 根上，
 * 兜住所有未被局部边界接住的渲染错误，给出「重新加载界面 / 复制错误详情」。
 *
 * 样式自带（内联 <style>），不依赖 Tailwind 类与 ui primitives：出错时全局样式可能没加载，
 * 所以颜色一律 `hsl(var(--主题令牌, var(--本地回退)))`，主题变量缺失也看得清。
 *
 * 日志：不走 IPC。捕获后 console.error 一个带固定前缀的自包含字符串（见 buildRootErrorLogMessage），
 * 主进程在挂了本边界的窗口上监听 webContents 'console-message'，把它转进 ~/.canopy/logs/crash-*.log
 * （main/lib/renderer-error-log.ts），用户那边白屏也能拿到日志。
 */

import * as React from 'react'
import { AlertTriangle } from 'lucide-react'
import { CANOPY_BRAND } from '@canopy/brand'
import { copyTextToClipboard } from '@/lib/clipboard'
import { detectIsMac, detectIsWindows } from '@/lib/platform'
import {
  buildRenderErrorReport,
  buildRootErrorLogMessage,
  describeRenderError,
  formatRenderErrorHeadline,
  ROOT_ERROR_LOG_PREFIX,
} from '@/lib/render-error-report'

declare const __APP_VERSION__: string

const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''

/** 日志前缀：排查时在 DevTools / 日志里按它检索；主进程也按它把日志转进 crash 日志 */
export { ROOT_ERROR_LOG_PREFIX }

const ROOT_ERROR_STYLES = `
.canopy-root-error {
  --cre-bg: 0 0% 100%;
  --cre-fg: 0 0% 9%;
  --cre-muted-fg: 0 0% 40%;
  --cre-border: 0 0% 86%;
  --cre-surface: 0 0% 96%;
  --cre-primary: 262 83% 58%;
  --cre-primary-fg: 0 0% 100%;
  --cre-destructive: 0 72% 51%;
  position: fixed;
  inset: 0;
  z-index: 50;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  overflow: auto;
  background: hsl(var(--background, var(--cre-bg)));
  color: hsl(var(--foreground, var(--cre-fg)));
  font-family: 'Inter Variable', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.6;
}
.dark .canopy-root-error {
  --cre-bg: 0 0% 10%;
  --cre-fg: 0 0% 96%;
  --cre-muted-fg: 0 0% 64%;
  --cre-border: 0 0% 26%;
  --cre-surface: 0 0% 15%;
  --cre-primary: 263 70% 66%;
  --cre-primary-fg: 0 0% 100%;
  --cre-destructive: 0 72% 62%;
}
.canopy-root-error *,
.canopy-root-error *::before,
.canopy-root-error *::after {
  box-sizing: border-box;
}
.canopy-root-error__drag {
  flex-shrink: 0;
  height: 36px;
  -webkit-app-region: drag;
}
.canopy-root-error__titlebar-spacer {
  flex-shrink: 0;
  height: 32px;
}
.canopy-root-error__panel {
  width: 100%;
  max-width: 580px;
  min-width: 0;
  margin: auto;
  padding: 32px 24px 40px;
}
.canopy-root-error__icon {
  color: hsl(var(--destructive, var(--cre-destructive)));
}
.canopy-root-error__brand {
  margin: 16px 0 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: hsl(var(--muted-foreground, var(--cre-muted-fg)));
}
.canopy-root-error__title {
  margin: 4px 0 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.4;
}
.canopy-root-error__desc {
  margin: 8px 0 0;
  color: hsl(var(--muted-foreground, var(--cre-muted-fg)));
}
.canopy-root-error__message {
  margin: 16px 0 0;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid hsl(var(--border, var(--cre-border)));
  background: hsl(var(--muted, var(--cre-surface)));
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  user-select: text;
  -webkit-user-select: text;
}
.canopy-root-error__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 20px;
}
.canopy-root-error__btn {
  -webkit-app-region: no-drag;
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 34px;
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid hsl(var(--border, var(--cre-border)));
  background: hsl(var(--background, var(--cre-bg)));
  color: hsl(var(--foreground, var(--cre-fg)));
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 120ms ease, background-color 120ms ease;
}
.canopy-root-error__btn:hover {
  background: hsl(var(--accent, var(--cre-surface)));
}
.canopy-root-error__btn:focus-visible {
  outline: 2px solid hsl(var(--ring, var(--cre-primary)));
  outline-offset: 2px;
}
.canopy-root-error__btn--primary {
  border-color: transparent;
  background: hsl(var(--primary, var(--cre-primary)));
  color: hsl(var(--primary-foreground, var(--cre-primary-fg)));
}
.canopy-root-error__btn--primary:hover {
  background: hsl(var(--primary, var(--cre-primary)));
  opacity: 0.9;
}
.canopy-root-error__status {
  font-size: 12px;
  color: hsl(var(--muted-foreground, var(--cre-muted-fg)));
}
.canopy-root-error__details {
  margin-top: 20px;
  border-top: 1px solid hsl(var(--border, var(--cre-border)));
  padding-top: 12px;
}
.canopy-root-error__details summary {
  -webkit-app-region: no-drag;
  cursor: pointer;
  font-size: 13px;
  color: hsl(var(--muted-foreground, var(--cre-muted-fg)));
}
.canopy-root-error__report {
  margin: 10px 0 0;
  padding: 12px;
  max-height: 45vh;
  overflow: auto;
  border-radius: 8px;
  border: 1px solid hsl(var(--border, var(--cre-border)));
  background: hsl(var(--muted, var(--cre-surface)));
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  user-select: text;
  -webkit-user-select: text;
}
`

/** 包住恢复页里的窗口控件：控件自身再抛错就静默不显示，绝不让恢复页也白掉 */
class SilentBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    console.error(`${ROOT_ERROR_LOG_PREFIX} 恢复页窗口控件渲染失败:`, error)
  }

  override render(): React.ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

type CopyStatus = 'idle' | 'copied' | 'failed'

export interface RootErrorFallbackProps {
  error: unknown
  componentStack?: string | null
  /** 出错窗口标识，写进错误报告 */
  scope?: string
  /** 无边框窗口的自绘标题栏控件（Windows 最小化/关闭等），恢复页里重新挂一份 */
  windowChrome?: React.ReactNode
  /** 测试注入；默认整页 reload */
  onReload?: () => void
  /** 测试注入；默认写系统剪贴板 */
  onCopy?: (text: string) => Promise<void>
}

export function RootErrorFallback({
  error,
  componentStack,
  scope,
  windowChrome,
  onReload,
  onCopy,
}: RootErrorFallbackProps): React.ReactElement {
  const [copyStatus, setCopyStatus] = React.useState<CopyStatus>('idle')
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const isMac = React.useMemo(() => detectIsMac(), [])
  const headline = React.useMemo(() => formatRenderErrorHeadline(describeRenderError(error)), [error])
  const report = React.useMemo(() => buildRenderErrorReport({
    error,
    componentStack,
    scope,
    appVersion: APP_VERSION,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
  }), [error, componentStack, scope])

  const handleReload = (): void => {
    if (onReload) {
      onReload()
      return
    }
    window.location.reload()
  }

  const handleCopy = (): void => {
    const copy = onCopy ?? ((text: string) => copyTextToClipboard(text))
    copy(report).then(
      () => setCopyStatus('copied'),
      (copyError: unknown) => {
        console.error(`${ROOT_ERROR_LOG_PREFIX} 复制错误详情失败:`, copyError)
        setCopyStatus('failed')
      },
    )
  }

  const productName = CANOPY_BRAND.productName

  return (
    <div className="canopy-root-error" data-testid="root-error-fallback">
      <style dangerouslySetInnerHTML={{ __html: ROOT_ERROR_STYLES }} />
      {windowChrome ? <SilentBoundary>{windowChrome}</SilentBoundary> : null}
      {/* Windows 标题栏的拖拽区由 windowChrome 自带（与按钮分矩形隔离），这里只留高度；
          mac 无边框窗口补一条拖拽带，避免恢复页挡住窗口移动 */}
      {windowChrome && isWindows ? <div className="canopy-root-error__titlebar-spacer" aria-hidden="true" /> : null}
      {windowChrome && isMac ? <div className="canopy-root-error__drag" aria-hidden="true" /> : null}
      <main className="canopy-root-error__panel" role="alert">
        <AlertTriangle className="canopy-root-error__icon" size={36} strokeWidth={1.75} aria-hidden="true" />
        <p className="canopy-root-error__brand">{productName}</p>
        <h1 className="canopy-root-error__title">界面出了点问题</h1>
        <p className="canopy-root-error__desc">
          {productName} 的界面在显示时遇到了意外错误，已保存的会话和文件不受影响。
          可以先点「重新加载界面」；如果反复出现，请点「复制错误详情」发给我们排查。
        </p>
        <p className="canopy-root-error__message" title={headline}>{headline}</p>
        <div className="canopy-root-error__actions">
          <button
            type="button"
            className="canopy-root-error__btn canopy-root-error__btn--primary"
            onClick={handleReload}
          >
            重新加载界面
          </button>
          <button type="button" className="canopy-root-error__btn" onClick={handleCopy}>
            复制错误详情
          </button>
          <span className="canopy-root-error__status" aria-live="polite">
            {copyStatus === 'copied' ? '已复制到剪贴板' : null}
            {copyStatus === 'failed' ? '复制失败，请展开详情手动选中复制' : null}
          </span>
        </div>
        <details className="canopy-root-error__details">
          <summary>查看错误详情</summary>
          <pre className="canopy-root-error__report">{report}</pre>
        </details>
      </main>
    </div>
  )
}

interface RootErrorBoundaryProps {
  children: React.ReactNode
  /** 出错窗口标识（main / quick-task 等），写进日志与错误报告 */
  scope?: string
  /** 见 RootErrorFallbackProps.windowChrome */
  windowChrome?: React.ReactNode
}

export interface RootErrorBoundaryState {
  hasError: boolean
  error: unknown
  componentStack: string | null
}

export class RootErrorBoundary extends React.Component<RootErrorBoundaryProps, RootErrorBoundaryState> {
  override state: RootErrorBoundaryState = { hasError: false, error: null, componentStack: null }

  static getDerivedStateFromError(error: unknown): Partial<RootErrorBoundaryState> {
    return { hasError: true, error }
  }

  override componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    // 单个字符串：主进程 'console-message' 只拿得到文本，堆栈必须拼进来才能落进 crash 日志
    console.error(buildRootErrorLogMessage({
      error,
      componentStack: info.componentStack,
      scope: this.props.scope,
      appVersion: APP_VERSION,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    }))
    this.setState({ componentStack: info.componentStack ?? null })
  }

  override render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <RootErrorFallback
          error={this.state.error}
          componentStack={this.state.componentStack}
          scope={this.props.scope}
          windowChrome={this.props.windowChrome}
        />
      )
    }
    return this.props.children
  }
}
