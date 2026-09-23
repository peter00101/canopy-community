import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 删会话必须顺带关掉它的受管浏览器（收上游 #2078）。
 *
 * ipc.ts 按 AGENTS.md 约定零单测、handler 又依赖 Electron，没法在单测里真跑；
 * 按仓库调用点守卫的惯例钉源码结构，行为本身由 dev 真机 E2E 覆盖。
 */
const source = readFileSync(join(import.meta.dir, 'ipc.ts'), 'utf-8')

function sliceBetween(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker)
  expect(start).toBeGreaterThan(-1)
  const end = text.indexOf(endMarker, start)
  expect(end).toBeGreaterThan(start)
  return text.slice(start, end)
}

function expectBrowserClosedBeforeDelete(block: string, sessionVar: string): void {
  const closeIndex = block.indexOf(`await browserController.close(${sessionVar})`)
  const deleteIndex = block.indexOf(`deleteAgentSession(${sessionVar})`)
  expect(closeIndex).toBeGreaterThan(-1)
  expect(deleteIndex).toBeGreaterThan(closeIndex)
}

describe('删会话时关掉受管浏览器', () => {
  test('Given 删除整个项目 When 逐个删除其会话 Then 每个会话都先关浏览器再删', () => {
    // ipc.ts 是 CRLF 行尾，不用换行符做锚点；以紧随其后的定时任务清理循环为界
    const loop = sliceBetween(source, 'for (const sessionId of affectedSessionIds) {', 'for (const automationId of affectedAutomationIds)')
    expectBrowserClosedBeforeDelete(loop, 'sessionId')
  })

  test('Given 删除单个会话 When 收尾 Then 同样先关浏览器再删（既有行为不回退）', () => {
    const handler = sliceBetween(source, 'await stopAgentAndDrain(id)', 'releaseAttachedFileWatchers(attachedFiles)')
    expectBrowserClosedBeforeDelete(handler, 'id')
  })
})
