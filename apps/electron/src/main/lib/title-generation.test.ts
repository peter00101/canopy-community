import { describe, expect, test } from 'bun:test'
import { createFallbackTitle, sanitizeGeneratedTitle, shouldUseFallbackTitle } from './title-generation'

describe('标题请求失败时是否退回本地兜底名', () => {
  test('Given anthropic-compatible 中转站渠道, When 标题请求拿不到标题, Then 用兜底名（0.18.67 修：此前返回 null，会话永远停在默认标题）', () => {
    expect(shouldUseFallbackTitle('anthropic-compatible')).toBe(true)
  })

  test.each(['opencode-go-openai', 'custom'])(
    'Given 通用兼容渠道 %s, When 标题请求失败, Then 用兜底名（既有行为不变）',
    (provider) => {
      expect(shouldUseFallbackTitle(provider)).toBe(true)
    },
  )

  test.each([
    'anthropic', 'openai', 'deepseek', 'google',
  ])(
    'Given 自营/官方协议渠道 %s, When 标题请求失败, Then 不用兜底名（地址固定，失败多半是真故障，别用假名字盖住）',
    (provider) => {
      expect(shouldUseFallbackTitle(provider)).toBe(false)
    },
  )

  test('Given 未知 provider 字符串, When 判定, Then 不兜底（白名单语义，不误放行）', () => {
    expect(shouldUseFallbackTitle('some-future-provider')).toBe(false)
  })
})

describe('本地兜底标题', () => {
  test('Given 多行消息, When 生成兜底名, Then 取首个非空行', () => {
    expect(createFallbackTitle('\n\n  帮我改一下表格\n第二行')).toBe('帮我改一下表格')
  })

  test('Given 带 markdown 前缀的消息, When 生成兜底名, Then 去掉前缀', () => {
    expect(createFallbackTitle('## 修复预览刷新')).toBe('修复预览刷新')
  })

  test('Given 空白消息, When 生成兜底名, Then 返回 null（交由调用方保持原标题）', () => {
    expect(createFallbackTitle('   \n  ')).toBeNull()
  })
})

describe('模型返回标题的清洗', () => {
  test('Given 带引号的标题, When 清洗, Then 去掉首尾引号', () => {
    expect(sanitizeGeneratedTitle('"修复预览刷新"')).toBe('修复预览刷新')
  })

  test('Given 非文本内容, When 清洗, Then 返回 null', () => {
    expect(sanitizeGeneratedTitle(null)).toBeNull()
    expect(sanitizeGeneratedTitle(123)).toBeNull()
  })
})
