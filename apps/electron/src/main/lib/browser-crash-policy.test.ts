import { describe, expect, test } from 'bun:test'
import { describeBrowserRendererCrash, isBrowserRendererCrash } from './browser-crash-policy'

describe('受管浏览器 view 崩溃判定', () => {
  test('Given 正常退出 clean-exit（关标签 / 导航换进程） When 判定 Then 不算崩溃', () => {
    expect(isBrowserRendererCrash('clean-exit')).toBe(false)
  })

  test('Given oom / crashed / killed / launch-failed / abnormal-exit / integrity-failure When 判定 Then 全部算崩溃', () => {
    for (const reason of ['oom', 'crashed', 'killed', 'launch-failed', 'abnormal-exit', 'integrity-failure']) {
      expect(isBrowserRendererCrash(reason)).toBe(true)
    }
  })

  test('Given 未来 Electron 新增的未知 reason When 判定 Then 保守地算崩溃（宁可多记一条日志）', () => {
    expect(isBrowserRendererCrash('some-new-reason')).toBe(true)
  })
})

describe('崩溃文案', () => {
  test('Given oom 且带退出码 When 生成文案 Then 活动条一句话含原因与退出码，Agent 文案含下一步指令', () => {
    const text = describeBrowserRendererCrash('oom', 137)

    expect(text.trace).toBe('页面内存耗尽被系统终止，退出码 137，该标签当前无法操作')
    expect(text.agentError).toContain('页面内存耗尽被系统终止，退出码 137')
    expect(text.agentError).toContain('BrowserNavigate')
    expect(text.agentError).toContain('BrowserCloseTab')
    expect(text.agentError).toContain('不要重复发送')
  })

  test('Given 未知 reason 且无退出码 When 生成文案 Then 回退为通用描述且不带退出码', () => {
    const text = describeBrowserRendererCrash('mystery')

    expect(text.trace).toBe('页面进程已退出（mystery），该标签当前无法操作')
    expect(text.trace).not.toContain('退出码')
  })
})
