import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@canopy/shared'
import { groupIntoTurns } from '@canopy/session-core'
import { buildTurnFileNameMap, collectTurnFilePaths, TOUCHED_TOOLS } from './turn-file-paths'

function toolUse(id: string, name: string, input: Record<string, unknown>): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input }] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

function toolResult(toolUseId: string, isError?: boolean): SDKMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok', ...(isError === undefined ? {} : { is_error: isError }) }] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

describe('本轮文件改动汇总：哪些工具调用算证据（上游 #2069 ①）', () => {
  test('Given Write 已成功返回 When 汇总 Then 文件出现在改动列表', () => {
    const turn = [toolUse('t1', 'Write', { file_path: '/ws/report.md' }), toolResult('t1', false)]
    expect(collectTurnFilePaths(turn)).toEqual(['/ws/report.md'])
  })

  test('Given Write 还在流式执行、结果尚未返回 When 汇总 Then 不提前把它当成已改动的文件', () => {
    const turn = [toolUse('t1', 'Write', { file_path: '/ws/pending.md' })]
    expect(collectTurnFilePaths(turn)).toEqual([])
  })

  test('Given Write 返回了错误 When 汇总 Then 不算改动', () => {
    const turn = [toolUse('t1', 'Write', { file_path: '/ws/denied.md' }), toolResult('t1', true)]
    expect(collectTurnFilePaths(turn)).toEqual([])
  })

  test('Given 结果块没带 is_error 字段（老会话） When 汇总 Then 按成功处理', () => {
    const turn = [toolUse('t1', 'Edit', { file_path: '/ws/legacy.ts' }), toolResult('t1')]
    expect(collectTurnFilePaths(turn)).toEqual(['/ws/legacy.ts'])
  })

  test('Given 同一文件先失败后成功 When 汇总 Then 只出现一次', () => {
    const turn = [
      toolUse('t1', 'Edit', { file_path: '/ws/a.ts' }), toolResult('t1', true),
      toolUse('t2', 'Edit', { file_path: '/ws/a.ts' }), toolResult('t2', false),
      toolUse('t3', 'Edit', { file_path: '/ws/a.ts' }), toolResult('t3', false),
    ]
    expect(collectTurnFilePaths(turn)).toEqual(['/ws/a.ts'])
  })

  test('Given 一条 assistant 消息里并行多个工具、结果分批返回 When 汇总 Then 只列已返回成功的，顺序按调用顺序', () => {
    const parallel = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'p1', name: 'Write', input: { file_path: '/ws/1.md' } },
          { type: 'tool_use', id: 'p2', name: 'Write', input: { file_path: '/ws/2.md' } },
          { type: 'tool_use', id: 'p3', name: 'Write', input: { file_path: '/ws/3.md' } },
        ],
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage
    expect(collectTurnFilePaths([parallel, toolResult('p3', false), toolResult('p1', false)])).toEqual(['/ws/1.md', '/ws/3.md'])
  })

  test('Given Office 工具族与 NotebookEdit 的入参字段各不相同 When 汇总 Then 都能取到路径', () => {
    const turn = [
      toolUse('o1', 'OfficeEdit', { filePath: '/ws/表格.xlsx' }), toolResult('o1', false),
      toolUse('n1', 'NotebookEdit', { notebook_path: '/ws/nb.ipynb' }), toolResult('n1', false),
      toolUse('o2', 'OfficeCreate', { path: '/ws/deck.pptx' }), toolResult('o2', false),
    ]
    expect(collectTurnFilePaths(turn)).toEqual(['/ws/表格.xlsx', '/ws/nb.ipynb', '/ws/deck.pptx'])
  })

  test('Given 只读过没改 When 汇总改动 Then Read 不进改动列表，但进正文引用用的「触碰过」集合', () => {
    const turn = [toolUse('r1', 'Read', { file_path: '/ws/spec.md' }), toolResult('r1', false)]
    expect(collectTurnFilePaths(turn)).toEqual([])
    expect(collectTurnFilePaths(turn, TOUCHED_TOOLS)).toEqual(['/ws/spec.md'])
  })
})

describe('正文裸文件名 → 绝对路径映射', () => {
  test('Given Read 成功读过的文件 When 正文只写了文件名 Then 能补全为绝对路径', () => {
    const turn = [toolUse('r1', 'Read', { file_path: '/ws/docs/spec.md' }), toolResult('r1', false)]
    expect(buildTurnFileNameMap(turn).get('spec.md')).toBe('/ws/docs/spec.md')
  })

  test('Given Read 还没返回 When 正文提到同名文件 Then 不拿未证实的路径去补全', () => {
    const turn = [toolUse('r1', 'Read', { file_path: '/ws/docs/spec.md' })]
    expect(buildTurnFileNameMap(turn).has('spec.md')).toBe(false)
  })

  test('Given 两个目录下有同名文件 When 建映射 Then 该文件名整个剔除，交给候选根解析', () => {
    const turn = [
      toolUse('r1', 'Read', { file_path: '/ws/a/index.ts' }), toolResult('r1', false),
      toolUse('r2', 'Read', { file_path: '/ws/b/index.ts' }), toolResult('r2', false),
      toolUse('r3', 'Read', { file_path: '/ws/c/index.ts' }), toolResult('r3', false),
    ]
    expect(buildTurnFileNameMap(turn).has('index.ts')).toBe(false)
  })
})

describe('与真实分轮逻辑配合（groupIntoTurns）', () => {
  const userInput = {
    type: 'user',
    message: { content: [{ type: 'text', text: '写个报告' }] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage

  test('Given 一轮里 Write 成功 When 走真实分轮 Then 结果消息与调用在同一轮，文件被列出', () => {
    const groups = groupIntoTurns([userInput, toolUse('t1', 'Write', { file_path: '/ws/report.md' }), toolResult('t1', false)])
    const turn = groups.find((group) => group.type === 'assistant-turn')
    expect(turn?.type).toBe('assistant-turn')
    expect(collectTurnFilePaths((turn as { turnMessages: SDKMessage[] }).turnMessages)).toEqual(['/ws/report.md'])
  })

  test('Given 工具被权限拒绝（system 消息会截断当前轮，错误结果落在轮外） When 汇总 Then 被拒的 Write 不再冒充已改动文件', () => {
    const denied = {
      type: 'system',
      subtype: 'permission_denied',
      parent_tool_use_id: null,
    } as unknown as SDKMessage
    const groups = groupIntoTurns([userInput, toolUse('t1', 'Write', { file_path: '/ws/secret.md' }), denied, toolResult('t1', true)])
    const paths = groups
      .filter((group) => group.type === 'assistant-turn')
      .flatMap((group) => collectTurnFilePaths((group as { turnMessages: SDKMessage[] }).turnMessages))
    expect(paths).toEqual([])
  })
})
