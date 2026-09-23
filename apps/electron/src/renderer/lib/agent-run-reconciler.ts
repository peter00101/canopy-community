/**
 * Agent 运行态对账（防"任务已结束但 UI 永远转圈"）
 *
 * 背景：渲染层的 running 只由 STREAM_COMPLETE / STREAM_ERROR 结束。终态事件一旦丢失
 * （渲染层重载、事件竞态、断流后静默重试陪跑），会话就永久卡在"运行中"，且此时点停止
 * 打到的是主进程里早已不存在的 run——没有任何回执，形成死锁（上游官方用户实测复现）。
 *
 * 两条自愈路径共用本模块：
 *  1. 点停止兜底：STOP_AGENT 返回 hadActiveRun=false 时立即 finalize（用户自救，即点即恢复）
 *  2. 看门狗：running 会话周期性与主进程 listActiveSessionIds 对账，连续两轮缺席才判定
 *     stale（防"查询瞬间 run 恰好正常结束、终态事件仍在路上"的边缘竞态误杀）
 *
 * finalize 只动 UI 状态与触发已落盘消息重载，不碰主进程执行，误判的最坏后果是提前
 * 显示完成——不丢数据、不打断任何真实运行。
 */

import type { createStore } from 'jotai'
import {
  agentStreamingStatesAtom,
  agentMessageRefreshAtom,
  liveMessagesMapAtom,
} from '@/atoms/agent-atoms'
import { activeSessionIdAtom } from '@/atoms/tab-atoms'

type JotaiStore = ReturnType<typeof createStore>

/** 连续多少轮对账缺席才判定 stale（每轮间隔见 RECONCILE_INTERVAL_MS） */
export const STALE_RUN_CONFIRM_ROUNDS = 2

/** 看门狗对账周期。只在存在 running 会话时才真正发起 IPC 查询。 */
export const RECONCILE_INTERVAL_MS = 30_000

export interface ReconcileResult {
  /** 本轮确认卡死、应当 finalize 的会话 */
  staleSessions: string[]
  /** 下一轮对账的缺席连击计数（本轮已恢复/已判定的条目已剔除） */
  nextSuspects: Map<string, number>
}

/**
 * 纯判定：本地认为在跑、后端却没有的会话，连续 STALE_RUN_CONFIRM_ROUNDS 轮缺席才进 stale。
 *
 * @param localRunning  渲染层当前 running=true 的会话 ID
 * @param backendActive 主进程 listActiveSessionIds 的返回（含 automation/headless run）
 * @param suspects      上一轮返回的 nextSuspects（首轮传空 Map）
 */
export function reconcileStaleRunningSessions(
  localRunning: Iterable<string>,
  backendActive: Iterable<string>,
  suspects: ReadonlyMap<string, number>,
): ReconcileResult {
  const backend = new Set(backendActive)
  const staleSessions: string[] = []
  const nextSuspects = new Map<string, number>()

  for (const sessionId of localRunning) {
    if (backend.has(sessionId)) continue // 后端确认在跑，清零连击
    const misses = (suspects.get(sessionId) ?? 0) + 1
    if (misses >= STALE_RUN_CONFIRM_ROUNDS) {
      staleSessions.push(sessionId)
    } else {
      nextSuspects.set(sessionId, misses)
    }
  }
  // 不在 localRunning 里的旧 suspect 自然被丢弃（会话已正常结束或被用户处理）

  return { staleSessions, nextSuspects }
}

/**
 * 结束一个已确认卡死的本地运行态：清 running / 触发已落盘消息重载（把主进程早已写盘的
 * 结果与错误显示出来）/ 后台会话顺手回收实时消息。
 *
 * 与上游 STREAM_COMPLETE 的 finalize 口径一致（0.17.28 起）：可见会话的实时消息**不在这里清**，
 * 由 AgentView 在消息重载完成后清理，避免「实时气泡消失 → 持久化消息未到」的空档闪烁；
 * 后台会话没有挂载的 AgentView，就地回收以免 liveMessagesMap 随运行时长单调增长。
 */
export function finalizeStaleAgentRun(store: JotaiStore, sessionId: string): void {
  console.warn(`[Agent 对账] 会话 ${sessionId.slice(0, 8)} 本地显示运行中但主进程无活跃 run，结束本地运行态`)
  store.set(agentStreamingStatesAtom, (prev) => {
    const current = prev.get(sessionId)
    if (!current || (!current.running && !current.backgroundWaiting)) return prev
    const map = new Map(prev)
    map.set(sessionId, {
      ...current,
      running: false,
      backgroundWaiting: false,
    })
    return map
  })
  if (store.get(activeSessionIdAtom) !== sessionId) {
    store.set(liveMessagesMapAtom, (prev) => {
      if (!prev.has(sessionId)) return prev
      const map = new Map(prev)
      map.delete(sessionId)
      return map
    })
  }
  store.set(agentMessageRefreshAtom, (prev) => {
    const map = new Map(prev)
    map.set(sessionId, (prev.get(sessionId) ?? 0) + 1)
    return map
  })
}
