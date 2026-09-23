import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { OnboardingView } from './OnboardingView'

const noop = (): void => {}

/** 取右上角常驻退出按钮的 HTML 片段 */
function renderExitButton(html: string): string {
  const match = html.match(/<button[^>]*data-onboarding-exit="[^"]*"[^>]*>[\s\S]*?<\/button>/)
  return match?.[0] ?? ''
}

describe('新手引导右上角常驻退出按钮', () => {
  test('给定首次启动停在欢迎页 当渲染引导 则右上角显示「跳过」并提示 Esc', () => {
    const html = renderToStaticMarkup(<OnboardingView onComplete={noop} entry="first-run" />)
    const button = renderExitButton(html)
    expect(button).toContain('data-onboarding-exit="first-run"')
    expect(button).toContain('跳过')
    expect(button).toContain('Esc')
    expect(button).not.toContain('退出引导')
  })

  test('给定从设置重放直达第一章 当渲染引导 则右上角显示「退出引导」', () => {
    const html = renderToStaticMarkup(<OnboardingView onComplete={noop} entry="replay" initialStep="guide" />)
    const button = renderExitButton(html)
    expect(button).toContain('data-onboarding-exit="replay"')
    expect(button).toContain('退出引导')
  })

  test('给定未传入口 当渲染引导 则按首次启动处理', () => {
    const html = renderToStaticMarkup(<OnboardingView onComplete={noop} />)
    expect(renderExitButton(html)).toContain('data-onboarding-exit="first-run"')
  })

  test('给定 Windows 自绘标题栏拖拽区 当渲染退出按钮容器 则显式 no-drag 且层级高于底部进度条', () => {
    const html = renderToStaticMarkup(<OnboardingView onComplete={noop} entry="replay" initialStep="guide" />)
    expect(html).toMatch(/class="titlebar-no-drag absolute right-6 top-5 z-40[^"]*"[^>]*>(?:(?!<\/div>)[\s\S])*data-onboarding-exit="replay"/)
  })
})
