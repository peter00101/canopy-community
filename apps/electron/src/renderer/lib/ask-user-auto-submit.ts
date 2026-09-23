/**
 * AskUser 卡片的自动提交判定（维护者 2026-09-20 定「单选即交 + 多选保留确认」）。
 *
 * 背景：原先无论哪种题型，最后一题都必须点一次「确认」。单选题点选项那一刻答案
 * 已经确定，这一步纯属多余；多选题则无法判断用户勾完没有，保留确认按钮。
 * 上游同一文件逐字相同（只差品牌一行），这套规则是我方自定的。
 */

/** 单选即交前留的可改口窗口：期间再点别的选项会重新计时。 */
export const ASK_USER_AUTO_SUBMIT_DELAY_MS = 400

/** 与既有「单选自动跳下一题」保持一致的节奏。 */
export const ASK_USER_AUTO_ADVANCE_DELAY_MS = 150

export interface AskUserTabState {
  /** 当前题是否是最后一题 */
  isLastTab: boolean
  /** 当前题是否多选 */
  multiSelect: boolean
  /** 当前题是否展开了「其他」自定义输入框 */
  showCustom: boolean
  /** 当前题已选中的选项数 */
  selectedCount: number
}

export type AskUserAdvanceDecision = 'next' | 'submit' | 'wait'

/**
 * 用户刚点中一个选项后该做什么。
 * - `next`：还有后续题目，跳下一题（既有行为）
 * - `submit`：最后一题且是单选，答案已定，自动提交
 * - `wait`：多选题，或正在填自定义文本，等用户显式点确认
 */
export function decideAskUserAdvance(state: AskUserTabState): AskUserAdvanceDecision {
  if (state.multiSelect) return 'wait'
  if (!state.isLastTab) return 'next'
  // 用户正在「其他」输入框里打字时绝不能替他提交
  if (state.showCustom) return 'wait'
  return 'submit'
}

/**
 * 底部「确认」按钮要不要显示。
 *
 * 关键是**不能把用户堵死**：最后一题是单选但还没选时仍要给按钮，
 * 否则用户想提交前面几题的答案就没有出口了。只有「单选且已选中」
 * ——也就是自动提交已在路上——才收起按钮。
 */
export function shouldShowAskUserConfirmButton(state: AskUserTabState): boolean {
  if (!state.isLastTab) return false
  if (state.multiSelect) return true
  if (state.showCustom) return true
  return state.selectedCount === 0
}
