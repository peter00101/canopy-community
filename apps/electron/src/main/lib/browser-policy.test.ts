/**
 * 受管浏览器 URL 解析与默认搜索引擎设置的 BDD 测试。
 *
 * 背景：上游 #1769 的做法是「先撞 Google、3 秒超时再回落必应」，对国内用户等于每次开新标签白等
 * 3 秒，我方不采，改为设置页显式选择（默认必应，Agent 与用户共用同一选择）。
 */

import { describe, expect, it, beforeEach } from 'bun:test'
import {
  getBrowserNewTabUrl,
  getBrowserSearchEngine,
  getBrowserSearchUrl,
  normalizeBrowserUrl,
  resolveBrowserDestination,
  setBrowserSearchEngine,
} from './browser-policy'

describe('受管浏览器默认搜索引擎', () => {
  beforeEach(() => {
    // 每个用例从「未设置」开始，确认回落到默认必应。
    setBrowserSearchEngine(undefined)
  })

  it('给定设置里没写搜索引擎，当解析搜索词时，则走必应', () => {
    expect(getBrowserSearchEngine()).toBe('bing')
    expect(resolveBrowserDestination('今天天气')).toBe('https://cn.bing.com/search?q=%E4%BB%8A%E5%A4%A9%E5%A4%A9%E6%B0%94')
    expect(getBrowserNewTabUrl()).toBe('https://cn.bing.com/')
  })

  it('给定用户在设置里选了谷歌，当解析搜索词时，则走谷歌', () => {
    expect(setBrowserSearchEngine('google')).toBe('google')
    expect(resolveBrowserDestination('canopy release notes')).toBe('https://www.google.com/search?q=canopy%20release%20notes')
    expect(getBrowserNewTabUrl()).toBe('https://www.google.com/')
    expect(getBrowserSearchUrl()).toBe('https://www.google.com/search')
  })

  it('给定设置文件里是非法值（手改坏了 / 旧版本残留），当读取时，则回落必应而不是抛错', () => {
    expect(setBrowserSearchEngine('baidu')).toBe('bing')
    expect(setBrowserSearchEngine(null)).toBe('bing')
    expect(setBrowserSearchEngine(42)).toBe('bing')
    expect(resolveBrowserDestination('测试')).toContain('cn.bing.com')
  })

  it('给定调用方显式传入引擎，当解析时，则以传入值为准，不改变全局选择', () => {
    setBrowserSearchEngine('bing')
    expect(resolveBrowserDestination('hello', 'google')).toBe('https://www.google.com/search?q=hello')
    expect(getBrowserSearchEngine()).toBe('bing')
  })

  it('给定输入是明确的 URL，当解析时，则直达目标站点，不受搜索引擎设置影响', () => {
    setBrowserSearchEngine('google')
    expect(resolveBrowserDestination('example.com/docs')).toBe('https://example.com/docs')
    expect(resolveBrowserDestination('https://cn.bing.com/')).toBe('https://cn.bing.com/')
    expect(resolveBrowserDestination('localhost:3000')).toBe('http://localhost:3000')
  })
})

describe('地址规范化', () => {
  it('给定显式 443 端口，当规范化时，则按 HTTPS 打开（上游 #1768 的端口修正部分）', () => {
    expect(normalizeBrowserUrl('example.com:443')).toBe('https://example.com:443')
    // 局域网地址在没有 443 端口时仍按 HTTP，保持本机开发服务可达。
    expect(normalizeBrowserUrl('192.168.1.10:8080')).toBe('http://192.168.1.10:8080')
  })
})
