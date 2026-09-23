/**
 * 「Agent 改动文件时自动打开侧面板」的纯判定。
 *
 * 背景：用户反馈「文件一改侧面板就自己弹出来，烦」。0.17.28 起加设置项
 * `agentAutoOpenChangesPanel`（默认开，保持既有行为）；关掉后改动照样记录进「改动」标签，
 * 只是不再自动弹面板、也不再抢标签页——面板完全交给用户手动开关。
 *
 * 判定与动作分离：这里只回答「这次要不要弹」，两处调用点（文件监听 / 写工具完成）共用；
 * 「每个 run 只弹一次」由调用方的 autoActivatedChangeTurns 记录，这里以入参形式参与判断，方便测。
 */
export interface AutoOpenChangesPanelInput {
  /** 设置项：改动文件时自动打开侧面板（undefined 视为默认开） */
  enabled: boolean | undefined
  /** 产生改动的会话是否就是当前正在看的会话（后台会话的改动从不弹） */
  isCurrentSession: boolean
  /** 本 run 是否已经弹过一次（同一轮多次改动只弹一次） */
  alreadyActivatedForRun: boolean
  /**
   * 用户此刻是否正盯着某个文件预览。
   *
   * 0.18.67 修维护者报障：Agent 改文件的同一刻把右侧面板抢去「改动」标签，正在看的预览被
   * 卸载且不会自己回来——用户的感知是「预览没有自动刷新」。改动仍记进「改动」标签，
   * 只是不抢已经在前台的预览。
   */
  isViewingPreview: boolean
}

export function shouldAutoOpenChangesPanel(input: AutoOpenChangesPanelInput): boolean {
  if (input.enabled === false) return false
  if (!input.isCurrentSession) return false
  if (input.alreadyActivatedForRun) return false
  if (input.isViewingPreview) return false
  return true
}
