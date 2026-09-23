import { describe, expect, it } from 'bun:test'
import {
  focusStealKey,
  shouldMarkTabUnread,
  shouldStealSidePanelFocus,
  type AgentFocusStealInput,
} from './agent-focus-steal'

function input(overrides: Partial<AgentFocusStealInput> = {}): AgentFocusStealInput {
  return { isCurrentSession: true, userPinnedTab: false, alreadyStolenForRun: false, ...overrides }
}

describe('shouldStealSidePanelFocus — Agent 能不能抢右侧工作区焦点', () => {
  it('Given 用户已手点过标签，When Agent 想切，Then 一次都不许抢（维护者点名的核心诉求）', () => {
    expect(shouldStealSidePanelFocus(input({ userPinnedTab: true }))).toBe(false)
  })

  it('Given 用户手点过标签且本 run 还没抢过，When Agent 想切，Then 依然不许——手点优先级最高', () => {
    expect(shouldStealSidePanelFocus(input({ userPinnedTab: true, alreadyStolenForRun: false }))).toBe(false)
  })

  it('Given 用户还没表态的新会话，When Agent 本 run 首次开浏览器，Then 允许带他看一眼', () => {
    expect(shouldStealSidePanelFocus(input())).toBe(true)
  })

  it('Given 同一 run 内该来源已抢过，When Agent 再次切换，Then 不再抢（连开五个网页只抢第一次）', () => {
    expect(shouldStealSidePanelFocus(input({ alreadyStolenForRun: true }))).toBe(false)
  })

  it('Given 事件来自后台会话，When 判定，Then 永远不抢，哪怕用户没表态过', () => {
    expect(shouldStealSidePanelFocus(input({ isCurrentSession: false }))).toBe(false)
    expect(shouldStealSidePanelFocus(input({ isCurrentSession: false, userPinnedTab: false }))).toBe(false)
  })
})

describe('focusStealKey — 按来源分开记账', () => {
  it('Given 同一会话的不同来源，When 生成记账键，Then 互不干扰：浏览器抢过后终端仍可抢一次', () => {
    expect(focusStealKey('s1', 'browser')).not.toBe(focusStealKey('s1', 'terminal'))
  })

  it('Given 不同会话的同一来源，When 生成记账键，Then 彼此独立', () => {
    expect(focusStealKey('s1', 'browser')).not.toBe(focusStealKey('s2', 'browser'))
  })

  it('Given 同一会话同一来源，When 重复生成，Then 键稳定，可用于比对 runId', () => {
    expect(focusStealKey('s1', 'changes')).toBe(focusStealKey('s1', 'changes'))
  })
})

describe('shouldMarkTabUnread — 没抢到焦点时的提示', () => {
  it('Given 当前会话且没抢到焦点，When 判定，Then 打未读点让用户知道那边有动静', () => {
    expect(shouldMarkTabUnread({ stoleFocus: false })).toBe(true)
  })

  it('Given 抢到了焦点，When 判定，Then 不打未读——用户已经看见了', () => {
    expect(shouldMarkTabUnread({ stoleFocus: true })).toBe(false)
  })

  it('Given 后台会话（必然抢不到焦点），When 判定，Then 照样打未读——切回去时这是唯一线索', () => {
    const stoleFocus = shouldStealSidePanelFocus(input({ isCurrentSession: false }))
    expect(stoleFocus).toBe(false)
    expect(shouldMarkTabUnread({ stoleFocus })).toBe(true)
  })

  it('Given 任意组合，When 同时问两个判定，Then 「抢到焦点」与「打未读」互斥，二者必居其一', () => {
    for (const isCurrentSession of [true, false]) {
      for (const userPinnedTab of [true, false]) {
        for (const alreadyStolenForRun of [true, false]) {
          const stoleFocus = shouldStealSidePanelFocus({ isCurrentSession, userPinnedTab, alreadyStolenForRun })
          const marksUnread = shouldMarkTabUnread({ stoleFocus })
          expect(stoleFocus && marksUnread).toBe(false)
          expect(stoleFocus || marksUnread).toBe(true)
        }
      }
    }
  })

  it('Given 用户锁死了标签的当前会话，When Agent 有动静，Then 必定走「不抢 + 打未读」这条路', () => {
    const stoleFocus = shouldStealSidePanelFocus(input({ userPinnedTab: true }))
    expect(stoleFocus).toBe(false)
    expect(shouldMarkTabUnread({ stoleFocus })).toBe(true)
  })
})
