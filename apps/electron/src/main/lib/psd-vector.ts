/**
 * 矢量形状（纯逻辑）：把规格里的 rect / ellipse / polygon / path 变成两样东西——
 * ① 栅格化用的 SVG（预览与图层像素）；② Photoshop 矢量蒙版的贝塞尔路径（ag-psd 的 BezierPath，坐标单位像素）。
 *
 * Photoshop 路径记录里每个锚点是「前控制点、锚点、后控制点」三对坐标；直线段的控制点与锚点重合。
 */

import type { BezierKnot, BezierPath } from 'ag-psd'

export interface RectGeometry {
  shape: 'rect'
  left: number
  top: number
  width: number
  height: number
  /** 圆角半径，0 = 直角 */
  radius?: number
}

export interface EllipseGeometry {
  shape: 'ellipse'
  left: number
  top: number
  width: number
  height: number
}

export interface PolygonGeometry {
  shape: 'polygon'
  /** 文档坐标 */
  points: Array<[number, number]>
}

export interface PathGeometry {
  shape: 'path'
  /** SVG path data（文档坐标；支持 M L H V C Q Z 及小写相对形式） */
  d: string
}

export type ShapeGeometry = RectGeometry | EllipseGeometry | PolygonGeometry | PathGeometry

export class PsdVectorError extends Error {}

/** 圆弧用三次贝塞尔近似的控制点系数 */
const KAPPA = 0.5522847498

function knot(inX: number, inY: number, x: number, y: number, outX: number, outY: number, linked = false): BezierKnot {
  return { linked, points: [inX, inY, x, y, outX, outY] }
}

function corner(x: number, y: number): BezierKnot {
  return knot(x, y, x, y, x, y, false)
}

function rectPath(geometry: RectGeometry): BezierPath {
  const { left, top, width, height } = geometry
  const right = left + width
  const bottom = top + height
  const r = Math.max(0, Math.min(geometry.radius ?? 0, width / 2, height / 2))
  if (r <= 0) {
    return { open: false, operation: 'combine', fillRule: 'non-zero', knots: [corner(left, top), corner(right, top), corner(right, bottom), corner(left, bottom)] }
  }
  const k = r * KAPPA
  // 顺时针：从左上角圆弧的起点开始，每个角两个锚点
  const knots: BezierKnot[] = [
    knot(left + r - k, top, left + r, top, left + r, top),
    knot(right - r, top, right - r, top, right - r + k, top),
    knot(right, top + r - k, right, top + r, right, top + r),
    knot(right, bottom - r, right, bottom - r, right, bottom - r + k),
    knot(right - r + k, bottom, right - r, bottom, right - r, bottom),
    knot(left + r, bottom, left + r, bottom, left + r - k, bottom),
    knot(left, bottom - r + k, left, bottom - r, left, bottom - r),
    knot(left, top + r, left, top + r, left, top + r - k),
  ]
  return { open: false, operation: 'combine', fillRule: 'non-zero', knots }
}

function ellipsePath(geometry: EllipseGeometry): BezierPath {
  const cx = geometry.left + geometry.width / 2
  const cy = geometry.top + geometry.height / 2
  const rx = geometry.width / 2
  const ry = geometry.height / 2
  const kx = rx * KAPPA
  const ky = ry * KAPPA
  const knots: BezierKnot[] = [
    knot(cx - kx, cy - ry, cx, cy - ry, cx + kx, cy - ry, true),
    knot(cx + rx, cy - ky, cx + rx, cy, cx + rx, cy + ky, true),
    knot(cx + kx, cy + ry, cx, cy + ry, cx - kx, cy + ry, true),
    knot(cx - rx, cy + ky, cx - rx, cy, cx - rx, cy - ky, true),
  ]
  return { open: false, operation: 'combine', fillRule: 'non-zero', knots }
}

function polygonPath(geometry: PolygonGeometry): BezierPath {
  if (geometry.points.length < 3) throw new PsdVectorError('多边形至少要 3 个点')
  return { open: false, operation: 'combine', fillRule: 'non-zero', knots: geometry.points.map(([x, y]) => corner(x, y)) }
}

interface PendingKnot {
  x: number
  y: number
  inX: number
  inY: number
  outX?: number
  outY?: number
  curved: boolean
}

function tokenizePathData(d: string): Array<string | number> {
  const tokens: Array<string | number> = []
  const re = /([MmLlHhVvCcQqZzSsTtAa])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(d)) !== null) {
    if (match[1]) tokens.push(match[1])
    else tokens.push(Number(match[2]))
  }
  return tokens
}

/** SVG path data → 若干条路径（每个 M 开一条）；只支持 M L H V C Q Z（S T A 直接拒绝，调用方回退位图） */
export function parsePathData(d: string): BezierPath[] {
  const tokens = tokenizePathData(d)
  const paths: BezierPath[] = []
  let current: PendingKnot[] = []
  let open = true
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let command = ''
  let i = 0

  const finish = (): void => {
    if (current.length > 0) {
      const knots = current.map((k) => knot(k.inX, k.inY, k.x, k.y, k.outX ?? k.x, k.outY ?? k.y, k.curved))
      paths.push({ open, operation: 'combine', fillRule: 'non-zero', knots })
    }
    current = []
    open = true
  }
  const next = (): number => {
    const value = tokens[i++]
    if (typeof value !== 'number') throw new PsdVectorError(`path 数据不完整（命令 ${command} 缺少参数）`)
    return value
  }
  const lineTo = (nx: number, ny: number): void => {
    current.push({ x: nx, y: ny, inX: nx, inY: ny, curved: false })
    x = nx
    y = ny
  }
  const cubicTo = (c1x: number, c1y: number, c2x: number, c2y: number, nx: number, ny: number): void => {
    const previous = current[current.length - 1]
    if (previous) {
      previous.outX = c1x
      previous.outY = c1y
      previous.curved = true
    }
    current.push({ x: nx, y: ny, inX: c2x, inY: c2y, curved: true })
    x = nx
    y = ny
  }

  while (i < tokens.length) {
    const token = tokens[i]
    if (typeof token === 'string') {
      command = token
      i++
      if (command === 'Z' || command === 'z') {
        open = false
        x = startX
        y = startY
        finish()
        continue
      }
    }
    if (!command || (current.length === 0 && command.toUpperCase() !== 'M')) throw new PsdVectorError('path 数据必须以 M 开头')
    const relative = command === command.toLowerCase()
    switch (command.toUpperCase()) {
      case 'M': {
        const nx = next()
        const ny = next()
        finish()
        x = relative ? x + nx : nx
        y = relative ? y + ny : ny
        startX = x
        startY = y
        current.push({ x, y, inX: x, inY: y, curved: false })
        // M 后面的连续坐标按 L 处理
        command = relative ? 'l' : 'L'
        break
      }
      case 'L': {
        const nx = next()
        const ny = next()
        lineTo(relative ? x + nx : nx, relative ? y + ny : ny)
        break
      }
      case 'H': {
        const nx = next()
        lineTo(relative ? x + nx : nx, y)
        break
      }
      case 'V': {
        const ny = next()
        lineTo(x, relative ? y + ny : ny)
        break
      }
      case 'C': {
        const c1x = next(); const c1y = next(); const c2x = next(); const c2y = next(); const nx = next(); const ny = next()
        const ox = relative ? x : 0
        const oy = relative ? y : 0
        cubicTo(ox + c1x, oy + c1y, ox + c2x, oy + c2y, ox + nx, oy + ny)
        break
      }
      case 'Q': {
        const qx = next(); const qy = next(); const nx = next(); const ny = next()
        const ox = relative ? x : 0
        const oy = relative ? y : 0
        const cqx = ox + qx
        const cqy = oy + qy
        const ex = ox + nx
        const ey = oy + ny
        // 二次 → 三次
        cubicTo(x + (2 / 3) * (cqx - x), y + (2 / 3) * (cqy - y), ex + (2 / 3) * (cqx - ex), ey + (2 / 3) * (cqy - ey), ex, ey)
        break
      }
      default:
        throw new PsdVectorError(`path 命令 ${command} 不支持（只支持 M L H V C Q Z），请用三次贝塞尔改写`)
    }
  }
  finish()
  if (paths.length === 0) throw new PsdVectorError('path 数据为空')
  return paths
}

/** 规格几何 → Photoshop 矢量蒙版路径（像素坐标） */
export function geometryToBezierPaths(geometry: ShapeGeometry): BezierPath[] {
  switch (geometry.shape) {
    case 'rect':
      return [rectPath(geometry)]
    case 'ellipse':
      return [ellipsePath(geometry)]
    case 'polygon':
      return [polygonPath(geometry)]
    case 'path':
      return parsePathData(geometry.d).map((path) => ({ ...path, open: false }))
    default:
      throw new PsdVectorError('未知形状')
  }
}

export interface ShapeStyle {
  /** null = 无填充 */
  fill: string | null
  stroke?: { color: string; width: number }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** 规格几何 → 文档尺寸的 SVG（栅格化用）；offset 是整体平移（画板原点） */
export function geometryToSvg(geometry: ShapeGeometry, style: ShapeStyle, docWidth: number, docHeight: number, offset: { x: number; y: number } = { x: 0, y: 0 }): string {
  const fill = style.fill ? `fill="${escapeAttr(style.fill)}"` : 'fill="none"'
  const stroke = style.stroke ? `stroke="${escapeAttr(style.stroke.color)}" stroke-width="${style.stroke.width}"` : 'stroke="none"'
  let element: string
  switch (geometry.shape) {
    case 'rect':
      element = `<rect x="${geometry.left}" y="${geometry.top}" width="${geometry.width}" height="${geometry.height}" rx="${geometry.radius ?? 0}" ry="${geometry.radius ?? 0}" ${fill} ${stroke}/>`
      break
    case 'ellipse':
      element = `<ellipse cx="${geometry.left + geometry.width / 2}" cy="${geometry.top + geometry.height / 2}" rx="${geometry.width / 2}" ry="${geometry.height / 2}" ${fill} ${stroke}/>`
      break
    case 'polygon':
      element = `<polygon points="${geometry.points.map(([x, y]) => `${x},${y}`).join(' ')}" ${fill} ${stroke}/>`
      break
    case 'path':
      element = `<path d="${escapeAttr(geometry.d)}" ${fill} ${stroke}/>`
      break
    default:
      throw new PsdVectorError('未知形状')
  }
  const body = offset.x === 0 && offset.y === 0 ? element : `<g transform="translate(${offset.x} ${offset.y})">${element}</g>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${docWidth}" height="${docHeight}">${body}</svg>`
}

/** 整体平移（画板里的子层坐标相对画板，写入文档前要加上画板原点） */
export function translateGeometry<T extends ShapeGeometry>(geometry: T, dx: number, dy: number): T {
  if (dx === 0 && dy === 0) return geometry
  switch (geometry.shape) {
    case 'rect':
    case 'ellipse':
      return { ...geometry, left: geometry.left + dx, top: geometry.top + dy }
    case 'polygon':
      return { ...geometry, points: geometry.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) }
    case 'path':
      // path 数据本身不改，交给 SVG 的 transform 与贝塞尔路径的整体平移
      return geometry
    default:
      return geometry
  }
}

export function translateBezierPaths(paths: BezierPath[], dx: number, dy: number): BezierPath[] {
  if (dx === 0 && dy === 0) return paths
  return paths.map((path) => ({
    ...path,
    knots: path.knots.map((k) => ({ linked: k.linked, points: k.points.map((v, i) => v + (i % 2 === 0 ? dx : dy)) })),
  }))
}

/** Photoshop 贝塞尔路径 → SVG path data（读取 Photoshop 自己画的形状层时用来栅格化） */
export function bezierPathsToSvgPathData(paths: BezierPath[]): string {
  const parts: string[] = []
  for (const path of paths) {
    const knots = path.knots
    if (knots.length === 0) continue
    const first = knots[0]!
    parts.push(`M ${first.points[2]} ${first.points[3]}`)
    const segmentTo = (from: BezierKnot, to: BezierKnot): string =>
      `C ${from.points[4]} ${from.points[5]} ${to.points[0]} ${to.points[1]} ${to.points[2]} ${to.points[3]}`
    for (let i = 1; i < knots.length; i++) parts.push(segmentTo(knots[i - 1]!, knots[i]!))
    if (!path.open) {
      if (knots.length > 1) parts.push(segmentTo(knots[knots.length - 1]!, first))
      parts.push('Z')
    }
  }
  return parts.join(' ')
}

/** 路径外接矩形（用于 Photoshop 的 boundingBox 与图层定位） */
export function boundsOfPaths(paths: BezierPath[]): { left: number; top: number; right: number; bottom: number } {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const path of paths) {
    for (const k of path.knots) {
      for (let i = 0; i < 6; i += 2) {
        const x = k.points[i] ?? 0
        const y = k.points[i + 1] ?? 0
        if (x < left) left = x
        if (x > right) right = x
        if (y < top) top = y
        if (y > bottom) bottom = y
      }
    }
  }
  if (!Number.isFinite(left)) return { left: 0, top: 0, right: 0, bottom: 0 }
  return { left, top, right, bottom }
}
