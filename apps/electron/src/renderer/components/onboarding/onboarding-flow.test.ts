import { describe, expect, test } from 'bun:test'
import type { TabItem } from '@/atoms/tab-atoms'
import { CURRENT_ONBOARDING_VERSION, hasCompletedCurrentOnboarding } from '../../../types'
import {
  buildOnboardingCompletionSettings,
  getOnboardingDestination,
  getOnboardingDismissLabel,
  getOnboardingEntry,
  planWelcomeConversationEntry,
  resolveOnboardingExit,
  shouldDismissOnboardingOnKeydown,
  type OnboardingEscapeKeyInput,
} from './onboarding-flow'

const escapeKey = (overrides: Partial<OnboardingEscapeKeyInput> = {}): OnboardingEscapeKeyInput => ({
  key: 'Escape',
  defaultPrevented: false,
  isComposing: false,
  repeat: false,
  targetTagName: 'BODY',
  targetIsContentEditable: false,
  hasOpenOverlay: false,
  ...overrides,
})

describe('新手引导入口与退出按钮文案', () => {
  test('给定从设置重放 当显示引导 则入口为 replay、按钮文案为「退出引导」', () => {
    const entry = getOnboardingEntry(true)
    expect(entry).toBe('replay')
    expect(getOnboardingDismissLabel(entry)).toBe('退出引导')
  })

  test('给定首次启动或版本升级 当显示引导 则入口为 first-run、按钮文案为「跳过」', () => {
    const entry = getOnboardingEntry(false)
    expect(entry).toBe('first-run')
    expect(getOnboardingDismissLabel(entry)).toBe('跳过')
  })
})

describe('离开引导后去哪、写不写完成状态', () => {
  test('给定重放中途 当按退出引导或 Esc 则回设置新手引导页且不重写完成状态', () => {
    expect(resolveOnboardingExit('replay', 'dismiss')).toEqual({
      persistCompletion: false,
      destination: 'settings-onboarding',
    })
  })

  test('给定重放走到最后 当点开始使用 则仍回设置页并保持原有的完成写入', () => {
    expect(resolveOnboardingExit('replay', 'finish')).toEqual({
      persistCompletion: true,
      destination: 'settings-onboarding',
    })
  })

  test('给定首次启动 当点跳过或 Esc 则与点开始使用完全同一条完成路径', () => {
    const skipped = resolveOnboardingExit('first-run', 'dismiss')
    const finished = resolveOnboardingExit('first-run', 'finish')
    expect(skipped).toEqual({ persistCompletion: true, destination: 'welcome-conversation' })
    expect(skipped).toEqual(finished)
  })

  test('给定任意入口 当取落点 则只由入口决定', () => {
    expect(getOnboardingDestination('first-run')).toBe('welcome-conversation')
    expect(getOnboardingDestination('replay')).toBe('settings-onboarding')
  })

  test('给定完成写入的设置片段 当下次启动判断 则视为已完成当前版本、不再弹出', () => {
    const patch = buildOnboardingCompletionSettings()
    expect(patch).toEqual({ onboardingCompleted: true, onboardingVersion: CURRENT_ONBOARDING_VERSION })
    expect(hasCompletedCurrentOnboarding(patch)).toBe(true)
  })
})

describe('引导显示期间的 Esc 判定', () => {
  test('给定焦点在页面空白处 当按 Esc 则触发跳过/退出', () => {
    expect(shouldDismissOnboardingOnKeydown(escapeKey())).toBe(true)
  })

  test('给定没有事件目标 当按 Esc 则触发跳过/退出', () => {
    expect(shouldDismissOnboardingOnKeydown(escapeKey({ targetTagName: null }))).toBe(true)
  })

  test('给定按的不是 Esc 当 keydown 则不触发', () => {
    expect(shouldDismissOnboardingOnKeydown(escapeKey({ key: 'Enter' }))).toBe(false)
    expect(shouldDismissOnboardingOnKeydown(escapeKey({ key: 'Esc' }))).toBe(false)
  })

  test.each([
    ['输入框', { targetTagName: 'INPUT' }],
    ['多行输入框', { targetTagName: 'textarea' }],
    ['下拉选择', { targetTagName: 'SELECT' }],
    ['可编辑区域', { targetTagName: 'DIV', targetIsContentEditable: true }],
  ])('给定焦点在%s 当按 Esc 则不误触发', (_label, overrides) => {
    expect(shouldDismissOnboardingOnKeydown(escapeKey(overrides))).toBe(false)
  })

  test('给定有打开的弹窗或菜单 当按 Esc 则留给弹窗自己关闭', () => {
    expect(shouldDismissOnboardingOnKeydown(escapeKey({ hasOpenOverlay: true }))).toBe(false)
  })

  test('给定输入法正在组合输入 当按 Esc 则不触发', () => {
    expect(shouldDismissOnboardingOnKeydown(escapeKey({ isComposing: true }))).toBe(false)
  })

  test('给定事件已被其他处理器消费或是长按连发 当按 Esc 则不触发', () => {
    expect(shouldDismissOnboardingOnKeydown(escapeKey({ defaultPrevented: true }))).toBe(false)
    expect(shouldDismissOnboardingOnKeydown(escapeKey({ repeat: true }))).toBe(false)
  })
})

describe('首次引导完成后进入欢迎对话', () => {
  const meta = { id: 'welcome-1', title: '了解 Canopy' }

  test('给定首次启动没有任何 Tab 当完成引导 则打开欢迎对话 Tab 并切到 Chat 模式选中该对话', () => {
    expect(planWelcomeConversationEntry([], meta)).toEqual({
      tabs: [{ id: 'welcome-1', type: 'chat', sessionId: 'welcome-1', title: '了解 Canopy' }],
      activeTabId: 'welcome-1',
      appMode: 'chat',
      currentConversationId: 'welcome-1',
      activeView: 'conversations',
    })
  })

  test('给定版本升级用户上次停在 Agent 会话 当完成引导 则欢迎对话替换顶部入口且模式与 Tab 一致为 Chat', () => {
    const tabs: TabItem[] = [{ id: 'agent-1', type: 'agent', sessionId: 'agent-1', title: '旧任务' }]
    const plan = planWelcomeConversationEntry(tabs, meta)
    expect(plan.tabs).toEqual([{ id: 'welcome-1', type: 'chat', sessionId: 'welcome-1', title: '了解 Canopy' }])
    expect(plan.activeTabId).toBe(plan.currentConversationId)
    expect(plan.appMode).toBe('chat')
    expect(plan.tabs.find((tab) => tab.id === plan.activeTabId)?.type).toBe(plan.appMode)
  })
})
