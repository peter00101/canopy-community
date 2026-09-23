import { describe, expect, test } from 'bun:test'
import { adaptToolsForPi } from './tool-adapter'
import type { KernelToolDefinition } from '@canopy/kernel'

describe('adaptToolsForPi', () => {
  test('Given 中性工具定义 When 适配为 Pi 形状 Then 原样透传（defineTool 是恒等函数，无需 sdk 句柄）', () => {
    const tools: KernelToolDefinition[] = [
      {
        name: 'Example',
        label: '示例',
        description: 'An example tool',
        parameters: { type: 'object', properties: {} } as never,
        execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: undefined }),
      },
    ]

    const result = adaptToolsForPi(tools)

    expect(result).toHaveLength(1)
    expect(result[0]).toBe(tools[0] as never)
  })

  test('Given 空数组 When 适配 Then 返回空数组', () => {
    const result = adaptToolsForPi([])

    expect(result).toEqual([])
  })
})
