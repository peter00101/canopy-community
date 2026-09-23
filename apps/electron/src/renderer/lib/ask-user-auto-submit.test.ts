import { describe, expect, it } from 'bun:test'
import {
  ASK_USER_AUTO_ADVANCE_DELAY_MS,
  ASK_USER_AUTO_SUBMIT_DELAY_MS,
  decideAskUserAdvance,
  shouldShowAskUserConfirmButton,
  type AskUserTabState,
} from './ask-user-auto-submit'

function state(overrides: Partial<AskUserTabState> = {}): AskUserTabState {
  return { isLastTab: true, multiSelect: false, showCustom: false, selectedCount: 1, ...overrides }
}

describe('decideAskUserAdvance — 选中选项后的去向', () => {
  it('Given 最后一题且单选，When 选中选项，Then 自动提交（维护者要的「不用再点确定」）', () => {
    expect(decideAskUserAdvance(state())).toBe('submit')
  })

  it('Given 不是最后一题且单选，When 选中选项，Then 仍按既有行为跳下一题', () => {
    expect(decideAskUserAdvance(state({ isLastTab: false }))).toBe('next')
  })

  it('Given 多选题，When 勾选，Then 一律等用户点确认——程序无法判断他勾完没有', () => {
    expect(decideAskUserAdvance(state({ multiSelect: true }))).toBe('wait')
    expect(decideAskUserAdvance(state({ multiSelect: true, isLastTab: false }))).toBe('wait')
  })

  it('Given 正在填「其他」自定义文本，When 判定，Then 绝不替用户提交', () => {
    expect(decideAskUserAdvance(state({ showCustom: true }))).toBe('wait')
  })

  it('Given 多选且在填自定义，When 判定，Then 仍是等待', () => {
    expect(decideAskUserAdvance(state({ multiSelect: true, showCustom: true }))).toBe('wait')
  })
})

describe('shouldShowAskUserConfirmButton — 确认按钮的去留', () => {
  it('Given 最后一题单选且已选中，When 渲染，Then 收起按钮（自动提交已在路上）', () => {
    expect(shouldShowAskUserConfirmButton(state({ selectedCount: 1 }))).toBe(false)
  })

  it('Given 最后一题单选但一个都没选，When 渲染，Then 仍要给按钮——否则用户无法提交前面几题的答案', () => {
    expect(shouldShowAskUserConfirmButton(state({ selectedCount: 0 }))).toBe(true)
  })

  it('Given 最后一题是多选，When 渲染，Then 保留按钮', () => {
    expect(shouldShowAskUserConfirmButton(state({ multiSelect: true, selectedCount: 3 }))).toBe(true)
    expect(shouldShowAskUserConfirmButton(state({ multiSelect: true, selectedCount: 0 }))).toBe(true)
  })

  it('Given 最后一题展开了自定义输入，When 渲染，Then 保留按钮', () => {
    expect(shouldShowAskUserConfirmButton(state({ showCustom: true, selectedCount: 0 }))).toBe(true)
  })

  it('Given 不是最后一题，When 渲染，Then 不显示（维持既有：靠 Enter / 点 Tab 翻页）', () => {
    expect(shouldShowAskUserConfirmButton(state({ isLastTab: false }))).toBe(false)
    expect(shouldShowAskUserConfirmButton(state({ isLastTab: false, multiSelect: true }))).toBe(false)
  })

  it('Given 任意题面状态，When 同时问两个判定，Then 「自动提交」与「显示按钮」互斥，用户不会既被自动交又看到按钮', () => {
    const combos: AskUserTabState[] = []
    for (const isLastTab of [true, false]) {
      for (const multiSelect of [true, false]) {
        for (const showCustom of [true, false]) {
          for (const selectedCount of [0, 1, 2]) {
            combos.push({ isLastTab, multiSelect, showCustom, selectedCount })
          }
        }
      }
    }
    for (const combo of combos) {
      const autoSubmits = decideAskUserAdvance(combo) === 'submit'
      if (autoSubmits && combo.selectedCount > 0) {
        expect(shouldShowAskUserConfirmButton(combo)).toBe(false)
      }
    }
  })
})

describe('延迟常量', () => {
  it('Given 可改口窗口，When 取值，Then 比自动翻页长，够用户反悔又不至于卡顿', () => {
    expect(ASK_USER_AUTO_SUBMIT_DELAY_MS).toBe(400)
    expect(ASK_USER_AUTO_SUBMIT_DELAY_MS).toBeGreaterThan(ASK_USER_AUTO_ADVANCE_DELAY_MS)
  })
})
