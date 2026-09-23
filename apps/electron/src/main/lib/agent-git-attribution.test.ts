import { describe, expect, test } from 'bun:test'
import { buildPrAttribution, CANOPY_PR_ATTRIBUTION } from './agent-git-attribution'

describe('PR 归因文案', () => {
  test('Given 品牌配置了链接 When 生成 Then 产品名带链接', () => {
    expect(buildPrAttribution('Canopy', 'https://example.com')).toBe('Made with [Canopy](https://example.com)')
  })

  test('Given 品牌没有链接 When 生成 Then 只写产品名', () => {
    expect(buildPrAttribution('Canopy Community', null)).toBe('Made with Canopy Community')
  })


  test('Given 当前品牌 When 读取常量 Then 以产品名收尾或带链接', () => {
    expect(CANOPY_PR_ATTRIBUTION.startsWith('Made with ')).toBe(true)
  })
})
