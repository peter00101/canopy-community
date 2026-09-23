import { describe, expect, test } from 'bun:test'
import { normalizeToolResultDetails, serializeToolResultPayload } from './tool-result-json'

describe('工具结果 JSON 安全化：普通数据与 JSON.stringify 逐字一致', () => {
  test('Given 带 undefined 字段的任务结果 When 序列化 Then 字段照旧省略，不凭空多出 null（上游版本会写成 null）', () => {
    const payload = { task: { id: 'toolu_A', subject: '读取需求', status: 'pending', description: undefined, blocks: undefined } }
    const { text, details } = serializeToolResultPayload(payload)
    expect(text).toBe(JSON.stringify(payload))
    expect(details).toEqual({ task: { id: 'toolu_A', subject: '读取需求', status: 'pending' } })
  })

  test('Given 含 Date 的结果 When 序列化 Then 与 JSON.stringify 一样转成 ISO 字符串（上游版本会写成 "[Unsupported object]"）', () => {
    const at = new Date('2026-09-21T12:00:00.000Z')
    expect(serializeToolResultPayload({ at }).text).toBe(JSON.stringify({ at }))
  })

  test('Given 数组里的 undefined / 函数与非有限数 When 归一化 Then 与 JSON.stringify 一样记为 null', () => {
    const payload = [1, undefined, () => 1, Number.NaN, Number.POSITIVE_INFINITY, 'x']
    expect(serializeToolResultPayload(payload).text).toBe(JSON.stringify(payload))
  })

  test('Given 自定义 toJSON 与按 key 取值 When 归一化 Then 调 toJSON 并把属性名传进去', () => {
    const payload = { value: { toJSON: (key: string) => `key=${key}` } }
    expect(normalizeToolResultDetails(payload)).toEqual({ value: 'key=value' })
  })
})

describe('工具结果 JSON 安全化：JSON.stringify 会抛错的情形不再中断整轮', () => {
  test('Given BigInt When 序列化 Then 转成十进制字符串而不是抛错', () => {
    expect(() => JSON.stringify({ size: 10n })).toThrow()
    expect(serializeToolResultPayload({ size: 12345678901234567890n }).details).toEqual({ size: '12345678901234567890' })
  })

  test('Given 循环引用 When 序列化 Then 回边记为 "[Circular]"，兄弟间的共享引用照常展开', () => {
    const shared = { ok: true }
    const node: Record<string, unknown> = { name: 'root', a: shared, b: shared }
    node.self = node
    expect(normalizeToolResultDetails(node)).toEqual({ name: 'root', a: { ok: true }, b: { ok: true }, self: '[Circular]' })
  })

  test('Given 读取时抛错的属性或 toJSON When 归一化 Then 记为 "[Unreadable]"，其余字段照常保留', () => {
    const payload = {
      fine: 1,
      get broken(): never { throw new Error('boom') },
      bad: { toJSON: (): never => { throw new Error('boom') } },
    }
    expect(normalizeToolResultDetails(payload)).toEqual({ fine: 1, broken: '[Unreadable]', bad: '[Unreadable]' })
  })
})

describe('工具结果 JSON 安全化：顶层边界', () => {
  test('Given 顶层 undefined When 归一化 Then 返回 undefined（表示没有 details）；序列化时落成 null 文本', () => {
    expect(normalizeToolResultDetails(undefined)).toBeUndefined()
    expect(serializeToolResultPayload(undefined)).toEqual({ details: null, text: 'null' })
  })

  test('Given 纯字符串 / 数字 / 布尔 / null When 归一化 Then 原样返回', () => {
    for (const value of ['a', 0, false, null]) {
      expect(normalizeToolResultDetails(value)).toBe(value)
    }
  })
})
