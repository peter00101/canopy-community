import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PSD_TOOLS_NEGATIVE_PROBE_TTL_MS,
  candidatePythonCommands,
  getPsdToolsAvailability,
  getPsdToolsBridgeScriptPath,
  shouldReprobePsdTools,
  psdToolsComposite,
  psdToolsInspect,
  resetPsdToolsAvailabilityCache,
} from './psd-tools-bridge'
import { composePsd, renderPsd, renderPsdLayer } from './psd-service'

/** 真跑 psd-tools 需要一个装了它的 Python：CANOPY_PSD_TOOLS_PYTHON=<python 可执行文件>；没有就只测纯逻辑 */
const PYTHON = process.env.CANOPY_PSD_TOOLS_PYTHON?.trim()

describe('psd-tools 桥接：探测顺序与脚本位置', () => {
  it('Given 显式指定的解释器，When 列候选，Then 它排第一，其后是 python / python3（Windows 再加 py -3）', () => {
    const list = candidatePythonCommands({ CANOPY_PSD_TOOLS_PYTHON: 'D:/venv/python.exe' }, 'win32')
    expect(list[0]).toEqual({ command: 'D:/venv/python.exe', args: [] })
    expect(list.map((c) => c.command)).toEqual(['D:/venv/python.exe', 'python', 'python3', 'py'])
    expect(candidatePythonCommands({}, 'darwin').map((c) => c.command)).toEqual(['python', 'python3'])
  })

  it('Given 源码树，When 解析桥接脚本位置，Then 能找到随包分发的 psd_tools_bridge.py', () => {
    const path = getPsdToolsBridgeScriptPath()
    expect(path.endsWith(join('psd', 'psd_tools_bridge.py'))).toBe(true)
    expect(existsSync(path)).toBe(true)
  })

  it('Given 探测缓存，When 判断要不要重探，Then 没探过要探、可用不再探、不可用过一分钟才重探（用户装完立即生效但不拖性能）', () => {
    expect(shouldReprobePsdTools(null, 1_000)).toBe(true)
    expect(shouldReprobePsdTools({ available: true, probedAt: 0 }, 10 * PSD_TOOLS_NEGATIVE_PROBE_TTL_MS)).toBe(false)
    expect(shouldReprobePsdTools({ available: false, probedAt: 1_000 }, 1_000 + PSD_TOOLS_NEGATIVE_PROBE_TTL_MS - 1)).toBe(false)
    expect(shouldReprobePsdTools({ available: false, probedAt: 1_000 }, 1_000 + PSD_TOOLS_NEGATIVE_PROBE_TTL_MS)).toBe(true)
    expect(PSD_TOOLS_NEGATIVE_PROBE_TTL_MS).toBe(60_000)
  })
})

describe.skipIf(!PYTHON)('psd-tools 桥接：真跑（需要 CANOPY_PSD_TOOLS_PYTHON）', () => {
  let root = ''
  let psdPath = ''

  beforeAll(async () => {
    resetPsdToolsAvailabilityCache()
    root = mkdtempSync(join(tmpdir(), 'canopy-psd-bridge-'))
    psdPath = join(root, 'bridge.psd')
    await composePsd({
      width: 100,
      height: 60,
      background: '#ffffff',
      layers: [
        { type: 'fill', name: '底', color: '#ff0000' },
        { type: 'group', name: '组', children: [{ type: 'text', name: '字', text: 'psd-tools', fontSize: 16, color: '#000000', left: 4, top: 4, width: 90 }] },
        { type: 'fill', name: '盖', color: '#0000ff', left: 0, top: 0, width: 50, height: 60, hidden: true },
      ],
    }, { roots: [root], specBaseDir: root, outputPsdPath: psdPath, previewPngPath: join(root, 'bridge-preview.png') })
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    resetPsdToolsAvailabilityCache()
  })

  it('Given 装了 psd-tools 的 Python，When 探测，Then 可用并报版本', async () => {
    const availability = await getPsdToolsAvailability()
    expect(availability.available).toBe(true)
    expect(availability.version).toMatch(/^\d+\.\d+/)
  }, 30_000)

  it('Given 我们写出的 PSD，When psd-tools 读取，Then 图层树与内置引擎一致（id / 名字 / 类型 / 显隐）', async () => {
    const info = await psdToolsInspect(psdPath)
    expect(info?.width).toBe(100)
    expect(info?.layers.map((l) => `${l.id}:${l.name}:${l.kind}:${l.hidden ? 'h' : 'v'}`)).toEqual(['0:底:pixel:v', '1:组:group:v', '2:盖:pixel:h'])
    expect(info?.layers[1]?.children?.[0]?.kind).toBe('text')
  }, 30_000)

  it('Given 同一文件，When psd-tools 合成并强制显示被隐藏的层，Then 输出 PNG 且左半变蓝', async () => {
    const out = join(root, 'composite.png')
    const result = await psdToolsComposite(psdPath, out, { visibleIds: ['2'] })
    expect(result?.renderedWidth).toBe(100)
    expect(existsSync(out)).toBe(true)
    const sharp = (await import('sharp')).default
    const { data, info } = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const i = (30 * info.width + 10) * 4
    expect([data[i], data[i + 1], data[i + 2]]).toEqual([0, 0, 255])
  }, 30_000)

  it('Given renderPsd 默认路径，When psd-tools 可用，Then 引擎标记为 psd-tools', async () => {
    const rendered = await renderPsd(psdPath)
    expect(rendered.engine).toBe('psd-tools')
    expect(rendered.layers.map((l) => l.name)).toEqual(['底', '组', '盖'])
  }, 30_000)

  it('Given 含形状 / 调整 / 画板 / 智能对象的文件，When psd-tools 读取，Then 四种类型都被 Photoshop 口径识别；单独导出图层走 psd-tools', async () => {
    const extrasPath = join(root, 'extras.psd')
    const sharp = (await import('sharp')).default
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(root, 'assets'), { recursive: true })
    writeFileSync(join(root, 'assets', 'photo.png'), await sharp({ create: { width: 30, height: 30, channels: 4, background: { r: 0, g: 200, b: 0, alpha: 1 } } }).png().toBuffer())
    await composePsd({
      width: 200,
      height: 120,
      layers: [
        { type: 'fill', name: '底', color: '#2244aa' },
        { type: 'shape', name: '圆', shape: 'ellipse', left: 20, top: 20, width: 40, height: 40, fill: '#ff0000', stroke: { color: '#000000', width: 2 } },
        { type: 'adjustment', name: '反相', adjustment: 'invert' },
        { type: 'adjustment', name: '亮度', adjustment: 'brightness/contrast', brightness: 20 },
        { type: 'adjustment', name: '纯色', adjustment: 'solid color', color: '#123456', hidden: true },
        { type: 'artboard', name: '画板', left: 100, top: 0, width: 100, height: 120, children: [
          { type: 'image', name: '智能', source: 'assets/photo.png', left: 10, top: 10, width: 20, height: 20, smartObject: true },
        ] },
      ],
    }, { roots: [root], specBaseDir: root, outputPsdPath: extrasPath, previewPngPath: join(root, 'extras-preview.png') })
    const info = await psdToolsInspect(extrasPath)
    expect(info?.layers.map((l) => `${l.name}:${l.kind}`)).toEqual(['底:pixel', '圆:shape', '反相:adjustment', '亮度:adjustment', '纯色:adjustment', '画板:artboard'])
    expect(info?.layers[5]?.children?.[0]?.kind).toBe('smart-object')
    // 强制重合成（有显隐改写）时 psd-tools 本身不画画板底色，桥接补画：画板内空白处应是白色而不是透明
    const recomposed = join(root, 'extras-recomposed.png')
    expect(await psdToolsComposite(extrasPath, recomposed, { hiddenIds: ['2', '3'] })).not.toBeNull()
    const { data: rd, info: rmeta } = await sharp(recomposed).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const at = (x: number, y: number): number[] => [...rd.subarray((y * rmeta.width + x) * 4, (y * rmeta.width + x) * 4 + 4)]
    expect(at(105, 5)).toEqual([255, 255, 255, 255])
    expect(at(120, 20)).toEqual([0, 200, 0, 255])
    const circle = await renderPsdLayer(extrasPath, '圆')
    expect(circle.engine).toBe('psd-tools')
    expect(circle.bounds.left).toBeLessThanOrEqual(20)
    expect(circle.bounds.right).toBeGreaterThanOrEqual(60)
    const { data, info: meta } = await sharp(circle.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const center = ((meta.height >> 1) * meta.width + (meta.width >> 1)) * 4
    expect([data[center], data[center + 1], data[center + 2]]).toEqual([255, 0, 0])
  }, 60_000)
})
