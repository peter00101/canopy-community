/**
 * 渠道路由身份：让中转网关（CCH / claude-code-hub 及同类）能按「会话 + 代数」识别请求，
 * 渠道故障后 Canopy 主动换一个会话身份，触发网关重新选路健康渠道。
 *
 * 背景（2026-08-20 维护者实测）：CCH 的会话粘滞把首次成功请求绑定到某个供应商（5 分钟 TTL、
 * 每次请求滚动续期）。Canopy 此前不发任何会话标识，CCH 落到「消息内容哈希/请求指纹」兜底层
 * 识别会话——同一会话前缀恒定 → cch_session_id 恒定 → 绑定的渠道熔断后，用户越重试越给
 * 死绑定续命，表现为同一 cch_session_id 反复报
 * 「status_code=503, 所有供应商暂时不可用」；而 codex 用户重开会话（= 新身份）立即恢复。
 *
 * 注入通道：
 * - anthropic 协议：`metadata.user_id`（pi-ai anthropic-messages 编码层透传；CCH 第一优先级，
 *   格式为 CCH 可解析的 legacy 形态 `user_{device}_account__session_{id}`）
 * - responses/codex 协议：`x-session-id` 请求头（pi-ai 各编码层都透传 options.headers；
 *   CCH codex session-extractor 第二优先级读它）
 * - openai-completions（chat 体）：CCH 不从该体提取显式标识、pi-ai 也不透传 metadata，
 *   仍落内容哈希——此协议暂无法客户端换绑（主力渠道为 anthropic-compatible / responses，可接受）。
 *
 * 代数（epoch）推进策略——**统一连续失败阈值，零文案耦合（维护者 2026-08-20 三轮定调）**：
 * 任何失败（由 `stopReason === 'error'` 这个结构化字段判定，不解析错误文案）连续满
 * {@link CONSECUTIVE_FAILURES_BEFORE_REROUTE} 次 → 换身份；任何成功清零计数；用户停止
 * （Pi 已规范化为 `stopReason === 'aborted'`，进不了失败分支）不计。
 *
 * 为什么不按错误类型分层：靠文案猜「死绑 vs 瞬时抖动」太脆——网关文案会变、各家网关不同。
 * Pi 原版重试器（pi-ai utils/retry.js）已对瞬时类错误自动重试（退避 1s→2s→4s…，预算默认 8 次，
 * abort 永不重试），我们只在它之上叠一层「连续 3 次都没救回来就换路由」：
 * - 偶发 529/500/502（Anthropic 官方 529 过载属常态）：第 1~2 次原地重试就成功 → 不换，
 *   prompt cache（命中价 0.1 倍、丢一次当轮 input 全价 + 1.25 倍重建）分文不丢；
 * - 真正的会话级死路（如 CCH 死绑 503）：自动重试链内第 3 次失败即换身份，多等约 7 秒自愈；
 * - 阈值 3 < Pi 重试预算 8：一条消息的自动重试链内就能完成轮换、甚至二次轮换，用户无感。
 */
/** CCH legacy 解析要求 `user_(.+?)_account__session_(.+)`；device 段仅被记录，不参与路由。 */
const ROUTING_DEVICE_ID = 'canopy'

/** 连续失败达到该次数即换路由身份（前 2 次原地重试保缓存，第 3 次起优先能用）。 */
export const CONSECUTIVE_FAILURES_BEFORE_REROUTE = 3

/** 会话段：epoch 0 用原会话 ID，之后追加 `.rN` 代数后缀，保证换一代就是一个全新身份。 */
function buildSessionPart(sessionId: string, epoch: number): string {
  return epoch > 0 ? `${sessionId}.r${epoch}` : sessionId
}

export function buildRoutingUserId(sessionId: string, epoch: number): string {
  return `user_${ROUTING_DEVICE_ID}_account__session_${buildSessionPart(sessionId, epoch)}`
}



/**
 * 用户主动停止不是失败。主判定是结构化的：Pi 把 abort 规范化为 `stopReason === 'aborted'`，
 * 根本进不了 error 分支；此处只是对「error 分支里混入 abort 文案」的双保险。
 */
const USER_ABORT_PATTERN = /aborted|abort/i

export function isCountableFailure(errorText: string | undefined): boolean {
  if (!errorText) return true
  return !USER_ABORT_PATTERN.test(errorText)
}

export interface RoutingFailureRecord {
  /** 本次失败是否触发了路由身份切换。 */
  advanced: boolean
  /** 当前（可能刚推进的）代数。 */
  epoch: number
  /** 当前连续失败计数（推进后清零重数）。 */
  consecutiveFailures: number
}

export interface RoutingEpochStore {
  get(sessionId: string): number
  /** 记录一次失败；连续达阈值即推进代数并清零计数。 */
  recordFailure(sessionId: string): RoutingFailureRecord
  /** 记录一次成功：连续失败清零，epoch 保持（当前身份绑的渠道是健康的，继续粘滞享受缓存）。 */
  recordSuccess(sessionId: string): void
  clear(sessionId: string): void
}

type RoutingState = { epoch: number; failures: number }

/**
 * per-session 路由代数与连续失败计数，进程内存态、跨 run 持续（成功才清零）。
 * utility process 重启丢失无妨：CCH 的死绑定 5 分钟 TTL 内无请求也会自然过期。
 */
export function createRoutingEpochStore(): RoutingEpochStore {
  const states = new Map<string, RoutingState>()
  const stateOf = (sessionId: string): RoutingState => {
    let state = states.get(sessionId)
    if (!state) {
      state = { epoch: 0, failures: 0 }
      states.set(sessionId, state)
    }
    return state
  }
  return {
    get(sessionId) {
      return states.get(sessionId)?.epoch ?? 0
    },
    recordFailure(sessionId) {
      const state = stateOf(sessionId)
      state.failures += 1
      const shouldAdvance = state.failures >= CONSECUTIVE_FAILURES_BEFORE_REROUTE
      if (shouldAdvance) {
        state.epoch += 1
        state.failures = 0
      }
      return { advanced: shouldAdvance, epoch: state.epoch, consecutiveFailures: state.failures }
    },
    recordSuccess(sessionId) {
      const state = states.get(sessionId)
      if (state) state.failures = 0
    },
    clear(sessionId) {
      states.delete(sessionId)
    },
  }
}

type StreamOptionsLike = {
  headers?: Record<string, string>
  metadata?: Record<string, unknown>
} & Record<string, unknown>

/** 一次请求要带的两份身份：两条通道服务不同协议，形态可以不同。 */
export interface RoutingIdentity {
  /** 进 `metadata.user_id`，anthropic 协议。 */
  readonly metadataUserId: string
  /** 进 `x-session-id` 请求头，responses/codex 协议；恒为 CCH legacy 形态。 */
  readonly sessionHeaderId: string
}

/**
 * 构造本次请求的路由身份。`x-session-id` 头发 legacy 串，保住 CCH codex 那条路；
 * `metadata.user_id` 默认同为 legacy 串。
 */
export function buildRoutingIdentity(sessionId: string, epoch: number): RoutingIdentity {
  const sessionHeaderId = buildRoutingUserId(sessionId, epoch)
  let metadataUserId = sessionHeaderId
  return { metadataUserId, sessionHeaderId }
}

/**
 * 把路由身份合并进 stream options。既有同名键优先——若上游 Pi / 调用方将来自带身份，尊重之。
 */
export function injectRoutingIdentity<T extends StreamOptionsLike | undefined>(
  options: T,
  identity: RoutingIdentity,
): StreamOptionsLike {
  return {
    ...options,
    metadata: { user_id: identity.metadataUserId, ...options?.metadata },
    headers: { 'x-session-id': identity.sessionHeaderId, ...options?.headers },
  }
}
