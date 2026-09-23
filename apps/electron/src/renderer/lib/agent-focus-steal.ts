/**
 * 「Agent 能不能抢走右侧工作区的焦点」的统一判定（维护者 2026-09-20 定）。
 *
 * 背景：Agent 干活时会不断开浏览器、开终端、改文件、改项目数据，四条路径各自
 * 无条件 `setDiffPanelTabMap(...)`，用户正盯着「改动」也会被切走。维护者报障：
 * 「我选了改动，那就一直显示改动即可，其他的可以出现」。
 *
 * 这不是第一次了——同一个病已经打过两轮补丁，都在 `agent-changes-panel-auto-open.ts`：
 * 0.17.28 加设置项（「文件一改侧面板就自己弹出来，烦」）、0.18.67 不抢正在看的预览。
 * 本文件把那两轮沉淀下来的两条思想抽成通用底座，推广到全部路径：
 *
 *   ① **手点过就锁死**：用户在本会话显式点过任意标签，此后 Agent 一次都不许抢，
 *      只把新标签加进标签栏并标未读。这是维护者这轮点名要的。
 *   ② **每 run 每类只抢一次**：用户还没表态时（新会话、挂机等 Agent 干活），
 *      允许每类来源在每轮 run 里带他看一眼——Agent 连开五个网页只抢第一次。
 *      浏览器恰恰最需要这条：`onAgentBrowserStateChanged` 每导航一次就来一发。
 *
 * 判定与动作分离，便于测；「本 run 是否抢过」由调用方按 `${sessionId}:${source}`
 * 记录 runId，以入参形式参与判断（沿用 changes 面板 autoActivatedChangeTurns 的做法）。
 */

/** 会抢焦点的来源。分开记账，一类抢过不影响另一类。 */
export type AgentFocusStealSource =
  | 'browser'
  | 'terminal'
  | 'workspace-component'
  | 'changes'
  /** 父会话派生出委派子会话时切到「委派观察」 */
  | 'delegation'

export interface AgentFocusStealInput {
  /** 事件所属会话是否就是用户此刻正在看的会话（后台会话永远不许抢） */
  isCurrentSession: boolean
  /** 用户在本会话是否显式点过右侧工作区的标签 */
  userPinnedTab: boolean
  /** 本轮 run 内该来源是否已经抢过一次 */
  alreadyStolenForRun: boolean
}

export function shouldStealSidePanelFocus(input: AgentFocusStealInput): boolean {
  if (!input.isCurrentSession) return false
  if (input.userPinnedTab) return false
  if (input.alreadyStolenForRun) return false
  return true
}

/**
 * 记账键：同一会话下不同来源分别计数，
 * 例如浏览器抢过之后，终端首次打开仍可带用户看一眼。
 */
export function focusStealKey(sessionId: string, source: AgentFocusStealSource): string {
  return `${sessionId}:${source}`
}

/**
 * 没抢成焦点时要让用户知道「那边有动静」：给该标签打未读点。
 * 抢到焦点的那次不打——用户已经看见了。
 *
 * **后台会话也要打**：它必然抢不到焦点，正因为用户此刻没在看，切回去时的
 * 未读点才是他唯一的线索。早先版本在这里漏判了 `isCurrentSession`，
 * 结果后台会话既不切标签也无提示，等于什么都没发生。
 */
export function shouldMarkTabUnread(input: { stoleFocus: boolean }): boolean {
  return !input.stoleFocus
}
