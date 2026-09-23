/**
 * 按访问路径激活项目指令的 BDD 测试（Pi 0.86 适配，收上游 #2081 时我方改写）。
 *
 * 机制：工具首次访问带未送达 AGENTS.md 的子目录 → 拦下这次调用 → 下一次调用模型前把指令追加到
 * system prompt → 模型重试时放行。Pi 0.86 的 AgentContext 已没有 systemPrompt 字段，注入点改为
 * 每次调用模型前的 context 事件；上游改用 before_agent_start（每轮 run 只在开头触发一次），
 * 被拦下的指令永远送不到——这里钉住「同一轮内重试就能放行」这条线。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveProjectInstructions } from '@canopy/kernel'
import { ProjectInstructionScopeController } from './pi-project-instruction-scope'

let projectRoot: string

beforeEach(() => {
  // macOS 的 tmpdir 在 /var → /private/var 软链下，先 realpath（同款夹具口径）
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'canopy-instruction-scope-')))
  writeFileSync(join(projectRoot, 'AGENTS.md'), '# 根规则\n所有回复用中文。\n')
  mkdirSync(join(projectRoot, 'sub'))
  writeFileSync(join(projectRoot, 'sub', 'AGENTS.md'), '# 子目录规则\n回复以【子】开头。\n')
  writeFileSync(join(projectRoot, 'sub', 'data.txt'), 'hello\n')
})

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true })
})

function createController(): ProjectInstructionScopeController {
  const initial = resolveProjectInstructions({ projectRoot })
  return new ProjectInstructionScopeController({ projectRoot, cwd: projectRoot, initialSources: initial.sources })
}

function transcript(systemContent: string | Array<{ type: string; text?: string }> = '基础系统提示'): Array<Record<string, unknown>> {
  return [
    { role: 'system', content: systemContent, timestamp: 1 },
    { role: 'user', content: '读一下 sub/data.txt', timestamp: 2 },
  ]
}

function systemText(messages: readonly Record<string, unknown>[]): string {
  const content = messages[0]?.content
  return typeof content === 'string'
    ? content
    : (content as Array<{ text?: string }>).map((part) => part.text ?? '').join('')
}

describe('按访问路径激活项目指令', () => {
  test('Given 子目录有未送达的 AGENTS.md When 首次读取其中文件 Then 拦下这次调用并提示下一轮重试', () => {
    const controller = createController()
    const decision = controller.beforeToolCall({ toolName: 'read', input: { path: 'sub/data.txt' } })
    expect(decision?.block).toBe(true)
    expect(decision?.reason).toContain('下一轮')
  })

  test('Given 指令已被拦下挂起 When 下一次调用模型 Then system prompt 末尾带上子目录指令，其余消息不动', () => {
    const controller = createController()
    controller.beforeToolCall({ toolName: 'read', input: { path: 'sub/data.txt' } })
    const messages = transcript()

    const injected = controller.injectActivatedInstructions(messages)

    expect(injected).not.toBe(messages)
    expect(systemText(injected)).toStartWith('基础系统提示\n\n## 已按访问路径激活的项目指令')
    expect(systemText(injected)).toContain('source="sub/AGENTS.md"')
    expect(systemText(injected)).toContain('回复以【子】开头')
    expect(injected[1]).toBe(messages[1])
    // 不改动入参：Pi 给的是本次请求的副本，这里依然按不可变方式替换
    expect(messages[0]?.content).toBe('基础系统提示')
  })

  test('Given 指令已随上一次请求送出 When 模型在同一轮里重试同一个读取 Then 放行（上游 before_agent_start 方案在这里会被一直拦）', () => {
    const controller = createController()
    controller.beforeToolCall({ toolName: 'read', input: { path: 'sub/data.txt' } })
    controller.injectActivatedInstructions(transcript())

    expect(controller.beforeToolCall({ toolName: 'read', input: { path: 'sub/data.txt' } })).toBeUndefined()
  })

  test('Given 指令被拦下后一直没有注入（上游 before_agent_start 在 run 中途不触发） When 重试 Then 仍被拦——注入是放行的前提', () => {
    const controller = createController()
    controller.beforeToolCall({ toolName: 'read', input: { path: 'sub/data.txt' } })
    expect(controller.beforeToolCall({ toolName: 'read', input: { path: 'sub/data.txt' } })?.block).toBe(true)
  })

  test('Given 本轮已激活过指令 When 之后每次调用模型 Then 都继续带着（context 事件逐次生效、不落记录）', () => {
    const controller = createController()
    controller.beforeToolCall({ toolName: 'read', input: { path: 'sub/data.txt' } })
    controller.injectActivatedInstructions(transcript())

    const laterTurn = controller.injectActivatedInstructions(transcript())
    expect(systemText(laterTurn)).toContain('回复以【子】开头')
    expect(systemText(laterTurn).match(/source="sub\/AGENTS\.md"/g)).toHaveLength(1)
  })

  test('Given 只访问项目根（根指令已在初始 system prompt 里） When 调用模型 Then 原样返回同一数组、零改动', () => {
    const controller = createController()
    expect(controller.beforeToolCall({ toolName: 'read', input: { path: 'AGENTS.md' } })).toBeUndefined()
    const messages = transcript()
    expect(controller.injectActivatedInstructions(messages)).toBe(messages)
  })

  test('Given system prompt 是分段文本数组 When 注入 Then 以追加一段文本的方式带上指令', () => {
    const controller = createController()
    controller.beforeToolCall({ toolName: 'read', input: { path: 'sub/data.txt' } })

    const injected = controller.injectActivatedInstructions(transcript([{ type: 'text', text: '分段提示' }]))
    const parts = injected[0]?.content as Array<{ type: string; text?: string }>
    expect(parts).toHaveLength(2)
    expect(parts[0]).toEqual({ type: 'text', text: '分段提示' })
    expect(parts[1]?.text).toContain('回复以【子】开头')
  })

  test('Given 真扩展挂到 Pi When 依次触发 tool_call 与 context 事件 Then 先拦后注入，无激活项时 context 返回 undefined', async () => {
    const controller = createController()
    const handlers = new Map<string, (event: Record<string, unknown>) => unknown>()
    const fakePi = { on: (name: string, handler: (event: Record<string, unknown>) => unknown) => handlers.set(name, handler) }
    controller.createExtension()(fakePi as never)

    expect(await handlers.get('context')?.({ type: 'context', messages: transcript() })).toBeUndefined()

    const blocked = await handlers.get('tool_call')?.({ type: 'tool_call', toolName: 'read', input: { path: 'sub/data.txt' } })
    expect(blocked).toMatchObject({ block: true })

    const result = await handlers.get('context')?.({ type: 'context', messages: transcript() }) as { messages: Record<string, unknown>[] }
    expect(systemText(result.messages)).toContain('回复以【子】开头')
  })
})
