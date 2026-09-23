import { describe, expect, test } from 'bun:test'
import { getPopupChildrenToDispose, type PopupChildState } from './browser-popup-lifecycle'

const child = (overrides: Partial<PopupChildState> & { tabId: string }): PopupChildState => ({
  currentUrl: '',
  initialUrl: null,
  initialNavigationPending: false,
  ...overrides,
})

describe('父标签关闭时子标签的去留', () => {
  test('Given 子标签已停在真实网页 When 关闭父标签 Then 保留（维护者报障场景）', () => {
    // 必应里点开一个网页，再关掉必应标签——那个网页必须留下
    const children = [child({ tabId: 'child-1', currentUrl: 'https://example.com/article' })]
    expect(getPopupChildrenToDispose(children)).toEqual([])
  })

  test('Given 子标签是 about:blank 临时弹窗 When 关闭父标签 Then 一并关闭', () => {
    const children = [child({ tabId: 'popup-1', currentUrl: 'about:blank', initialUrl: 'about:blank' })]
    expect(getPopupChildrenToDispose(children)).toEqual(['popup-1'])
  })

  test('Given blob: / data: 弹窗 When 关闭父标签 Then 一并关闭', () => {
    const children = [
      child({ tabId: 'blob-1', currentUrl: 'blob:https://site/abc' }),
      child({ tabId: 'data-1', currentUrl: 'data:text/html,<p>x</p>' }),
    ]
    expect(getPopupChildrenToDispose(children).sort()).toEqual(['blob-1', 'data-1'])
  })

  test('Given 子标签正在加载真实网页（首屏未完成）When 关闭父标签 Then 保留', () => {
    const children = [child({
      tabId: 'loading-1',
      currentUrl: '',
      initialUrl: 'https://news.example.com/post',
      initialNavigationPending: true,
    })]
    expect(getPopupChildrenToDispose(children)).toEqual([])
  })

  test('Given 弹窗从 about:blank 起步但已跳到真实网页 When 关闭父标签 Then 保留', () => {
    // OAuth 那类：window.open("about:blank") 后再 location.href 到真实页
    const children = [child({
      tabId: 'oauth-1',
      currentUrl: 'https://accounts.example.com/authorize',
      initialUrl: 'about:blank',
    })]
    expect(getPopupChildrenToDispose(children)).toEqual([])
  })

  test('Given 混合场景 When 关闭父标签 Then 只回收临时弹窗', () => {
    const children = [
      child({ tabId: 'page', currentUrl: 'https://example.com/' }),
      child({ tabId: 'blank', currentUrl: 'about:blank', initialUrl: 'about:blank' }),
      child({ tabId: 'loading', currentUrl: '', initialUrl: 'https://a.example.com/', initialNavigationPending: true }),
    ]
    expect(getPopupChildrenToDispose(children)).toEqual(['blank'])
  })

  test('Given 没有子标签 When 关闭父标签 Then 返回空', () => {
    expect(getPopupChildrenToDispose([])).toEqual([])
  })

  test('Given 子标签地址为空且无初始地址 When 关闭父标签 Then 回收（空壳窗口）', () => {
    expect(getPopupChildrenToDispose([child({ tabId: 'empty' })])).toEqual(['empty'])
  })
})
