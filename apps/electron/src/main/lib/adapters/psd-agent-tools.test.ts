import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KernelToolDefinition } from '@canopy/kernel'
import { buildPsdTools } from './psd-agent-tools'

let root = ''
let tools: KernelToolDefinition[] = []
const byName = (name: string): KernelToolDefinition => {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`no tool ${name}`)
  return tool
}
const textOf = (result: { content: Array<{ type: string; text?: string }> }): string => result.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
const hasImage = (result: { content: Array<{ type: string }> }): boolean => result.content.some((c) => c.type === 'image')

const spec = {
  width: 120,
  height: 80,
  layers: [
    { type: 'fill', name: '底', color: '#123456' },
    { type: 'text', name: '标题', text: '工具测试', fontSize: 18, color: '#ffffff', left: 8, top: 8, width: 100 },
  ],
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'canopy-psd-tools-'))
  tools = buildPsdTools({ agentCwd: root, allowedRoots: [root] })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('PSD 工具组：注册形状', () => {
  it('Given 工具组，When 列出，Then 三个工具齐全且描述里说明不需要 Photoshop / Python', () => {
    expect(tools.map((t) => t.name)).toEqual(['PsdInspect', 'PsdCompose', 'PsdEdit'])
    for (const tool of tools) {
      expect(tool.label.length).toBeGreaterThan(0)
      expect((tool.parameters as { type?: string }).type).toBe('object')
    }
    expect(byName('PsdCompose').description).toMatch(/Requires no Photoshop or Python/)
  })

  it('Given 内置工具装配源码，When 检查，Then PSD 工具组已接进 buildAppProductToolDefinitions 的注入链', () => {
    const source = readFileSync(join(import.meta.dir, 'pi-builtin-tools.ts'), 'utf-8')
    expect(source).toContain("import { buildPsdTools } from './psd-agent-tools'")
    expect(source).toContain('tools.push(...buildPsdTools({ agentCwd: ctx.agentCwd, allowedRoots: ctx.allowedRoots }))')
  })

  it('Given canopy-psd Skill 文档，When 检查引擎规则，Then 与 Office Skill 同款：默认内置不探测不问、只在高保真必要时征得同意再装、不擅自 pip install', () => {
    const skill = readFileSync(join(import.meta.dir, '..', '..', '..', '..', 'default-skills', 'canopy-psd', 'SKILL.md'), 'utf-8')
    expect(skill).toContain('## Step 0：渲染引擎——默认内置，不必探测也不必问')
    expect(skill).toContain('AskUserQuestion')
    expect(skill).toContain('psd-tools[composite]')
    expect(skill).toContain('不要擅自 `pip install`')
    expect(skill).toContain('用内置引擎继续')
    expect(skill).not.toContain('不要 `pip install`，不要让用户装 Photoshop')
  })
})

describe('PSD 工具组：合成 → 读取 → 编辑', () => {
  it('Given 内联规格，When PsdCompose，Then 文件落地、返回文字摘要与合成图；重复输出默认拒绝覆盖', async () => {
    const result = await byName('PsdCompose').execute('t1', { outputPath: 'card.psd', spec })
    const text = textOf(result)
    expect(text).toContain('已生成')
    expect(text).toContain('[1] text 标题')
    expect(hasImage(result)).toBe(true)
    expect(existsSync(join(root, 'card.psd'))).toBe(true)
    expect(existsSync(join(root, 'card-preview.png'))).toBe(true)
    const again = await byName('PsdCompose').execute('t2', { outputPath: 'card.psd', spec })
    expect(textOf(again)).toMatch(/^失败：文件已存在/)
  }, 30_000)

  it('Given 规格文件，When PsdCompose 传 specPath，Then 相对素材按规格文件目录解析', async () => {
    writeFileSync(join(root, 'spec.json'), JSON.stringify({ width: 40, height: 40, layers: [{ type: 'fill', name: '底', color: '#000000' }] }))
    const result = await byName('PsdCompose').execute('t3', { outputPath: 'from-spec.psd', specPath: 'spec.json' })
    expect(textOf(result)).toContain('已生成')
    writeFileSync(join(root, 'bad.json'), '{ not json')
    expect(textOf(await byName('PsdCompose').execute('t4', { outputPath: 'bad.psd', specPath: 'bad.json' }))).toMatch(/不是合法 JSON/)
  }, 30_000)

  it('Given 生成好的文件，When PsdInspect，Then 返回图层树与图；按名字隐藏图层也能渲染', async () => {
    const result = await byName('PsdInspect').execute('t5', { filePath: 'card.psd' })
    const text = textOf(result)
    expect(text).toContain('120×80')
    expect(text).toContain('[0] pixel 底')
    expect(hasImage(result)).toBe(true)
    const hidden = await byName('PsdInspect').execute('t6', { filePath: 'card.psd', hiddenLayers: ['底'] })
    expect(hasImage(hidden)).toBe(true)
    const single = await byName('PsdInspect').execute('t6b', { filePath: 'card.psd', layer: '标题' })
    expect(textOf(single)).toContain('图层 [1] text 标题')
    expect(textOf(single)).toContain('只有这一层自己的像素')
    expect(hasImage(single)).toBe(true)
    expect(textOf(await byName('PsdInspect').execute('t6c', { filePath: 'card.psd', layer: '没有的' }))).toMatch(/^失败：找不到图层/)
  }, 30_000)

  it('Given 生成好的文件，When PsdEdit 改字并另存，Then 摘要列出操作、新文件存在、原文件不变', async () => {
    const before = readFileSync(join(root, 'card.psd'))
    const result = await byName('PsdEdit').execute('t7', { filePath: 'card.psd', outputPath: 'card-v2.psd', operations: [{ op: 'setText', layer: '标题', text: '改好了' }, { op: 'setOpacity', layer: '底', opacity: 0.3 }] })
    const text = textOf(result)
    expect(text).toContain('已写入')
    expect(text).toContain('#1 setText')
    expect(text).toContain('改好了')
    expect(existsSync(join(root, 'card-v2.psd'))).toBe(true)
    expect(readFileSync(join(root, 'card.psd')).equals(before)).toBe(true)
  }, 30_000)

  it('Given 根外路径 / 空操作 / 无授权根，When 调用，Then 返回「失败：」而不是抛异常', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'canopy-psd-tools-outside-'))
    try {
      expect(textOf(await byName('PsdInspect').execute('t8', { filePath: join(outsideDir, 'x.psd') }))).toMatch(/^失败：/)
      expect(textOf(await byName('PsdEdit').execute('t9', { filePath: 'card.psd', operations: [] }))).toMatch(/^失败：operations 不能为空/)
      const noRoots = buildPsdTools({})
      expect(textOf(await noRoots.find((t) => t.name === 'PsdCompose')!.execute('t10', { outputPath: 'x.psd', spec }))).toMatch(/^失败：/)
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })
})
