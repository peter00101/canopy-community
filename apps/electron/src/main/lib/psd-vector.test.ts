import { describe, expect, it } from 'bun:test'
import { PsdVectorError, bezierPathsToSvgPathData, boundsOfPaths, geometryToBezierPaths, geometryToSvg, parsePathData, translateBezierPaths, translateGeometry } from './psd-vector'

describe('矢量形状：几何 → Photoshop 路径', () => {
  it('Given 直角矩形，When 转路径，Then 4 个直线锚点、控制点与锚点重合、闭合', () => {
    const [path] = geometryToBezierPaths({ shape: 'rect', left: 10, top: 20, width: 100, height: 50 })
    expect(path!.open).toBe(false)
    expect(path!.knots).toHaveLength(4)
    expect(path!.knots[0]!.points).toEqual([10, 20, 10, 20, 10, 20])
    expect(path!.knots[2]!.points).toEqual([110, 70, 110, 70, 110, 70])
    expect(path!.knots.every((k) => !k.linked)).toBe(true)
  })

  it('Given 圆角矩形，When 转路径，Then 8 个锚点且圆角半径被夹到边长一半以内', () => {
    const [path] = geometryToBezierPaths({ shape: 'rect', left: 0, top: 0, width: 40, height: 20, radius: 50 })
    expect(path!.knots).toHaveLength(8)
    // 半径被夹到 10：第一个锚点在 (10, 0)
    expect(path!.knots[0]!.points[2]).toBe(10)
    expect(path!.knots[0]!.points[3]).toBe(0)
  })

  it('Given 椭圆，When 转路径，Then 4 个平滑锚点、控制点按 0.5523 系数、外接矩形等于给定框', () => {
    const paths = geometryToBezierPaths({ shape: 'ellipse', left: 0, top: 0, width: 200, height: 100 })
    const knots = paths[0]!.knots
    expect(knots).toHaveLength(4)
    expect(knots.every((k) => k.linked)).toBe(true)
    expect(knots[0]!.points[2]).toBe(100)
    expect(knots[0]!.points[3]).toBe(0)
    expect(knots[0]!.points[4]).toBeCloseTo(100 + 100 * 0.5522847498, 3)
    expect(boundsOfPaths(paths)).toEqual({ left: 0, top: 0, right: 200, bottom: 100 })
  })

  it('Given 多边形，When 转路径，Then 每点一个直线锚点；少于 3 点报错', () => {
    const [path] = geometryToBezierPaths({ shape: 'polygon', points: [[0, 0], [50, 0], [25, 40]] })
    expect(path!.knots).toHaveLength(3)
    expect(() => geometryToBezierPaths({ shape: 'polygon', points: [[0, 0], [1, 1]] })).toThrow(PsdVectorError)
  })
})

describe('矢量形状：SVG path 数据解析', () => {
  it('Given 绝对 M L Z，When 解析，Then 一条闭合路径、锚点顺序正确', () => {
    const [path] = parsePathData('M 10 10 L 110 10 L 110 60 Z')
    expect(path!.open).toBe(false)
    expect(path!.knots.map((k) => [k.points[2], k.points[3]])).toEqual([[10, 10], [110, 10], [110, 60]])
  })

  it('Given 相对 l / h / v 与 C 曲线，When 解析，Then 坐标累加且曲线控制点落在相邻锚点上', () => {
    const [path] = parsePathData('M0 0 l10 0 v10 h-10 C 0 5 -5 5 -5 0 Z')
    const anchors = path!.knots.map((k) => [k.points[2], k.points[3]])
    expect(anchors).toEqual([[0, 0], [10, 0], [10, 10], [0, 10], [-5, 0]])
    // 第 4 个锚点 (0,10) 的后控制点是 C 的第一个控制点 (0,5)，第 5 个锚点的前控制点是 (-5,5)
    expect([path!.knots[3]!.points[4], path!.knots[3]!.points[5]]).toEqual([0, 5])
    expect([path!.knots[4]!.points[0], path!.knots[4]!.points[1]]).toEqual([-5, 5])
    expect(path!.knots[4]!.linked).toBe(true)
  })

  it('Given Q 二次曲线，When 解析，Then 升成三次并保持终点', () => {
    const [path] = parsePathData('M0 0 Q 50 100 100 0')
    expect(path!.knots).toHaveLength(2)
    expect([path!.knots[1]!.points[2], path!.knots[1]!.points[3]]).toEqual([100, 0])
    expect(path!.knots[0]!.points[4]).toBeCloseTo(100 / 3, 3)
  })

  it('Given 两个 M，When 解析，Then 得到两条路径', () => {
    expect(parsePathData('M0 0 L10 0 L10 10 Z M20 20 L30 20 L30 30 Z')).toHaveLength(2)
  })

  it('Given 不支持的命令 A / S / T 或空数据，When 解析，Then 报错让调用方回退位图', () => {
    expect(() => parsePathData('M0 0 A 10 10 0 0 1 20 20')).toThrow(/不支持/)
    expect(() => parsePathData('')).toThrow(PsdVectorError)
    expect(() => parsePathData('L 1 2')).toThrow(/必须以 M 开头/)
  })
})

describe('矢量形状：栅格化 SVG', () => {
  it('Given 带描边的圆角矩形，When 生成 SVG，Then 尺寸是文档尺寸且元素属性齐全', () => {
    const svg = geometryToSvg({ shape: 'rect', left: 5, top: 5, width: 50, height: 30, radius: 6 }, { fill: '#ff0000', stroke: { color: '#000000', width: 2 } }, 300, 200)
    expect(svg).toContain('width="300" height="200"')
    expect(svg).toContain('<rect x="5" y="5" width="50" height="30" rx="6" ry="6" fill="#ff0000" stroke="#000000" stroke-width="2"/>')
  })

  it('Given 无填充的路径，When 生成 SVG，Then fill="none" 且 d 被转义', () => {
    const svg = geometryToSvg({ shape: 'path', d: 'M0 0 L10 10 Z' }, { fill: null }, 20, 20)
    expect(svg).toContain('fill="none"')
    expect(svg).toContain('d="M0 0 L10 10 Z"')
  })

  it('Given 画板原点偏移，When 生成 SVG，Then 元素包在 translate 里', () => {
    const svg = geometryToSvg({ shape: 'path', d: 'M0 0 L10 10 Z' }, { fill: '#000000' }, 20, 20, { x: 100, y: 50 })
    expect(svg).toContain('<g transform="translate(100 50)">')
  })
})

describe('矢量形状：平移与反向转 SVG', () => {
  it('Given 矩形几何与贝塞尔路径，When 平移，Then 坐标整体加偏移；path 几何本身不动', () => {
    expect(translateGeometry({ shape: 'rect', left: 1, top: 2, width: 3, height: 4 }, 10, 20)).toEqual({ shape: 'rect', left: 11, top: 22, width: 3, height: 4 })
    expect(translateGeometry({ shape: 'polygon', points: [[0, 0], [1, 1], [2, 0]] }, 5, 5).points).toEqual([[5, 5], [6, 6], [7, 5]])
    expect(translateGeometry({ shape: 'path', d: 'M0 0' }, 5, 5).d).toBe('M0 0')
    const [moved] = translateBezierPaths(geometryToBezierPaths({ shape: 'rect', left: 0, top: 0, width: 10, height: 10 }), 3, 4)
    expect(moved!.knots[0]!.points).toEqual([3, 4, 3, 4, 3, 4])
  })

  it('Given Photoshop 路径，When 转回 SVG path data，Then 闭合路径以 M 开头、C 相连、Z 结尾', () => {
    const d = bezierPathsToSvgPathData(geometryToBezierPaths({ shape: 'polygon', points: [[0, 0], [10, 0], [10, 10]] }))
    expect(d.startsWith('M 0 0 C ')).toBe(true)
    expect(d.endsWith(' Z')).toBe(true)
    expect(d.match(/C /g)).toHaveLength(3)
    expect(bezierPathsToSvgPathData([])).toBe('')
  })
})
