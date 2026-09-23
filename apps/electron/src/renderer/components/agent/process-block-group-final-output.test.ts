import { describe, expect, test } from 'bun:test'
import { buildAssistantTurnRenderItems, hasNoExternalizedFinalOutput } from './ProcessBlockGroup'
import type { SDKContentBlock } from '@canopy/shared'

const text = (t: string): SDKContentBlock => ({ type: 'text', text: t } as unknown as SDKContentBlock)
const thinking = (t: string): SDKContentBlock => ({ type: 'thinking', thinking: t } as unknown as SDKContentBlock)
const toolUse = (name: string): SDKContentBlock => ({ type: 'tool_use', id: `call-${name}`, name, input: {} } as unknown as SDKContentBlock)

describe('回合渲染分组与零外显判定（跑完什么都没有的呈现层修复）', () => {
  test('Given 完成态尾部是 text When 分组 Then 尾部 text 外置为正式回答、前段进过程组', () => {
    const items = buildAssistantTurnRenderItems([thinking('想'), toolUse('Grep'), text('最终结论')])
    expect(items.length).toBe(2)
    expect(items[0]?.type).toBe('process-group')
    expect(items[1]?.type).toBe('block')
    expect(hasNoExternalizedFinalOutput(items)).toBe(false)
  })

  test('Given 完成态尾部是工具调用（模型提前 stop / 被掐） When 分组 Then 全部进过程组且判定为零外显', () => {
    const items = buildAssistantTurnRenderItems([thinking('想'), text('过程叙述'), toolUse('Grep')])
    expect(items.length).toBe(1)
    expect(items[0]?.type).toBe('process-group')
    expect(hasNoExternalizedFinalOutput(items)).toBe(true)
  })

  test('Given 完成态尾部是 thinking When 分组 Then 同样零外显（大屏30 会话的实锤形态）', () => {
    const items = buildAssistantTurnRenderItems([text('过程'), toolUse('Read'), thinking('Inspecting...')])
    expect(hasNoExternalizedFinalOutput(items)).toBe(true)
  })

  test('Given 纯文本回复（无任何过程块） When 分组 Then 直接外显、不判零外显', () => {
    const items = buildAssistantTurnRenderItems([text('直接回答')])
    expect(items.every((i) => i.type === 'block')).toBe(true)
    expect(hasNoExternalizedFinalOutput(items)).toBe(false)
  })

  test('Given 流式中尾部出现 text（前有过程块） When 分组 Then 已可外置展示（#1736 语义不回退）', () => {
    const items = buildAssistantTurnRenderItems([toolUse('Grep'), text('正在总结…')], { isStreaming: true })
    expect(items[items.length - 1]?.type).toBe('block')
  })

  test('Given 流式中只有过程块 When 分组 Then 全在过程组（中间态不误判为最终答案）', () => {
    const items = buildAssistantTurnRenderItems([thinking('想'), toolUse('Grep')], { isStreaming: true })
    expect(items.length).toBe(1)
    expect(items[0]?.type).toBe('process-group')
  })

  test('Given 空块列表 When 判定 Then 不算零外显（无内容回合另有空态处理）', () => {
    expect(hasNoExternalizedFinalOutput([])).toBe(false)
  })
})
