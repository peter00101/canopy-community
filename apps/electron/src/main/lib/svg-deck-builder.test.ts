import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OfficeDocumentAccessError } from './officecli-service'
import { describeSvgDeckPlan, planSvgDeck, resolveReadableSvgPath } from './svg-deck-builder'

/**
 * 一组 SVG → 一份 PPTX 的编排契约：默认原生、不支持的页退回整页贴图并说明原因；
 * 读 SVG 的授权判定与 Office 文档同一套根集合（那类「能读任意文件」的口子不能在这里重开）。
 */
const PAGE_OK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><rect x="0" y="0" width="1280" height="720" fill="#FFFFFF"/><text x="40" y="84" font-size="36">标题</text></svg>'
const PAGE_PATH = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><path d="M0 0 L10 10"/></svg>'
const PAGE_IMG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><image x="0" y="0" width="10" height="10" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="/></svg>'

describe('planSvgDeck — 逐页路线', () => {
  it('Given 两页都能编译，When 按 native 规划，Then 每页先 add slide 再跟原生对象，媒体为空', () => {
    const plan = planSvgDeck([
      { svgPath: 'C:/deck/slides/p01.svg', svgText: PAGE_OK },
      { svgPath: 'C:/deck/slides/p02.svg', svgText: PAGE_OK },
    ], { mode: 'native', mediaDir: 'C:/deck/media' })
    expect(plan.pages.map((p) => p.route)).toEqual(['native', 'native'])
    expect(plan.commands.filter((c) => c.type === 'slide')).toHaveLength(2)
    expect(plan.commands.filter((c) => c.type === 'textbox').map((c) => c.parent)).toEqual(['/slide[1]', '/slide[2]'])
    expect(plan.media).toHaveLength(0)
  })

  it('Given 第二页含 path，When 按 native 规划，Then 该页仍原生、path 变成一张矢量小图落到 mediaDir，其余页不受影响', () => {
    const plan = planSvgDeck([
      { svgPath: 'C:/deck/slides/p01.svg', svgText: PAGE_OK },
      { svgPath: 'C:/deck/slides/p02.svg', svgText: PAGE_PATH },
    ], { mode: 'native', mediaDir: 'C:/deck/media' })
    expect(plan.pages.map((p) => p.route)).toEqual(['native', 'native'])
    expect(plan.pages[1]?.stats.fragments).toBe(1)
    expect(plan.pages[1]?.fragments.join()).toContain('<path>')
    const picture = plan.commands.find((c) => c.type === 'picture')
    expect(picture?.parent).toBe('/slide[2]')
    expect(picture?.props?.src).toBe('C:/deck/media/p02-vec1.svg')
    expect(plan.media[0]?.path).toBe(join('C:/deck/media', 'p02-vec1.svg'))
  })

  it('Given 第二页含 use（连小图都裁不出来），When 按 native 规划，Then 该页退回整页贴图并记原因，其余页仍原生', () => {
    const PAGE_USE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><use href="#logo"/></svg>'
    const plan = planSvgDeck([
      { svgPath: 'C:/deck/slides/p01.svg', svgText: PAGE_OK },
      { svgPath: 'C:/deck/slides/p02.svg', svgText: PAGE_USE },
    ], { mode: 'native', mediaDir: 'C:/deck/media' })
    expect(plan.pages[1]?.route).toBe('picture')
    expect(plan.pages[1]?.reasons.join()).toContain('<use>')
    const picture = plan.commands.find((c) => c.type === 'picture')
    expect(picture?.parent).toBe('/slide[2]')
    expect(picture?.props).toMatchObject({ src: 'C:/deck/slides/p02.svg', x: '0', y: '0', width: '13.333in', height: '7.5in' })
    expect(describeSvgDeckPlan(plan.pages)).toContain('第 2 页 p02.svg：贴图，原因：<use>')
  })

  it('Given 用户选 picture，When 规划，Then 每页都是整页贴图、不编译', () => {
    const plan = planSvgDeck([{ svgPath: 'C:/deck/slides/p01.svg', svgText: PAGE_PATH }], { mode: 'picture', mediaDir: 'C:/deck/media' })
    expect(plan.pages[0]?.route).toBe('picture')
    expect(plan.pages[0]?.reasons).toEqual([])
    expect(plan.commands.map((c) => c.type)).toEqual(['slide', 'picture'])
  })

  it('Given 页里有 data URI 图片，When 规划，Then 媒体文件按页名命名落在 mediaDir 下且命令 src 指向它', () => {
    const plan = planSvgDeck([{ svgPath: 'C:/deck/slides/p05.svg', svgText: PAGE_IMG }], { mode: 'native', mediaDir: 'C:/deck/media' })
    expect(plan.media).toHaveLength(1)
    expect(plan.media[0]?.path).toBe(join('C:/deck/media', 'p05-img1.png'))
    expect(plan.commands.find((c) => c.type === 'picture')?.props?.src).toBe('C:/deck/media/p05-img1.png')
  })

  it('Given 规划结果，When 描述给模型，Then 列出原生 / 贴图页数与每页一行', () => {
    const plan = planSvgDeck([
      { svgPath: 'C:/deck/slides/p01.svg', svgText: PAGE_OK },
      { svgPath: 'C:/deck/slides/p02.svg', svgText: PAGE_PATH },
    ], { mode: 'native', mediaDir: 'C:/deck/media' })
    const text = describeSvgDeckPlan(plan.pages)
    expect(text).toContain('原生可编辑 2 页，整页贴图 0 页')
    expect(text).toContain('/ 矢量小图 0）')
    expect(text).toContain('/ 矢量小图 1）；矢量小图不可逐字编辑：<path> ×1')
  })
})

describe('resolveReadableSvgPath — 读 SVG 的授权边界', () => {
  let root: string
  let outside: string

  beforeAll(() => {
    // macOS 的 tmpdir 是 /private/var 的软链，生产代码 realpath 后与未 realpath 的夹具路径对不上，先归一。
    root = realpathSync(mkdtempSync(join(tmpdir(), 'canopy-svg-root-')))
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'canopy-svg-outside-')))
    mkdirSync(join(root, 'slides'))
    writeFileSync(join(root, 'slides', 'p01.svg'), PAGE_OK)
    writeFileSync(join(root, 'slides', 'note.txt'), 'x')
    writeFileSync(join(outside, 'p01.svg'), PAGE_OK)
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('Given 授权根内的 .svg，When 按相对路径解析，Then 返回真实绝对路径', () => {
    const resolved = resolveReadableSvgPath('slides/p01.svg', [root], root)
    expect(resolved.toLowerCase()).toBe(join(root, 'slides', 'p01.svg').toLowerCase())
  })

  it('Given 授权根外的 .svg，When 解析，Then 拒绝', () => {
    expect(() => resolveReadableSvgPath(join(outside, 'p01.svg'), [root], root)).toThrow(OfficeDocumentAccessError)
  })

  it('Given 不是 .svg 的文件或不存在的文件，When 解析，Then 拒绝并说明', () => {
    expect(() => resolveReadableSvgPath('slides/note.txt', [root], root)).toThrow(/只接受 \.svg/)
    expect(() => resolveReadableSvgPath('slides/p99.svg', [root], root)).toThrow(/不存在/)
  })

  it('Given 没有授权根，When 解析，Then 拒绝', () => {
    expect(() => resolveReadableSvgPath('slides/p01.svg', [], root)).toThrow(OfficeDocumentAccessError)
  })
})
