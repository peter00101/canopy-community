import { describe, expect, test } from 'bun:test'
import { hasSubstantiveRunOutput } from './agent-run-output'
import type { SDKMessage } from '@canopy/shared'

function assistant(content: Array<Record<string, unknown>>): SDKMessage {
  return { type: 'assistant', message: { content } } as unknown as SDKMessage
}

describe('run 实质产出判定（零产出留痕的依据）', () => {
  test('Given abort 挂死流产生的空 aborted assistant（content 为空数组） When 判定 Then 不算产出（E2E 实测踩到的空壳形态）', () => {
    expect(hasSubstantiveRunOutput([assistant([])])).toBe(false)
  })

  test('Given assistant 只有空串 text 与空串 thinking When 判定 Then 不算产出', () => {
    expect(hasSubstantiveRunOutput([assistant([{ type: 'thinking', thinking: '' }, { type: 'text', text: '  ' }])])).toBe(false)
  })

  test('Given assistant 含非空 text When 判定 Then 算产出', () => {
    expect(hasSubstantiveRunOutput([assistant([{ type: 'text', text: '第一阶段完成' }])])).toBe(true)
  })

  test('Given assistant 含 tool_use When 判定 Then 算产出（工具调用本身就是可见过程）', () => {
    expect(hasSubstantiveRunOutput([assistant([{ type: 'tool_use', id: 't1', name: 'Grep', input: {} }])])).toBe(true)
  })

  test('Given user 消息含 tool_result When 判定 Then 算产出', () => {
    const toolResult = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [] }] } } as unknown as SDKMessage
    expect(hasSubstantiveRunOutput([toolResult])).toBe(true)
  })

  test('Given result 或 system 消息 When 判定 Then 算产出（终态与压缩边界都是有效信息）', () => {
    expect(hasSubstantiveRunOutput([{ type: 'result', subtype: 'success' } as unknown as SDKMessage])).toBe(true)
    expect(hasSubstantiveRunOutput([{ type: 'system', subtype: 'compact_boundary' } as unknown as SDKMessage])).toBe(true)
  })

  test('Given 空消息列表 When 判定 Then 不算产出', () => {
    expect(hasSubstantiveRunOutput([])).toBe(false)
  })
})
