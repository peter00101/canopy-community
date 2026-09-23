import { runWithPiRequestProxyScope } from './pi-request-proxy'

/** OAuth 登录/刷新流程需要的、来自 Electron 侧的两个网络能力；由调用方注入。 */
export interface PiOAuthNetworkDeps {
  /** 用系统浏览器打开一个 URL（登录授权页）。 */
  openExternal(url: string): Promise<void>
  /** 读取当前生效的应用代理地址（未配置代理时返回 undefined）。 */
  getProxyUrl(): Promise<string | undefined>
}

// EnvHttpProxyAgent 以 URL hostname 匹配 IPv6；方括号形式才能正确匹配 http://[::1]/。
const LOOPBACK_NO_PROXY_HOSTS = ['localhost', '127.0.0.1', '[::1]']

export function readNoProxyEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // 与 EnvHttpProxyAgent 保持相同的 lowercase 优先级。
  const noProxy = env.no_proxy ?? env.NO_PROXY
  return noProxy?.trim() || undefined
}

/**
 * OAuth 的浏览器回调必须直接访问本地 loopback；保留用户已有的 NO_PROXY 规则并补齐它们。
 */
export function buildOAuthNoProxy(noProxy = readNoProxyEnvironment()): string {
  if (noProxy?.trim() === '*') return '*'

  const hosts = new Set(
    (noProxy ?? '')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean),
  )
  for (const host of LOOPBACK_NO_PROXY_HOSTS) hosts.add(host)
  return [...hosts].join(',')
}

/**
 * 用 Canopy 的全局代理配置执行一段 Pi OAuth 网络操作。
 *
 * Pi OAuth 内部使用全局 fetch；受管 scope 通过 AsyncLocalStorage 为该异步链路绑定
 * dispatcher，并在操作结束后关闭连接池。外部系统浏览器不属于此网络平面。
 */
export async function runWithOAuthProxyScope<T>(
  operation: () => Promise<T>,
  getProxyUrl: () => Promise<string | undefined>,
): Promise<T> {
  return runWithPiRequestProxyScope({
    proxyUrl: await getProxyUrl(),
    noProxy: buildOAuthNoProxy(),
  }, operation)
}
