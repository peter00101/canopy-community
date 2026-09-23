/**
 * 新手引导离开流程的纯逻辑。
 *
 * 引导有两种入口：
 * - 首次启动 / 引导版本升级（first-run）：右上角按钮文案「跳过」，跳过即算完成，
 *   与走完点「开始使用」共用同一条完成路径（写完成状态 → 建欢迎对话 → 进 Chat 模式）。
 * - 从设置重放（replay）：右上角按钮文案「退出引导」，退出不重写完成状态，回到设置的新手引导页。
 *
 * 组件只负责把用户动作翻译成 entry + trigger，去哪、写不写设置都由这里决定，便于单测。
 */

import { openTab, type TabItem } from '@/atoms/tab-atoms'
import type { AppMode } from '@/atoms/app-mode'
import type { ActiveView } from '@/atoms/active-view'
import { CURRENT_ONBOARDING_VERSION, type AppSettings } from '../../../types'

/** 引导入口 */
export type OnboardingEntry = 'first-run' | 'replay'

/** 离开引导的方式：finish = 走完点「开始使用」；dismiss = 右上角跳过/退出按钮或 Esc */
export type OnboardingExitTrigger = 'finish' | 'dismiss'

/** 离开引导后的落点 */
export type OnboardingDestination = 'welcome-conversation' | 'settings-onboarding'

export interface OnboardingExitPlan {
  /** 是否写入 onboardingCompleted + onboardingVersion */
  persistCompletion: boolean
  destination: OnboardingDestination
}

export function getOnboardingEntry(isReplaying: boolean): OnboardingEntry {
  return isReplaying ? 'replay' : 'first-run'
}

/** 右上角常驻退出按钮的文案 */
export function getOnboardingDismissLabel(entry: OnboardingEntry): string {
  return entry === 'replay' ? '退出引导' : '跳过'
}

/** 落点只看入口：重放回设置，首次/升级进欢迎对话（跳过与走完一致）。 */
export function getOnboardingDestination(entry: OnboardingEntry): OnboardingDestination {
  return entry === 'replay' ? 'settings-onboarding' : 'welcome-conversation'
}

export function resolveOnboardingExit(entry: OnboardingEntry, trigger: OnboardingExitTrigger): OnboardingExitPlan {
  return {
    // 重放中途退出不动完成状态；其余（首次跳过 / 首次走完 / 重放走完）都按完成写入，与原「开始使用」一致
    persistCompletion: !(entry === 'replay' && trigger === 'dismiss'),
    destination: getOnboardingDestination(entry),
  }
}

/** 完成引导时写入的设置片段 */
export function buildOnboardingCompletionSettings(): Required<Pick<AppSettings, 'onboardingCompleted' | 'onboardingVersion'>> {
  return {
    onboardingCompleted: true,
    onboardingVersion: CURRENT_ONBOARDING_VERSION,
  }
}

export interface OnboardingEscapeKeyInput {
  key: string
  defaultPrevented: boolean
  /** 输入法组合输入中（中文输入法按 Esc 是取消候选词） */
  isComposing: boolean
  repeat: boolean
  /** 事件目标的标签名（大写，如 INPUT），无目标时传 null */
  targetTagName: string | null
  targetIsContentEditable: boolean
  /** 页面上是否有打开的弹窗 / 菜单 / 下拉列表（它们的 Esc 应先关自己） */
  hasOpenOverlay: boolean
}

const EDITABLE_TAG_NAMES = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/** 引导显示期间，这次 keydown 是否应触发右上角的跳过/退出。 */
export function shouldDismissOnboardingOnKeydown(input: OnboardingEscapeKeyInput): boolean {
  if (input.key !== 'Escape') return false
  if (input.defaultPrevented || input.isComposing || input.repeat) return false
  if (input.targetIsContentEditable) return false
  if (input.targetTagName && EDITABLE_TAG_NAMES.has(input.targetTagName.toUpperCase())) return false
  return !input.hasOpenOverlay
}

export interface WelcomeConversationMeta {
  id: string
  title: string
}

export interface WelcomeConversationEntryPlan {
  tabs: TabItem[]
  activeTabId: string
  appMode: AppMode
  currentConversationId: string
  activeView: ActiveView
}

/**
 * 首次引导完成后进入欢迎对话：Tab、模式、当前对话三者一次对齐，
 * 与 useOpenSession 打开 Chat 会话的同步口径一致（左栏切到 Chat 列表并高亮该对话）。
 */
export function planWelcomeConversationEntry(tabs: TabItem[], meta: WelcomeConversationMeta): WelcomeConversationEntryPlan {
  const result = openTab(tabs, { type: 'chat', sessionId: meta.id, title: meta.title })
  return {
    tabs: result.tabs,
    activeTabId: result.activeTabId,
    appMode: 'chat',
    currentConversationId: meta.id,
    activeView: 'conversations',
  }
}
