/**
 * 语音听写 ASR 会话自动重连策略（纯逻辑，可测）。
 *
 * 背景：豆包 ASR 连接会被服务端主动关闭（VAD 静音超时是正常情况），仍在录音时应无感重连。
 * 但此前的重连**无退避、无上限**：服务端一旦持续快速踢会话（额度用尽、资源 ID 无权限、
 * 网络抖动），就变成每秒死循环，错误提示也刷屏。这里给重连加两道保险丝：
 * - 退避：同一段录音内连续重连的间隔按 ASR_RECONNECT_DELAYS_MS 递增（首次仍是立即，保住正常场景的无感）
 * - 上限：连续重连超过 ASR_RECONNECT_DELAYS_MS.length 次即放弃并报错，由调用方结束本次录音
 * 「连续」以最近一次健康信号为界：收到识别结果 / 新开一段录音都会把计数清零。
 */

/** 连续第 n 次重连前的等待时间（毫秒）；数组长度即重连上限 */
export const ASR_RECONNECT_DELAYS_MS: readonly number[] = [0, 500, 1000, 2000, 4000]

export interface AsrReconnectState {
  /** 自最近一次健康信号以来已经发起的重连次数 */
  attempts: number
}

export type AsrReconnectDecision =
  | { action: 'reconnect'; delayMs: number; attempt: number; next: AsrReconnectState }
  | { action: 'give-up'; attempts: number }

export function createAsrReconnectState(): AsrReconnectState {
  return { attempts: 0 }
}

/** 收到识别结果 / 新开录音：连接是健康的，重连计数归零 */
export function markAsrHealthy(_state: AsrReconnectState): AsrReconnectState {
  return createAsrReconnectState()
}

/** 会话被服务端关闭时决定：还能重连（等多久）还是该放弃 */
export function planAsrReconnect(state: AsrReconnectState): AsrReconnectDecision {
  const attempt = state.attempts + 1
  const delayMs = ASR_RECONNECT_DELAYS_MS[state.attempts]
  if (delayMs === undefined) {
    return { action: 'give-up', attempts: state.attempts }
  }
  return { action: 'reconnect', delayMs, attempt, next: { attempts: attempt } }
}

/** 放弃重连时给用户看的文案 */
export function buildAsrReconnectGiveUpMessage(attempts: number): string {
  return `语音识别连接连续 ${attempts} 次被服务端关闭，已停止重试。请检查豆包 ASR 凭证、资源额度或网络后重新开始听写`
}
