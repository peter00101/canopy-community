/**
 * utility 进程启动加固（收上游 #2074 `1f8df675`）。
 *
 * Windows 上 `utilityProcess.fork` 会在 Node 包装刚创建的 stdio 句柄时
 * **同步抛出** `ENOTCONN`——这是瞬时失败，重试即可成功。用户侧表现为
 * Agent 或终端偶发起不来。其余错误一律保持原有失败语义，不吞不掩。
 *
 * 放在 `@canopy/shared` 而不是 apps/electron：Agent runtime 客户端已迁入
 * `@canopy/runtime-pi`、终端 runtime 客户端仍在 apps/electron，两边都要用，
 * 只有 shared 是它们共同的上游依赖。本文件是纯逻辑，不 import electron。
 */

/** 两次退避：25ms、100ms。用尽后按原错误抛出。 */
export const UTILITY_PROCESS_START_RETRY_DELAYS_MS = [25, 100] as const

export const UTILITY_PROCESS_START_CANCELLED_CODE = 'UTILITY_PROCESS_START_CANCELLED'

type UtilityProcessStartupCancelledError = Error & {
  code: typeof UTILITY_PROCESS_START_CANCELLED_CODE
  cause?: unknown
}

function createUtilityProcessStartupCancelledError(cause?: unknown): UtilityProcessStartupCancelledError {
  const error = new Error('utility 进程启动已取消') as UtilityProcessStartupCancelledError
  error.code = UTILITY_PROCESS_START_CANCELLED_CODE
  if (cause !== undefined) error.cause = cause
  return error
}

export function isUtilityProcessStartupCancelledError(error: unknown): error is UtilityProcessStartupCancelledError {
  return !!error
    && typeof error === 'object'
    && (error as { code?: unknown }).code === UTILITY_PROCESS_START_CANCELLED_CODE
}

type UtilityProcessStartupOptions = {
  platform?: NodeJS.Platform
  sleep?: (milliseconds: number) => Promise<void>
  /** 退避期间被 stop / 新一代启动抢占时返回 false，用于放弃这次启动。 */
  shouldContinue?: () => boolean
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/** 只认 Windows 上的 ENOTCONN：平台不对或错误不对都不重试。 */
export function isRetryableUtilityProcessStartupError(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return false
  if (!error || typeof error !== 'object') return false

  const candidate = error as { code?: unknown; message?: unknown }
  return candidate.code === 'ENOTCONN'
    || (typeof candidate.message === 'string' && /\bENOTCONN\b/.test(candidate.message))
}

/**
 * 按有限退避重试 utility 进程启动。`start` 同步抛出的可重试错误才会重试；
 * 每次重试前后都问 `shouldContinue`，被抢占时抛显式取消错误（调用方据此
 * 区分「真失败」与「已被停止」，避免把停止中的会话误标成 crashed）。
 */
export async function startUtilityProcessWithRetry<T>(
  start: () => T,
  options: UtilityProcessStartupOptions = {},
): Promise<T> {
  const platform = options.platform ?? process.platform
  const sleep = options.sleep ?? defaultSleep
  const shouldContinue = options.shouldContinue ?? (() => true)

  for (let attempt = 0; ; attempt++) {
    if (!shouldContinue()) throw createUtilityProcessStartupCancelledError()
    try {
      return start()
    } catch (error) {
      const delay = UTILITY_PROCESS_START_RETRY_DELAYS_MS[attempt]
      if (delay === undefined || !isRetryableUtilityProcessStartupError(error, platform)) throw error
      await sleep(delay)
      if (!shouldContinue()) throw createUtilityProcessStartupCancelledError(error)
    }
  }
}
