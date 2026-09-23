import { describe, expect, test } from 'bun:test'
import {
  computeHeadingScrollTop,
  getTutorialCurrentSectionLabel,
  getTutorialTocMinLevel,
  resolveTutorialTocOpen,
  resolveTutorialTocPlacement,
  toTutorialTocEntries,
  TUTORIAL_SIDE_TOC_MIN_WIDTH,
} from './tutorial-reader-layout'

describe('resolveTutorialTocPlacement：目录按阅读器宽度摆放', () => {
  test('给定最小窗口下的设置内容区（约 580px） 当决定目录位置 则收到顶部', () => {
    expect(resolveTutorialTocPlacement(580)).toBe('top')
  })

  test('给定刚好达到阈值的宽度 当决定目录位置 则放侧栏', () => {
    expect(resolveTutorialTocPlacement(TUTORIAL_SIDE_TOC_MIN_WIDTH)).toBe('side')
    expect(resolveTutorialTocPlacement(TUTORIAL_SIDE_TOC_MIN_WIDTH - 1)).toBe('top')
  })

  test('给定宽屏设置内容区（1600px） 当决定目录位置 则放侧栏', () => {
    expect(resolveTutorialTocPlacement(1600)).toBe('side')
  })

  test('给定尚未量到宽度（0 / NaN） 当决定目录位置 则按窄屏处理，不先把侧栏挤进去', () => {
    expect(resolveTutorialTocPlacement(0)).toBe('top')
    expect(resolveTutorialTocPlacement(Number.NaN)).toBe('top')
  })
})

describe('resolveTutorialTocOpen：窄宽度默认收起，宽屏默认展开，用户手动开关优先', () => {
  test('给定用户没动过 当目录在顶部 则默认收起', () => {
    expect(resolveTutorialTocOpen('top', null)).toBe(false)
  })

  test('给定用户没动过 当目录在侧栏 则默认展开', () => {
    expect(resolveTutorialTocOpen('side', null)).toBe(true)
  })

  test('给定用户在侧栏收起了目录 当仍是侧栏 则保持收起', () => {
    expect(resolveTutorialTocOpen('side', { placement: 'side', open: false })).toBe(false)
  })

  test('给定用户在顶部展开了目录 当窗口拉宽变成侧栏 则回到侧栏默认值', () => {
    expect(resolveTutorialTocOpen('side', { placement: 'top', open: true })).toBe(true)
  })

  test('给定用户在侧栏展开过目录 当窗口拉窄变成顶部 则回到顶部默认收起，不遮正文首屏', () => {
    expect(resolveTutorialTocOpen('top', { placement: 'side', open: true })).toBe(false)
  })
})

describe('目录条目与当前章节', () => {
  const headings = [
    { id: 'canopy-使用教程', level: 1, text: 'Canopy 使用教程' },
    { id: '先认识界面', level: 2, text: '先认识界面' },
    { id: '输入框的五个触发符', level: 3, text: '输入框的五个触发符' },
  ]

  test('给定渲染出的标题 当转成目录条目 则保留 id / 层级 / 文本并按顺序编号', () => {
    expect(toTutorialTocEntries(headings)).toEqual([
      { id: 'canopy-使用教程', level: 1, text: 'Canopy 使用教程', line: 0 },
      { id: '先认识界面', level: 2, text: '先认识界面', line: 1 },
      { id: '输入框的五个触发符', level: 3, text: '输入框的五个触发符', line: 2 },
    ])
  })

  test('给定滚动联动命中某个标题 当取当前章节 则返回该标题文本', () => {
    const entries = toTutorialTocEntries(headings)
    expect(getTutorialCurrentSectionLabel(entries, '先认识界面')).toBe('先认识界面')
  })

  test('给定没有命中或命中的标题已不在目录里 当取当前章节 则不显示', () => {
    const entries = toTutorialTocEntries(headings)
    expect(getTutorialCurrentSectionLabel(entries, null)).toBeNull()
    expect(getTutorialCurrentSectionLabel(entries, '已删除的章节')).toBeNull()
  })

  test('给定目录条目 当算缩进基准 则取最浅一级；空目录回落到 1', () => {
    expect(getTutorialTocMinLevel(toTutorialTocEntries(headings.slice(1)))).toBe(2)
    expect(getTutorialTocMinLevel([])).toBe(1)
  })
})

describe('computeHeadingScrollTop：目录跳转滚到标题处', () => {
  test('给定标题在容器下方 600px 且已滚动 200px 当跳转 则滚到 792（留 8px 空隙）', () => {
    expect(computeHeadingScrollTop({ headingTop: 700, containerTop: 100, scrollTop: 200 })).toBe(792)
  })

  test('给定标题已在容器顶部之上 当跳转 则向上滚回标题处', () => {
    expect(computeHeadingScrollTop({ headingTop: -300, containerTop: 100, scrollTop: 1000, offset: 0 })).toBe(600)
  })

  test('给定第一个标题紧贴容器顶部 当跳转 则不会算出负数', () => {
    expect(computeHeadingScrollTop({ headingTop: 102, containerTop: 100, scrollTop: 0 })).toBe(0)
  })

  test('给定亚像素坐标 当跳转 则取整', () => {
    expect(computeHeadingScrollTop({ headingTop: 250.6, containerTop: 100.2, scrollTop: 10, offset: 8 })).toBe(152)
  })

  test('给定异常坐标 当跳转 则回到顶部而不是 NaN', () => {
    expect(computeHeadingScrollTop({ headingTop: Number.NaN, containerTop: 0, scrollTop: 0 })).toBe(0)
  })
})
