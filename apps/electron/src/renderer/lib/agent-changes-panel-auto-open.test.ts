import { describe, expect, test } from 'bun:test'
import { shouldAutoOpenChangesPanel } from './agent-changes-panel-auto-open'

/** 五个入参的默认组合：设置开启、当前会话、本轮首次、用户没在看预览。 */
const BASE = {
  enabled: true as boolean | undefined,
  isCurrentSession: true,
  alreadyActivatedForRun: false,
  isViewingPreview: false,
}

describe('改动文件时自动打开侧面板（用户可关）', () => {
  test('Given 设置开启且是当前会话首次改动, When 判定, Then 弹出（默认行为不变）', () => {
    expect(shouldAutoOpenChangesPanel({ ...BASE })).toBe(true)
  })

  test('Given 设置项缺省（老配置没写过）, When 判定, Then 按开启处理', () => {
    expect(shouldAutoOpenChangesPanel({ ...BASE, enabled: undefined })).toBe(true)
  })

  test('Given 用户关掉了自动打开, When 当前会话有改动, Then 不弹（改动仍由调用方记录进标签）', () => {
    expect(shouldAutoOpenChangesPanel({ ...BASE, enabled: false })).toBe(false)
  })

  test('Given 后台会话产生改动, When 判定, Then 不弹（不打扰正在看别的会话的用户）', () => {
    expect(shouldAutoOpenChangesPanel({ ...BASE, isCurrentSession: false })).toBe(false)
  })

  test('Given 本轮已经弹过一次, When 同一 run 再有改动, Then 不重复弹', () => {
    expect(shouldAutoOpenChangesPanel({ ...BASE, alreadyActivatedForRun: true })).toBe(false)
  })
})

describe('正在看预览时不抢面板（0.18.67 维护者报障）', () => {
  test('Given 用户正盯着某个文件预览, When Agent 改了文件, Then 不抢面板（预览留在前台自己刷新）', () => {
    expect(shouldAutoOpenChangesPanel({ ...BASE, isViewingPreview: true })).toBe(false)
  })

  test('Given 用户看的是会话正文而非预览, When Agent 改了文件, Then 照常弹出改动面板', () => {
    expect(shouldAutoOpenChangesPanel({ ...BASE, isViewingPreview: false })).toBe(true)
  })

  test('Given 正在看预览且设置也已关闭, When Agent 改了文件, Then 仍不弹（两条互不抵消）', () => {
    expect(shouldAutoOpenChangesPanel({ ...BASE, enabled: false, isViewingPreview: true })).toBe(false)
  })

  test('Given 正在看的是别的会话的预览, When 后台会话改了文件, Then 不弹（会话判定优先）', () => {
    expect(shouldAutoOpenChangesPanel({ ...BASE, isCurrentSession: false, isViewingPreview: true })).toBe(false)
  })
})
