import { describe, expect, it } from 'bun:test'
import { PSD_MAX_DIMENSION, PsdSpecError, flattenNormalizedLayers, normalizePsdSpec } from './psd-spec'

const minimal = { width: 100, height: 80, layers: [{ type: 'fill', name: '底', color: '#ffffff' }] }

describe('PSD 合成规格：归一化与默认值', () => {
  it('Given 只给尺寸和一层纯色，When 归一化，Then 补齐 dpi / 底色 / 不透明度 / 混合模式并分配 id', () => {
    const spec = normalizePsdSpec(minimal)
    expect(spec.dpi).toBe(72)
    expect(spec.background).toBe('#ffffff')
    expect(spec.layers).toHaveLength(1)
    const layer = spec.layers[0]!
    expect(layer.id).toBe('0')
    expect(layer.opacity).toBe(1)
    expect(layer.blendMode).toBe('normal')
    expect(layer.hidden).toBe(false)
    expect(layer.spec.type === 'fill' && layer.spec.width).toBe(100)
  })

  it('Given 分组嵌套，When 归一化，Then 子层 id 是自下而上的路径', () => {
    const spec = normalizePsdSpec({
      ...minimal,
      layers: [
        { type: 'fill', color: '#000' },
        { type: 'group', name: '文案', children: [{ type: 'text', text: '标题' }, { type: 'text', text: '副标题', align: 'center' }] },
      ],
    })
    const ids = flattenNormalizedLayers(spec.layers).map((l) => l.id)
    expect(ids).toEqual(['0', '1', '1/0', '1/1'])
    const group = spec.layers[1]!
    expect(group.children?.[1]?.spec.type === 'text' && group.children[1].spec.align).toBe('center')
  })

  it('Given 文字层缺省字段，When 归一化，Then 字号 32 / 行高 1.3 / 黑色 / 左对齐 / 系统默认字体', () => {
    const spec = normalizePsdSpec({ ...minimal, layers: [{ type: 'text', text: '你好' }] })
    const text = spec.layers[0]!.spec
    if (text.type !== 'text') throw new Error('type')
    expect(text.fontSize).toBe(32)
    expect(text.lineHeight).toBe(1.3)
    expect(text.color).toBe('#000000')
    expect(text.align).toBe('left')
    expect(text.font?.length).toBeGreaterThan(0)
  })

  it('Given background 为 null，When 归一化，Then 保持透明底', () => {
    expect(normalizePsdSpec({ ...minimal, background: null }).background).toBeNull()
  })
})

describe('PSD 合成规格：结构错误直接拒绝（信息可回给模型改）', () => {
  it('Given 没有 layers，When 归一化，Then 抛 PsdSpecError', () => {
    expect(() => normalizePsdSpec({ width: 10, height: 10, layers: [] })).toThrow(PsdSpecError)
  })

  it('Given 不认识的混合模式，When 归一化，Then 报错并列出可用值', () => {
    expect(() => normalizePsdSpec({ ...minimal, layers: [{ type: 'fill', color: '#000', blendMode: 'plus' }] })).toThrow(/blendMode 不支持.*multiply/)
  })

  it('Given 颜色不是 hex，When 归一化，Then 报错指出字段', () => {
    expect(() => normalizePsdSpec({ ...minimal, layers: [{ type: 'fill', color: 'red' }] })).toThrow(/layers\[0\]\.color/)
  })

  it('Given 未知图层类型 / 文字层无内容 / 蒙版两者皆无，When 归一化，Then 各自报错', () => {
    expect(() => normalizePsdSpec({ ...minimal, layers: [{ type: 'video' }] })).toThrow(/type 必须是/)
    expect(() => normalizePsdSpec({ ...minimal, layers: [{ type: 'text', text: '  ' }] })).toThrow(/text 缺失/)
    expect(() => normalizePsdSpec({ ...minimal, layers: [{ type: 'fill', color: '#000', mask: {} }] })).toThrow(/mask 需要/)
  })

  it('Given 尺寸超上限或像素超预算，When 归一化，Then 拒绝', () => {
    expect(() => normalizePsdSpec({ ...minimal, width: PSD_MAX_DIMENSION + 1 })).toThrow(/不能大于/)
    expect(() => normalizePsdSpec({ ...minimal, width: 20000, height: 20000 })).toThrow(/百万像素/)
  })

  it('Given 渐变叠加只有一个颜色，When 归一化，Then 报错；两个颜色则通过、短色值展开且不再提醒', () => {
    expect(() => normalizePsdSpec({ ...minimal, layers: [{ type: 'fill', color: '#000', effects: { gradientOverlay: { colors: ['#fff'] } } }] })).toThrow(/至少要两个颜色/)
    const spec = normalizePsdSpec({ ...minimal, layers: [{ type: 'fill', color: '#000', effects: { gradientOverlay: { colors: ['#fff', '#000'] }, innerShadow: {} } }] })
    expect(spec.warnings).toEqual([])
    expect(spec.layers[0]!.effects?.gradientOverlay?.colors).toEqual(['#ffffff', '#000000'])
    expect(spec.layers[0]!.effects?.innerShadow?.angle).toBe(120)
  })
})

describe('PSD 合成规格：形状 / 调整 / 画板 / 智能对象', () => {
  it('Given 四种形状，When 归一化，Then 各自保留几何字段、填充默认黑、描边可选', () => {
    const spec = normalizePsdSpec({ ...minimal, layers: [
      { type: 'shape', shape: 'rect', left: 1, top: 2, width: 30, height: 20, radius: 4, stroke: { color: '#f00', width: 2 } },
      { type: 'shape', shape: 'ellipse', width: 10, height: 10, fill: '#0f0' },
      { type: 'shape', shape: 'polygon', points: [[0, 0], [10, 0], [5, 8]], fill: null, stroke: { color: '#000' } },
      { type: 'shape', shape: 'path', d: ' M0 0 L10 10 Z ' },
    ] })
    const [rect, ellipse, polygon, path] = spec.layers.map((l) => l.spec as Extract<typeof l.spec, { type: 'shape' }>)
    expect(rect).toMatchObject({ shape: 'rect', left: 1, top: 2, width: 30, height: 20, radius: 4, fill: '#000000', stroke: { color: '#ff0000', width: 2 } })
    expect(ellipse).toMatchObject({ shape: 'ellipse', left: 0, top: 0, fill: '#00ff00' })
    expect(ellipse!.stroke).toBeUndefined()
    expect(polygon).toMatchObject({ fill: null, stroke: { color: '#000000', width: 2 }, points: [[0, 0], [10, 0], [5, 8]] })
    expect(path!.d).toBe('M0 0 L10 10 Z')
  })

  it('Given 形状缺外接框 / 多边形不足 3 点 / 既无填充也无描边，When 归一化，Then 各自报错', () => {
    expect(() => normalizePsdSpec({ ...minimal, layers: [{ type: 'shape', shape: 'rect' }] })).toThrow(/width \/ height 缺失/)
    expect(() => normalizePsdSpec({ ...minimal, layers: [{ type: 'shape', shape: 'polygon', points: [[0, 0], [1, 1]] }] })).toThrow(/至少要 3 个/)
    expect(() => normalizePsdSpec({ ...minimal, layers: [{ type: 'shape', shape: 'path', d: 'M0 0', fill: null }] })).toThrow(/既无填充也无描边/)
    expect(() => normalizePsdSpec({ ...minimal, layers: [{ type: 'shape', shape: 'star' }] })).toThrow(/rect \/ ellipse \/ polygon \/ path/)
  })

  it('Given 调整层，When 归一化，Then 参数按范围校验、纯色层必须给颜色', () => {
    const spec = normalizePsdSpec({ ...minimal, layers: [
      { type: 'adjustment', adjustment: 'brightness/contrast', brightness: 30, contrast: -10, clipToBelow: true },
      { type: 'adjustment', adjustment: 'solid color', color: '#abc', opacity: 0.4 },
    ] })
    expect(spec.layers[0]!.spec).toMatchObject({ type: 'adjustment', adjustment: 'brightness/contrast', brightness: 30, contrast: -10 })
    expect(spec.layers[0]!.clipToBelow).toBe(true)
    expect(spec.layers[1]!.spec).toMatchObject({ adjustment: 'solid color', color: '#aabbcc' })
    expect(() => normalizePsdSpec({ ...minimal, layers: [{ type: 'adjustment', adjustment: 'solid color' }] })).toThrow(/color 缺失/)
    expect(() => normalizePsdSpec({ ...minimal, layers: [{ type: 'adjustment', adjustment: 'curves' }] })).toThrow(/adjustment 必须是/)
    expect(() => normalizePsdSpec({ ...minimal, layers: [{ type: 'adjustment', adjustment: 'posterize', levels: 1 }] })).toThrow(/levels 不能小于 2/)
  })

  it('Given 画板含子层与超出文档的画板，When 归一化，Then 子层 id 挂在画板下、底色默认白、越界给提醒', () => {
    const spec = normalizePsdSpec({ ...minimal, layers: [
      { type: 'artboard', name: '首页', left: 0, top: 0, width: 50, height: 50, children: [{ type: 'fill', color: '#000', width: 10, height: 10 }] },
      { type: 'artboard', name: '越界', left: 80, top: 0, width: 50, height: 50, background: null, children: [] },
    ] })
    expect(spec.layers[0]!.children?.[0]?.id).toBe('0/0')
    expect((spec.layers[0]!.spec as Extract<typeof spec.layers[0]['spec'], { type: 'artboard' }>).background).toBe('#ffffff')
    expect((spec.layers[1]!.spec as Extract<typeof spec.layers[0]['spec'], { type: 'artboard' }>).background).toBeNull()
    expect(spec.warnings.some((w) => w.includes('越界') && w.includes('超出文档'))).toBe(true)
    expect(() => normalizePsdSpec({ ...minimal, layers: [{ type: 'artboard', width: 10, height: 10 }] })).toThrow(/children 必须是数组/)
  })

  it('Given 图片层 smartObject: true，When 归一化，Then 标记保留', () => {
    const spec = normalizePsdSpec({ ...minimal, layers: [{ type: 'image', source: 'a.png', smartObject: true }] })
    expect((spec.layers[0]!.spec as Extract<typeof spec.layers[0]['spec'], { type: 'image' }>).smartObject).toBe(true)
  })
})
