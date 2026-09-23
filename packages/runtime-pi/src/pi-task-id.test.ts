import { describe, expect, test } from 'bun:test'
import { buildAppProductToolDefinitions, resolveAppTaskId } from './pi-agent-adapter'

type PiSdkForTest = Parameters<typeof buildAppProductToolDefinitions>[0]

/** defineTool 在 Pi 里本就是恒等函数，测试直接用恒等假 sdk 构建真工具定义。 */
const identitySdk = { defineTool: (tool: unknown) => tool } as unknown as PiSdkForTest

interface ExecutableTool {
  name: string
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ details?: unknown }>
}

function taskTools(): { create: ExecutableTool; update: ExecutableTool } {
  const tools = buildAppProductToolDefinitions(identitySdk, undefined) as unknown as ExecutableTool[]
  const create = tools.find((tool) => tool.name === 'TaskCreate')
  const update = tools.find((tool) => tool.name === 'TaskUpdate')
  if (!create || !update) throw new Error('缺少任务工具定义')
  return { create, update }
}

async function createdTaskId(tool: ExecutableTool, toolCallId: string, params: Record<string, unknown>): Promise<string> {
  const result = await tool.execute(toolCallId, params)
  return ((result.details as { task: { id: string } }).task).id
}

describe('TaskCreate 的任务 ID（收上游 #2076）', () => {
  test('Given 正常的工具调用 id When 创建任务 Then 任务 id 就是 toolCallId，与流式 tool_use 同键', () => {
    const id = resolveAppTaskId({ subject: '检查实现' }, 'toolu_01ABC', () => false, () => 'fallback')
    expect(id).toBe('toolu_01ABC')
  })

  test('Given 旧调用格式显式带 id When 创建任务 Then 仍以显式 id 为准', () => {
    expect(resolveAppTaskId({ id: 'legacy-7' }, 'toolu_01ABC', () => false, () => 'fallback')).toBe('legacy-7')
    expect(resolveAppTaskId({ task_id: 9 }, 'toolu_01ABC', () => false, () => 'fallback')).toBe('9')
  })

  test('Given 网关没下发工具调用 id（空串或纯空白） When 创建任务 Then 退回自增编号而不是空 id', () => {
    expect(resolveAppTaskId({}, '', () => false, () => '1')).toBe('1')
    expect(resolveAppTaskId({}, '   ', () => false, () => '2')).toBe('2')
  })

  test('Given 网关每轮从 call_0 重新编号、id 已被本轮任务占用 When 再创建任务 Then 退回自增编号，不覆盖旧任务', () => {
    const taken = new Set(['call_0'])
    expect(resolveAppTaskId({}, 'call_0', (id) => taken.has(id), () => '1')).toBe('1')
  })

  test('Given 真工具定义 When 连续创建再更新 Then 更新能按 toolCallId 找到任务并保留标题', async () => {
    const { create, update } = taskTools()
    const firstId = await createdTaskId(create, 'toolu_A', { subject: '读取需求' })
    const secondId = await createdTaskId(create, 'toolu_B', { subject: '写实现' })
    expect([firstId, secondId]).toEqual(['toolu_A', 'toolu_B'])

    const updated = await update.execute('toolu_C', { taskId: 'toolu_A', status: 'completed' })
    expect((updated.details as { task: { id: string; subject: string; status: string } }).task).toMatchObject({
      id: 'toolu_A',
      subject: '读取需求',
      status: 'completed',
    })
  })

  test('Given 真工具定义且网关重复下发 call_0 When 两次创建 Then 两个任务各自独立、互不覆盖', async () => {
    const { create } = taskTools()
    const firstId = await createdTaskId(create, 'call_0', { subject: '第一项' })
    const secondId = await createdTaskId(create, 'call_0', { subject: '第二项' })
    expect(firstId).toBe('call_0')
    expect(secondId).not.toBe('call_0')
    expect(secondId).not.toBe('')
  })

  test('Given 自增编号撞上旧格式显式 id When 退回编号 Then 跳过已占用的号', async () => {
    const { create } = taskTools()
    await createdTaskId(create, 'toolu_X', { id: '1', subject: '旧格式任务' })
    const fallbackId = await createdTaskId(create, '', { subject: '网关没给 id' })
    expect(fallbackId).toBe('2')
  })
})
