export const BROWSER_CDP_COMMAND_TIMEOUT_MS = 8_000
/**
 * Agent 注入的页面脚本（Runtime.evaluate awaitPromise）天然比 DOM.focus 之类的瞬时命令耗时长，
 * 沿用 8s 通用超时会在脚本内含多个等待时误判为通道卡死，触发「重连调试器 → ref 全失效 →
 * 重新 Observe」的放大循环；单独放宽到 30s。
 */
export const BROWSER_EVALUATE_TIMEOUT_MS = 30_000
export const BROWSER_OBSERVE_TIMEOUT_MS = 5_000
export const BROWSER_OBSERVE_AX_DEPTH = 8
export const BROWSER_OBSERVE_EXTENDED_AX_DEPTH = 16

/**
 * 高预算 Observe 不应仍被浅层 AX tree 截断；默认值保持紧凑，
 * 只有明确请求超过默认容量时才读取更深层的树，避免常规页面观察退化。
 */
export function resolveBrowserObserveAxDepth(maxElements: number): number {
  return maxElements > 240 ? BROWSER_OBSERVE_EXTENDED_AX_DEPTH : BROWSER_OBSERVE_AX_DEPTH
}

export class BrowserCdpTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`浏览器页面未在 ${Math.ceil(timeoutMs / 1_000)} 秒内响应 ${method}，请稍后重试或重新加载页面。`)
    this.name = 'BrowserCdpTimeoutError'
  }
}

/** 已发出的 DevTools 命令无法撤销；该错误只保证不再执行后续页面动作。 */
export class BrowserOperationAbortedError extends Error {
  constructor() {
    super('浏览器操作已停止。已发送的页面指令可能已执行，页面状态请重新观察确认。')
    this.name = 'BrowserOperationAbortedError'
  }
}

export function throwIfBrowserOperationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BrowserOperationAbortedError()
}

/** loadUrlToleratingSlowFinish 所需的最小 WebContents 能力面。 */
export interface NavigableWebContents {
  loadURL(url: string): Promise<void>
  on(event: 'did-navigate', listener: () => void): unknown
  removeListener(event: 'did-navigate', listener: () => void): unknown
}

/**
 * webContents.loadURL 直到 did-finish-load 才 settle；重资源页面（门户站冷加载）常超过
 * 命令超时，导致「页面已打开却报 BrowserCdpTimeoutError」的假失败。此封装在超时发生但
 * 主框架已提交导航（did-navigate，含重定向落点）时视为成功——页面已在渲染，只是子资源
 * 仍在加载。真失败（DNS/策略拦截）由 did-fail-load 在超时前快速 reject，不受影响。
 */
export async function loadUrlToleratingSlowFinish(webContents: NavigableWebContents, url: string, timeoutMs = BROWSER_CDP_COMMAND_TIMEOUT_MS, signal?: AbortSignal): Promise<void> {
  let committed = false
  const onNavigate = () => { committed = true }
  webContents.on('did-navigate', onNavigate)
  try {
    await withBrowserCdpTimeout(() => webContents.loadURL(url), 'Page.navigate', timeoutMs, signal)
  } catch (error) {
    if (error instanceof BrowserCdpTimeoutError && committed) return
    throw error
  } finally {
    webContents.removeListener('did-navigate', onNavigate)
  }
}

/**
 * Electron Debugger 的 sendCommand 在目标页面卡死或 DevTools 通道异常时可能永不 settle。
 * 超时/中止只负责让调用方继续执行；底层 command 后续 settle 时会被安全忽略。
 */
export function withBrowserCdpTimeout<T>(command: () => Promise<T>, method: string, timeoutMs = BROWSER_CDP_COMMAND_TIMEOUT_MS, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const settle = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => settle(() => reject(new BrowserOperationAbortedError()))
    const timer = setTimeout(() => settle(() => reject(new BrowserCdpTimeoutError(method, timeoutMs))), timeoutMs)
    if (signal?.aborted) { onAbort(); return }
    signal?.addEventListener('abort', onAbort, { once: true })

    void Promise.resolve()
      .then(command)
      .then((value) => settle(() => resolve(value)))
      .catch((error: unknown) => settle(() => reject(error)))
  })
}
