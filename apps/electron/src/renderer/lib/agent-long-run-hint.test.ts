import { describe, expect, test } from 'bun:test'
import { LONG_RUN_HINT_AFTER_SECONDS, LONG_RUN_STRONG_HINT_AFTER_SECONDS, buildLongRunHint } from './agent-long-run-hint'

describe('长任务运行提示', () => {
  test('Given 运行未到阈值 When 生成 Then 不提示（正常任务不打扰）', () => {
    expect(buildLongRunHint(0)).toBeNull()
    expect(buildLongRunHint(LONG_RUN_HINT_AFTER_SECONDS - 1)).toBeNull()
    expect(buildLongRunHint(Number.NaN)).toBeNull()
  })

  test('Given 运行到达提示阈值 When 生成 Then 给出条件句提示并带整分钟数', () => {
    const hint = buildLongRunHint(LONG_RUN_HINT_AFTER_SECONDS + 30)
    expect(hint).toMatchObject({ level: 'notice', minutes: 8 })
    expect(hint?.text).toContain('若')
    expect(hint?.text).toContain('停止')
  })

  test('Given 运行超过强提示阈值 When 生成 Then 升级措辞', () => {
    const hint = buildLongRunHint(LONG_RUN_STRONG_HINT_AFTER_SECONDS + 5)
    expect(hint).toMatchObject({ level: 'strong', minutes: 25 })
    expect(hint?.text).toContain('很可能')
  })

  test('阈值关系：提示阈值早于 bash 默认超时（10 分钟）出现，强提示更晚', () => {
    expect(LONG_RUN_HINT_AFTER_SECONDS).toBeLessThan(600)
    expect(LONG_RUN_STRONG_HINT_AFTER_SECONDS).toBeGreaterThan(LONG_RUN_HINT_AFTER_SECONDS)
  })
})
