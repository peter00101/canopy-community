import { describe, expect, test } from 'bun:test'
import { getFaviconOrigin, shouldClearFaviconOnNavigate } from './browser-favicon-policy'

describe('受管浏览器 favicon 站点解析', () => {
  test('Given 普通 https 地址 When 解析 origin Then 得到协议+主机+端口', () => {
    expect(getFaviconOrigin('https://cn.bing.com/search?q=x')).toBe('https://cn.bing.com')
    expect(getFaviconOrigin('http://localhost:5173/index.html')).toBe('http://localhost:5173')
  })

  test('Given 同站不同路径 When 解析 Then origin 相同', () => {
    expect(getFaviconOrigin('https://cn.bing.com/')).toBe(getFaviconOrigin('https://cn.bing.com/images'))
  })

  test('Given 不同端口或子域 When 解析 Then origin 不同（按浏览器同源规则）', () => {
    expect(getFaviconOrigin('https://a.example.com/')).not.toBe(getFaviconOrigin('https://b.example.com/'))
    expect(getFaviconOrigin('http://localhost:3000/')).not.toBe(getFaviconOrigin('http://localhost:4000/'))
  })

  test('Given about:blank / data: / 畸形输入 When 解析 Then 返回 null', () => {
    expect(getFaviconOrigin('about:blank')).toBeNull()
    expect(getFaviconOrigin('data:text/html,<p>x</p>')).toBeNull()
    expect(getFaviconOrigin('不是地址')).toBeNull()
    expect(getFaviconOrigin('')).toBeNull()
    expect(getFaviconOrigin(null)).toBeNull()
    expect(getFaviconOrigin(undefined)).toBeNull()
  })
})

describe('受管浏览器导航时的 favicon 保留判定', () => {
  test('Given 已有必应图标 When 同站再次导航（重定向落地/SPA 路由）Then 保留图标', () => {
    // 上游缺陷的正是这一条：清空后 Chromium 不补发 page-favicon-updated，图标永久消失
    expect(shouldClearFaviconOnNavigate('https://cn.bing.com', 'https://cn.bing.com/search?q=天气')).toBe(false)
  })

  test('Given 已有必应图标 When 同 URL 重载 Then 保留图标', () => {
    expect(shouldClearFaviconOnNavigate('https://cn.bing.com', 'https://cn.bing.com/')).toBe(false)
  })

  test('Given 已有 A 站图标 When 跨站导航到 B 站 Then 清空（上游本来要防的残留）', () => {
    expect(shouldClearFaviconOnNavigate('https://cn.bing.com', 'https://example.com/')).toBe(true)
  })

  test('Given 已有图标 When 导航到 about:blank 等无 origin 页 Then 清空', () => {
    expect(shouldClearFaviconOnNavigate('https://cn.bing.com', 'about:blank')).toBe(true)
    expect(shouldClearFaviconOnNavigate('https://cn.bing.com', '')).toBe(true)
  })

  test('Given 尚无图标 When 任意导航 Then 返回 true（走统一赋值路径，无副作用）', () => {
    expect(shouldClearFaviconOnNavigate(null, 'https://cn.bing.com/')).toBe(true)
    expect(shouldClearFaviconOnNavigate(null, 'about:blank')).toBe(true)
  })

  test('Given http 与 https 同主机 When 导航 Then 视为跨站清空（协议不同即不同源）', () => {
    expect(shouldClearFaviconOnNavigate('http://example.com', 'https://example.com/')).toBe(true)
  })
})
