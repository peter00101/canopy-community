/**
 * 工具结果的 JSON 安全化（收上游 #2081 的思路，按 JSON.stringify 语义重写）。
 *
 * Pi 0.86 把 ToolResultMessage.details 收紧为 JSON 值；Pi 把工具结果写进会话记录走 JSON.stringify，
 * 遇到 BigInt / 循环引用会直接抛错——工具已经执行成功，整轮却因持久化失败中断。
 * 这里把 details 归一化成纯 JSON，语义与 JSON.stringify 对齐：对象里的 undefined / 函数 / symbol 字段省略、
 * 数组里的记为 null、带 toJSON 的（如 Date）先调 toJSON、非有限数记为 null。与之不同的只有「不抛错」：
 * BigInt 转字符串、循环引用记为 "[Circular]"、读取时抛错的属性记为 "[Unreadable]"。
 *
 * 上游版本把 undefined 字段写成 null、把 Date 写成 "[Unsupported object]"——会改变模型看到的工具结果文本
 * （如 TaskCreate 结果凭空多出一串 "description":null），我方不采。
 * 放在内核而非 Pi 适配层：工具结果可序列化是所有 Runtime 共同的契约，与具体 Runtime 无关。
 */

export type ToolResultJsonValue =
  | null
  | boolean
  | number
  | string
  | ToolResultJsonValue[]
  | { [key: string]: ToolResultJsonValue }

const CIRCULAR = '[Circular]'
const UNREADABLE = '[Unreadable]'

/** 归一化工具结果 details；入参本身是 undefined / 函数 / symbol 时返回 undefined（即「没有 details」）。 */
export function normalizeToolResultDetails(value: unknown): ToolResultJsonValue | undefined {
  return normalizeValue(value, '', new WeakSet<object>())
}

/** 同时产出归一化后的 details 与发给模型的紧凑 JSON 文本，两者内容一致且保证不抛错。 */
export function serializeToolResultPayload(payload: unknown): { details: ToolResultJsonValue; text: string } {
  const details = normalizeToolResultDetails(payload) ?? null
  return { details, text: JSON.stringify(details) }
}

function normalizeValue(value: unknown, key: string, ancestors: WeakSet<object>): ToolResultJsonValue | undefined {
  let current = value
  if (typeof current === 'object' && current !== null && typeof (current as { toJSON?: unknown }).toJSON === 'function') {
    try {
      current = (current as { toJSON: (key: string) => unknown }).toJSON(key)
    } catch {
      return UNREADABLE
    }
  }

  if (current === null) return null
  switch (typeof current) {
    case 'string':
    case 'boolean':
      return current
    case 'number':
      return Number.isFinite(current) ? current : null
    case 'bigint':
      return current.toString()
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined
    default:
      break
  }

  const object = current as object
  if (ancestors.has(object)) return CIRCULAR
  ancestors.add(object)
  try {
    if (Array.isArray(object)) {
      return object.map((item, index) => normalizeValue(item, String(index), ancestors) ?? null)
    }
    const result: { [key: string]: ToolResultJsonValue } = {}
    for (const property of Object.keys(object)) {
      let item: unknown
      try {
        item = (object as Record<string, unknown>)[property]
      } catch {
        result[property] = UNREADABLE
        continue
      }
      const normalized = normalizeValue(item, property, ancestors)
      if (normalized !== undefined) result[property] = normalized
    }
    return result
  } finally {
    ancestors.delete(object)
  }
}
