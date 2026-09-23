import { describe, expect, it } from 'bun:test'
import {
  getRightPanelTabCloseButtonClassName,
  getRightPanelTabCloseButtonVisibilityClass,
  type RightPanelTabCloseButtonState,
} from './right-panel-tab-close-button'

const ALL_STATES: Array<[string, RightPanelTabCloseButtonState]> = [
  ['未选中标签', { sharedSplit: false, selected: false, groupHovered: false }],
  ['未选中标签且鼠标在标签上', { sharedSplit: false, selected: false, groupHovered: true }],
  ['选中标签', { sharedSplit: false, selected: true, groupHovered: false }],
  ['并排组未悬停', { sharedSplit: true, selected: false, groupHovered: false }],
  ['并排组悬停', { sharedSplit: true, selected: true, groupHovered: true }],
]

/** 从类名里挑出会影响盒尺寸的工具类（宽度 / 外边距 / 含 width 或 margin 的过渡） */
function layoutAffectingClasses(className: string): string[] {
  return className
    .split(/\s+/)
    .filter((token) => /^(?:[a-z-]+:)*(?:w-|mr-|ml-|transition-\[[^\]]*(?:width|margin))/.test(token))
    .sort()
}

describe('右侧工作区标签关闭按钮：悬停不改变标签宽度', () => {
  it('Given 任意状态，When 取类名，Then 尺寸相关的类完全相同（宽度不随悬停 / 选中变化）', () => {
    for (const [, state] of ALL_STATES) {
      expect(layoutAffectingClasses(getRightPanelTabCloseButtonClassName(state))).toEqual(['mr-1', 'w-7'])
    }
  })

  it('Given 任意状态，When 取类名，Then 不再出现 0 宽、悬停变宽或 width/margin 过渡', () => {
    for (const [, state] of ALL_STATES) {
      const className = getRightPanelTabCloseButtonClassName(state)
      expect(className).not.toMatch(/(?:^|\s)(?:[a-z-]+:)*w-0(?:\s|$)/)
      expect(className).not.toMatch(/(?:^|\s)(?:[a-z-]+:)*mr-0(?:\s|$)/)
      expect(className).not.toMatch(/group-hover:(?:w|mr)-/)
      expect(className).not.toMatch(/transition-\[[^\]]*(?:width|margin)/)
    }
  })

  it('Given 未选中标签，When 鼠标没进入标签，Then 按钮透明；进入后靠 group-hover 显示', () => {
    const visibility = getRightPanelTabCloseButtonVisibilityClass({ sharedSplit: false, selected: false, groupHovered: false })
    expect(visibility).toContain('opacity-0')
    expect(visibility).toContain('group-hover:opacity-60')
  })

  it('Given 选中标签，When 取可见性类，Then 常显（半透明，悬停按钮本身时不透明）', () => {
    const visibility = getRightPanelTabCloseButtonVisibilityClass({ sharedSplit: false, selected: true, groupHovered: false })
    expect(visibility).toBe('opacity-60 hover:opacity-100')
  })

  it('Given 并排共用的退出按钮，When 标签组未悬停 / 已悬停，Then 分别为透明 / 显示', () => {
    expect(getRightPanelTabCloseButtonVisibilityClass({ sharedSplit: true, selected: true, groupHovered: false })).toBe('opacity-0')
    expect(getRightPanelTabCloseButtonVisibilityClass({ sharedSplit: true, selected: true, groupHovered: true })).toBe('opacity-60 hover:opacity-100')
  })

  it('Given 并排共用按钮，When selected 取任意值，Then 只看 groupHovered（selected 不参与判断）', () => {
    const hovered = { sharedSplit: true, groupHovered: true }
    expect(getRightPanelTabCloseButtonVisibilityClass({ ...hovered, selected: false }))
      .toBe(getRightPanelTabCloseButtonVisibilityClass({ ...hovered, selected: true }))
  })
})
