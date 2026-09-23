import { describe, expect, test } from 'bun:test'
import { resolveDisplayContextWindow } from './context-window-resolve'

/**
 * 维护者 2026-09-09 报的场景：会话用 deepseek-v4-flash（1,000,000）跑过，
 * 输入框切成 gpt-5.6-sol（372,000）之后，进度环仍按 1.0M 算。
 */
describe('resolveDisplayContextWindow：进度环分母跟着当前模型走', () => {
  test('Given 切到小窗口模型 When 上一轮实测窗口更大 Then 按当前模型算而不是沿用上一轮', () => {
    expect(resolveDisplayContextWindow({
      currentModelId: 'gpt-5.6-sol',
      reportedWindow: 1_000_000,
      fallbackModelId: 'deepseek-v4-flash',
    })).toBe(372_000)
  })

  test('Given 切到大窗口模型 When 上一轮实测窗口更小 Then 同样按当前模型算', () => {
    expect(resolveDisplayContextWindow({
      currentModelId: 'deepseek-v4-flash',
      reportedWindow: 272_000,
      fallbackModelId: 'gpt-5.5',
    })).toBe(1_000_000)
  })

  test('Given 当前模型与产生用量的模型一致 When 解析 Then 结果就是该模型的窗口', () => {
    expect(resolveDisplayContextWindow({
      currentModelId: 'gpt-5.5',
      reportedWindow: 272_000,
      fallbackModelId: 'gpt-5.5',
    })).toBe(272_000)
  })

  test('Given 当前模型未知 When 有上一轮实测值 Then 回落实测值', () => {
    expect(resolveDisplayContextWindow({
      currentModelId: null,
      reportedWindow: 456_789,
      fallbackModelId: 'gpt-5.5',
    })).toBe(456_789)
  })

  test('Given 当前模型与实测值都没有 When 有历史消息模型 Then 用它推断', () => {
    expect(resolveDisplayContextWindow({ fallbackModelId: 'gpt-5.5' })).toBe(272_000)
  })

  test('Given 三路都没有 When 解析 Then 返回 undefined，让调用方隐藏进度环', () => {
    expect(resolveDisplayContextWindow({})).toBeUndefined()
  })

  test('Given 空字符串模型 id When 解析 Then 不当作已知模型，回落实测值', () => {
    expect(resolveDisplayContextWindow({ currentModelId: '', reportedWindow: 123_456 })).toBe(123_456)
  })
})
