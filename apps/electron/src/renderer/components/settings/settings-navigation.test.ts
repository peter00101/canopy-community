import { describe, expect, test } from 'bun:test'
import type { SettingsTab } from '@/atoms/settings-tab'
import { getSettingsContentLayout, resolveSettingsNavigation } from './settings-navigation'

/** 设置左侧导航的全部页（与 SettingsTab 联合类型一一对应） */
const ALL_SETTINGS_TABS: SettingsTab[] = [
  'general',
  'channels',
  'vision-relay',
  'prompts',
  'proxy',
  'tools',
  'voice-input',
  'bots',
  'tutorial',
  'shortcuts',
  'usage',
  'migration',
  'storage',
  'appearance',
  'onboarding',
  'about',
]

describe('resolveSettingsNavigation：点「Canopy 教程」与其他导航项一致，只切设置右侧内容', () => {
  test('给定当前在通用设置 当点 Canopy 教程 则意图只是切到教程页，不带任何其他动作', () => {
    const intent = resolveSettingsNavigation({
      currentTab: 'general',
      targetTab: 'tutorial',
      channelFormDirty: false,
    })

    // 精确相等：意图里不存在 openTab / 关设置 / 改 activeView 之类的额外字段
    expect(intent).toEqual({ kind: 'switch', tabId: 'tutorial' })
  })

  test('给定当前就在教程页 当再点 Canopy 教程 则原地不动', () => {
    expect(resolveSettingsNavigation({
      currentTab: 'tutorial',
      targetTab: 'tutorial',
      channelFormDirty: false,
    })).toEqual({ kind: 'stay' })
  })

  test('给定渠道表单有未保存内容 当点 Canopy 教程 则与其他导航项一样先确认放弃，不直接离开', () => {
    expect(resolveSettingsNavigation({
      currentTab: 'channels',
      targetTab: 'tutorial',
      channelFormDirty: true,
    })).toEqual({ kind: 'confirm-discard', tabId: 'tutorial' })
  })

  test('给定渠道表单已保存 当点 Canopy 教程 则直接切页', () => {
    expect(resolveSettingsNavigation({
      currentTab: 'channels',
      targetTab: 'tutorial',
      channelFormDirty: false,
    })).toEqual({ kind: 'switch', tabId: 'tutorial' })
  })

  test('给定表单脏标记残留但当前不在渠道页 当点任意导航项 则不拦截', () => {
    expect(resolveSettingsNavigation({
      currentTab: 'tutorial',
      targetTab: 'about',
      channelFormDirty: true,
    })).toEqual({ kind: 'switch', tabId: 'about' })
  })

  test('给定任意当前页与任意目标页 当解析导航 则意图只落在 stay / switch / confirm-discard 三种设置内部动作里', () => {
    const allowedKinds = new Set(['stay', 'switch', 'confirm-discard'])
    for (const currentTab of ALL_SETTINGS_TABS) {
      for (const targetTab of ALL_SETTINGS_TABS) {
        for (const channelFormDirty of [false, true]) {
          const intent = resolveSettingsNavigation({ currentTab, targetTab, channelFormDirty })
          expect(allowedKinds.has(intent.kind)).toBe(true)
          if (intent.kind === 'stay') {
            expect(Object.keys(intent)).toEqual(['kind'])
          } else {
            expect(Object.keys(intent).sort()).toEqual(['kind', 'tabId'])
            expect(intent.tabId).toBe(targetTab)
          }
        }
      }
    }
  })
})

describe('getSettingsContentLayout：教程页自带滚动容器，避免与设置外层 ScrollArea 双层滚动', () => {
  test('给定教程页 当决定内容承载方式 则由页面自己滚动', () => {
    expect(getSettingsContentLayout('tutorial')).toBe('self-scroll')
  })

  test('给定其余设置页 当决定内容承载方式 则仍套统一的 ScrollArea', () => {
    for (const tab of ALL_SETTINGS_TABS.filter((item) => item !== 'tutorial')) {
      expect(getSettingsContentLayout(tab)).toBe('scroll-area')
    }
  })
})

describe('SettingsPanel 接线守卫：导航不能再产生主区副作用', () => {
  // 纯函数本身不可能跳走；真正的回归风险是有人在面板里重新加回「点教程 → openTab + 关设置」。
  const source = require('node:fs').readFileSync(require('node:path').join(import.meta.dir, 'SettingsPanel.tsx'), 'utf8') as string

  test('给定设置面板源码，当检查导航处理时，则经 resolveSettingsNavigation 分派', () => {
    expect(source).toContain('resolveSettingsNavigation(')
  })

  test('给定设置面板源码，当检查依赖时，则不引用会改主区 Tab / 视图 / 关闭设置的 atom', () => {
    for (const name of ['openTab', 'tabsAtom', 'activeTabIdAtom', 'settingsOpenAtom', 'activeViewAtom', 'automationFormAtom']) {
      expect(source.includes(name)).toBe(false)
    }
  })
})
