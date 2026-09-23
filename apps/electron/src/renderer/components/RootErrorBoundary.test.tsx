import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ROOT_ERROR_LOG_PREFIX,
  RootErrorBoundary,
  RootErrorFallback,
} from './RootErrorBoundary'
import type { RootErrorBoundaryState } from './RootErrorBoundary'

/**
 * 仓库测试环境没有 DOM（无 happy-dom / jsdom），React 18 的服务端渲染又不走错误边界，
 * 所以按 React 真实调用顺序手动驱动边界：子组件抛错 → getDerivedStateFromError →
 * componentDidCatch → render()，再把 render() 的产物静态渲染出来断言恢复页。
 */
function BrokenAvatar(): React.ReactElement {
  const avatar = null as unknown as string
  return <span>{avatar.startsWith('data:') ? 'img' : avatar}</span>
}

function captureChildRenderError(element: React.ReactElement): unknown {
  try {
    renderToStaticMarkup(element)
  } catch (error) {
    return error
  }
  throw new Error('测试夹具应当抛错')
}

const originalConsoleError = console.error

afterEach(() => {
  console.error = originalConsoleError
})

describe('根级界面错误边界', () => {
  test('给定子组件正常 当边界渲染 则原样渲染子组件', () => {
    const html = renderToStaticMarkup(
      <RootErrorBoundary scope="main">
        <p>主界面内容</p>
      </RootErrorBoundary>,
    )
    expect(html).toBe('<p>主界面内容</p>')
  })

  test('给定子组件渲染期抛 TypeError 当边界捕获 则渲染中文恢复页而不是空白', () => {
    const error = captureChildRenderError(<BrokenAvatar />)
    expect(error).toBeInstanceOf(TypeError)

    const boundary = new RootErrorBoundary({ scope: 'main', children: <BrokenAvatar /> })
    boundary.state = {
      ...boundary.state,
      ...RootErrorBoundary.getDerivedStateFromError(error),
    } as RootErrorBoundaryState

    const html = renderToStaticMarkup(<>{boundary.render()}</>)
    expect(html).toContain('界面出了点问题')
    expect(html).toContain('重新加载界面')
    expect(html).toContain('复制错误详情')
    expect(html).toContain('查看错误详情')
    expect(html).toContain('Canopy')
    expect(html).toContain('<details')
    // 引擎报错文案带引号会被 HTML 转义，这里只断言不含引号的关键片段
    expect(html).toContain('TypeError')
    expect(html).toContain('startsWith')
    expect(html).not.toMatch(/pr[o]ma/i)
  })

  test('给定边界捕获到错误 当 componentDidCatch 则以前缀开头记一条自包含日志（含错误、堆栈、组件堆栈）并保存组件堆栈用于复制', () => {
    const logged: unknown[][] = []
    console.error = (...args: unknown[]) => { logged.push(args) }
    const error = new TypeError('avatar.startsWith is not a function')
    error.stack = 'TypeError: avatar.startsWith is not a function\n    at isImageUrl (UserAvatar.tsx:25:17)'
    const boundary = new RootErrorBoundary({ scope: 'main', children: null })
    const setState = mock((_patch: Partial<RootErrorBoundaryState>) => {})
    boundary.setState = setState as unknown as typeof boundary.setState

    boundary.componentDidCatch(error, { componentStack: '\n    at BrokenAvatar\n    at LeftSidebar' })

    // 只有一个字符串参数：主进程 console-message 拿到的是文本，Error 对象参数带不出堆栈
    expect(logged).toHaveLength(1)
    expect(logged[0]).toHaveLength(1)
    const message = logged[0]?.[0]
    expect(typeof message).toBe('string')
    expect((message as string).startsWith(ROOT_ERROR_LOG_PREFIX)).toBe(true)
    expect(message).toContain('窗口：main')
    expect(message).toContain('TypeError: avatar.startsWith is not a function')
    expect(message).toContain('at isImageUrl (UserAvatar.tsx:25:17)')
    expect(message).toContain('at BrokenAvatar\n    at LeftSidebar')
    expect(setState).toHaveBeenCalledWith({ componentStack: '\n    at BrokenAvatar\n    at LeftSidebar' })
  })

  test('给定恢复页带组件堆栈 当展开详情 则详情里有 message、stack 与 componentStack', () => {
    const error = new TypeError('avatar.startsWith is not a function')
    error.stack = 'TypeError: avatar.startsWith is not a function\n    at isImageUrl (UserAvatar.tsx:25:17)'
    const html = renderToStaticMarkup(
      <RootErrorFallback error={error} componentStack={'\n    at UserAvatar\n    at LeftSidebar'} scope="main" />,
    )
    expect(html).toContain('TypeError: avatar.startsWith is not a function')
    expect(html).toContain('at isImageUrl (UserAvatar.tsx:25:17)')
    expect(html).toContain('at UserAvatar')
    expect(html).toContain('窗口：main')
  })

  test('给定抛出值不是 Error（null） 当渲染恢复页 则不抛错并给出兜底说明', () => {
    let html = ''
    expect(() => {
      html = renderToStaticMarkup(<RootErrorFallback error={null} scope="main" />)
    }).not.toThrow()
    expect(html).toContain('未知错误（抛出值为 null）')
  })

  test('给定主题变量缺失 当渲染恢复页 则样式里每个主题色都带本地回退色', () => {
    const html = renderToStaticMarkup(<RootErrorFallback error={new Error('x')} />)
    const themeVarUses = html.match(/var\(--(background|foreground|muted-foreground|border|muted|primary|primary-foreground|destructive|accent|ring)\b[^)]*\)/g) ?? []
    expect(themeVarUses.length).toBeGreaterThan(0)
    for (const use of themeVarUses) {
      expect(use).toContain(', var(--cre-')
    }
  })

  test('给定无边框窗口传入自绘窗口控件 当恢复页渲染 则重新挂出控件（否则 Windows 上无法最小化/关闭）', () => {
    const withChrome = renderToStaticMarkup(
      <RootErrorFallback error={new Error('x')} windowChrome={<nav>窗口控件</nav>} />,
    )
    expect(withChrome).toContain('<nav>窗口控件</nav>')
  })
})
