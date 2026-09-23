/**
 * 设置导航纯逻辑（无 React / Jotai 依赖，便于单测）。
 *
 * 所有导航项——包括「Canopy 教程」——一律只在设置内部切换右侧内容：
 * 不关设置、不 openTab、不改 activeView / appMode、不动自动任务表单。
 * 解析结果只有三种「设置内部」意图，类型上就不存在「主区副作用」这条分支，
 * 以后谁想再给某个导航项加特殊动作，得先改这里的类型和测试。
 */

import type { SettingsTab } from '@/atoms/settings-tab'

/** 点击设置左侧导航项后的意图 */
export type SettingsNavigationIntent =
  /** 点的就是当前页：什么都不做 */
  | { kind: 'stay' }
  /** 直接切换右侧内容 */
  | { kind: 'switch'; tabId: SettingsTab }
  /** 渠道表单有未保存内容：先弹「放弃未保存的更改？」，确认后再切 */
  | { kind: 'confirm-discard'; tabId: SettingsTab }

export interface SettingsNavigationInput {
  currentTab: SettingsTab
  targetTab: SettingsTab
  channelFormDirty: boolean
}

export function resolveSettingsNavigation({
  currentTab,
  targetTab,
  channelFormDirty,
}: SettingsNavigationInput): SettingsNavigationIntent {
  if (targetTab === currentTab) return { kind: 'stay' }
  if (currentTab === 'channels' && channelFormDirty) {
    return { kind: 'confirm-discard', tabId: targetTab }
  }
  return { kind: 'switch', tabId: targetTab }
}

/**
 * 右侧内容区的承载方式：
 * - scroll-area：普通设置页，套设置面板统一的 ScrollArea + 页边距；
 * - self-scroll：页面自带滚动容器（教程阅读器要让目录跳转 / 滚动联动拿到正确的容器），
 *   外层不再套 ScrollArea，避免双层滚动。
 */
export type SettingsContentLayout = 'scroll-area' | 'self-scroll'

const SELF_SCROLL_TABS: ReadonlySet<SettingsTab> = new Set<SettingsTab>(['tutorial'])

export function getSettingsContentLayout(tab: SettingsTab): SettingsContentLayout {
  return SELF_SCROLL_TABS.has(tab) ? 'self-scroll' : 'scroll-area'
}
