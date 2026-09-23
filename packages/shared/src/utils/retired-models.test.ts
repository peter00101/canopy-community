import { describe, expect, test } from 'bun:test'
import { formatRetiredModelMessage, isRetiredModelId } from './retired-models'

describe('官方已下线模型 · 判定', () => {
  test('给定 gpt-5.3-codex-spark 的各种写法，当判定时，则都算已下线', () => {
    for (const id of ['gpt-5.3-codex-spark', '  GPT-5.3-CODEX-SPARK \n', 'openai/gpt-5.3-codex-spark', 'tree/OpenAI/gpt-5.3-codex-spark']) {
      expect(isRetiredModelId(id)).toBe(true)
    }
  })

  test('给定相近但仍在售的模型与空值，当判定时，则不误伤', () => {
    for (const id of ['gpt-5.3-codex', 'gpt-5.3-codex-spark-2', 'gpt-5.6-terra', 'spark', '', '   ', 'gpt-5.3-codex-spark/extra']) {
      expect(isRetiredModelId(id)).toBe(false)
    }
    expect(isRetiredModelId(undefined)).toBe(false)
    expect(isRetiredModelId(null)).toBe(false)
  })

  test('给定已下线模型，当生成提示时，则点名模型并说明换一个', () => {
    expect(formatRetiredModelMessage(' gpt-5.3-codex-spark ')).toBe('模型 gpt-5.3-codex-spark 已下线（官方停止提供），请换一个模型')
  })
})
