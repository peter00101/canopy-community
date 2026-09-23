import { describe, expect, test } from 'bun:test'
import { shouldBlockToolForAskUserQuestion } from './pi-agent-adapter'

/**
 * 上游 #1716（随 v0.17.42 并入）：模型把 AskUserQuestion 和别的工具放进同一批次时，
 * 其余工具必须被拦下——否则会出现「一边问用户一边继续干活」，用户答完发现事情已经做了。
 */
describe('AskUserQuestion 同批次阻塞（beforeToolCall 守卫）', () => {
  test('Given 批次里同时有 AskUserQuestion 和 Bash, When 判定 Bash, Then 阻塞', () => {
    expect(shouldBlockToolForAskUserQuestion(['AskUserQuestion', 'Bash'], 'Bash')).toBe(true)
  })

  test('Given 同一批次, When 判定 AskUserQuestion 自己, Then 放行（提问本身要执行）', () => {
    expect(shouldBlockToolForAskUserQuestion(['AskUserQuestion', 'Bash'], 'AskUserQuestion')).toBe(false)
  })

  test('Given 批次里只有 AskUserQuestion 一个工具, When 判定, Then 不阻塞', () => {
    expect(shouldBlockToolForAskUserQuestion(['AskUserQuestion'], 'AskUserQuestion')).toBe(false)
  })

  test('Given 批次里没有 AskUserQuestion, When 判定普通工具, Then 不阻塞', () => {
    expect(shouldBlockToolForAskUserQuestion(['Read', 'Bash'], 'Bash')).toBe(false)
  })
})
