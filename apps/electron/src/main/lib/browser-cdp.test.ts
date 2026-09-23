import { describe, expect, test } from 'bun:test'
import { BrowserCdpTimeoutError, loadUrlToleratingSlowFinish, type NavigableWebContents } from './browser-cdp'

/** 可控的假 WebContents：手动触发 did-navigate 与 loadURL settle 时机。 */
function createFakeWebContents(loadUrlImpl: (fake: FakeWebContents) => Promise<void>): FakeWebContents {
  const listeners = new Set<() => void>()
  const fake: FakeWebContents = {
    listenerCount: () => listeners.size,
    emitDidNavigate: () => { for (const l of listeners) l() },
    loadURL: () => loadUrlImpl(fake),
    on: (_e, l) => { listeners.add(l); return fake },
    removeListener: (_e, l) => { listeners.delete(l); return fake },
  }
  return fake
}

interface FakeWebContents extends NavigableWebContents {
  listenerCount(): number
  emitDidNavigate(): void
}

const never = () => new Promise<void>(() => {})

describe('受管浏览器慢加载导航容忍', () => {
  test('Given 页面按时加载完成 When 导航 Then 正常成功且监听器被清理', async () => {
    const wc = createFakeWebContents(async (fake) => { fake.emitDidNavigate() })
    await loadUrlToleratingSlowFinish(wc, 'https://example.com', 50)
    expect(wc.listenerCount()).toBe(0)
  })

  test('Given 主框架已提交但子资源加载超时 When 导航 Then 视为成功不抛错', async () => {
    const wc = createFakeWebContents((fake) => { fake.emitDidNavigate(); return never() })
    await loadUrlToleratingSlowFinish(wc, 'https://heavy-portal.example', 30)
    expect(wc.listenerCount()).toBe(0)
  })

  test('Given 导航从未提交且超时 When 导航 Then 仍抛出超时错误', async () => {
    const wc = createFakeWebContents(() => never())
    await expect(loadUrlToleratingSlowFinish(wc, 'https://blackhole.example', 30)).rejects.toBeInstanceOf(BrowserCdpTimeoutError)
    expect(wc.listenerCount()).toBe(0)
  })

  test('Given DNS/拦截类快速失败 When 导航 Then 原样抛出且不被容忍逻辑吞掉', async () => {
    const wc = createFakeWebContents(() => Promise.reject(new Error('ERR_NAME_NOT_RESOLVED')))
    await expect(loadUrlToleratingSlowFinish(wc, 'https://no-such-host.example', 50)).rejects.toThrow('ERR_NAME_NOT_RESOLVED')
    expect(wc.listenerCount()).toBe(0)
  })

  test('Given 提交发生在超时之后 When 已判超时 Then 结果维持超时错误（不回溯翻案）', async () => {
    const wc = createFakeWebContents(() => never())
    const p = loadUrlToleratingSlowFinish(wc, 'https://slow-commit.example', 20)
    const result = p.catch((e: unknown) => e)
    await new Promise((r) => setTimeout(r, 40))
    wc.emitDidNavigate()
    expect(await result).toBeInstanceOf(BrowserCdpTimeoutError)
  })
})
