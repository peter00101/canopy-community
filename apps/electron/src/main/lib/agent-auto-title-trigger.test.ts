import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_AGENT_SESSION_TITLE, normalizeSessionTitle } from '@canopy/kernel'

/**
 * 自动命名触发点的结构守卫（上游 #2066）。
 *
 * `AgentOrchestrator.sendMessage` 是个依赖 Electron / Pi SDK / 渠道的巨型方法，没法在单测里真跑；
 * 触发点的位置又恰恰是这次修的东西——所以按仓库里调用点守卫的惯例直接钉源码结构，
 * 行为本身由 dev 真机 E2E 覆盖。
 */
const source = readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf-8')

function sliceBetween(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker)
  expect(start).toBeGreaterThan(-1)
  const end = text.indexOf(endMarker, start)
  expect(end).toBeGreaterThan(start)
  return text.slice(start, end)
}

describe('Agent 会话自动命名的触发点（上游 #2066）', () => {
  test('Given 编排器源码 When 看 Pi onSessionId 回调 Then 里面不再触发自动命名', () => {
    const handleSessionId = sliceBetween(source, 'const handleSessionId = (', 'const handleModelResolved = (')
    expect(handleSessionId).not.toContain('startAutoTitleGeneration')
  })

  test('Given 编排器源码 When 数触发次数 Then 只触发一次：运行参数装配完之后、遍历事件流之前', () => {
    const calls = [...source.matchAll(/^\s*startAutoTitleGeneration\(\)\s*$/gm)]
    expect(calls).toHaveLength(1)

    const callIndex = calls[0]!.index!
    // 运行参数里把 handleSessionId 交给 adapter 的那一行：触发点必须在它之后（不在回调定义里）
    const queryOptionsIndex = source.indexOf('onSessionId: handleSessionId,')
    const streamLoopIndex = source.indexOf('开始通过 Adapter 遍历事件流')
    expect(queryOptionsIndex).toBeGreaterThan(-1)
    expect(streamLoopIndex).toBeGreaterThan(queryOptionsIndex)
    expect(callIndex).toBeGreaterThan(queryOptionsIndex)
    expect(callIndex).toBeLessThan(streamLoopIndex)
  })

  test('Given 同一轮里可能回退重试 When 再次走到触发点 Then 有一次性守卫，不会并发起多个标题请求', () => {
    const definition = sliceBetween(source, 'const startAutoTitleGeneration = (): void =>', 'const handleSessionId = (')
    expect(definition).toContain('if (titleGenerationStarted) return')
    expect(definition).toContain('titleGenerationStarted = true')
  })

  test('Given 标题生成的入参 When 选文本 Then 用清洗后的 userMessage，不用带引用标记的展示原文', () => {
    const definition = sliceBetween(source, 'const startAutoTitleGeneration = (): void =>', 'const handleSessionId = (')
    expect(definition).toContain('this.autoGenerateTitle(sessionId, userMessage, channelId, resolvedModel, callbacks)')
  })
})

describe('自动命名的触发条件与内核默认标题同源', () => {
  test('Given 编排器判断「是否仍是默认标题」 When 取常量 Then 引用内核的 DEFAULT_AGENT_SESSION_TITLE，不再另写字面量', () => {
    expect(source).toContain('const DEFAULT_SESSION_TITLE = DEFAULT_AGENT_SESSION_TITLE')
    expect(source).not.toMatch(/const DEFAULT_SESSION_TITLE = ['"]/)
  })

  test('Given 建会话时不传标题（IM 桥接 / 桌面新建） When 内核归一化 Then 得到的正是触发自动命名的那个默认标题', () => {
    expect(normalizeSessionTitle(undefined)).toBe(DEFAULT_AGENT_SESSION_TITLE)
    expect(normalizeSessionTitle('   ')).toBe(DEFAULT_AGENT_SESSION_TITLE)
    expect(normalizeSessionTitle('季度汇报')).toBe('季度汇报')
  })
})
