/**
 * 受限 SVG（canopy-ppt 契约，1280×720）→ OfficeCLI batch 命令的纯编译器。
 *
 * 目标是让 PPT 里的文字、形状、渐变、图片成为**原生可编辑对象**，而不是整页贴图。
 * 只认 canopy-ppt `references/04-svg-contract.md` 允许的子集；原生预设形状表达不了的东西
 * （path / polyline / polygon / 斜线 / 旋转缩放 / clip-path / mask / filter / 非线性渐变）
 * 不再整页放弃，而是**元素级退回**：把那个元素连同它的祖先 <g> 与页面里的 defs 裁成一张
 * viewBox 只框住它的小 SVG，作为矢量图片贴回原位（z 序不变），页面其余文字与形状照旧可编辑。
 * 只有根本裁不出来的东西（foreignObject / use / style / script / switch、非 16:9 画布、解析失败）
 * 才整页判为 `supported: false`，由调用方退回「整页贴图」并如实报告。
 *
 * 映射事实来自 2026-09-14 的 OfficeCLI 1.0.147 试验：
 * - 长度单位用 pt，1px = 0.75pt（960×540pt 的幻灯片正好对应 1280×720）
 * - textbox 的 text 接受 "\n" 分段，lineSpacing 接受 "1.5x"，margin=0 + autoFit=none + valign=top
 *   让文字框的左上角就是文字的左上角；wordWrap=false 写成 bodyPr wrap="none"，文字不再按框宽折行
 *   （框宽只是估算，实测没有它时「91%」这类粗体数字会被折成两行）
 * - shape 的 geometry=roundRect + adj:val N（N = 圆角 / 短边 × 100000，上限 50000）
 * - shape 的 gradient="C1-C2-ANGLE"（0 = 从左到右，90 = 从上到下），opacity 作用于 fill
 * - 水平 / 垂直细线用薄 rect 最稳（描边宽度即高度），不走 connector
 * - picture 的 src 可以是 .svg：OfficeCLI 存成 ppt/media/image.svg + PNG 占位，PowerPoint 2016+ 与
 *   新版 WPS 按 viewBox 渲染；裁了 viewBox 的小图贴到包围盒位置，与原生对象严丝合缝（试验亲看）
 * - picture 还认 geometry=roundRect / ellipse（写成 pic 的 prstGeom，图片按形状裁）与 crop="l,t,r,b"
 *   （百分比，写成 srcRect），所以 SVG 图片的 meet / slice / 圆角与圆形 clip-path 都能编成原生图片
 *
 * 本文件零 Electron / 文件系统依赖：图片与小图只产出字节交给调用方落盘。
 */
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'

export interface SlideBatchCommand {
  command: 'add'
  parent: string
  type: 'shape' | 'textbox' | 'picture'
  props: Record<string, string>
}

export interface CompiledMediaFile {
  /** 建议文件名（调用方决定目录），形如 p03-img1.png / p03-vec1.svg */
  fileName: string
  mime: string
  bytes: Uint8Array
}

export interface CompiledSlide {
  /** false 表示这页有连矢量小图都裁不出来的东西，调用方应退回整页贴图 */
  supported: boolean
  /** 判为不支持的原因（每条一句） */
  reasons: string[]
  /** 支持但有折损的地方（style 被忽略、越出画布、外链图片跳过等） */
  warnings: string[]
  /** 元素级退回的记录：哪个元素因为什么编成了哪张矢量小图（小图里的内容不可逐字编辑） */
  fragments: string[]
  commands: SlideBatchCommand[]
  media: CompiledMediaFile[]
  stats: { shapes: number; textboxes: number; pictures: number; fragments: number }
}

export interface CompileSvgSlideOptions {
  /** 目标幻灯片路径，如 "/slide[3]" */
  slideParent: string
  /** 图片落盘后的绝对目录（compiler 只拼路径不写文件） */
  mediaDir: string
  /** 图片文件名前缀，如 "p03" */
  mediaPrefix: string
}

/** 2D 仿射矩阵 [a b c d e f]：x' = a·x + c·y + e，y' = b·x + d·y + f */
export type SvgMatrix = readonly [number, number, number, number, number, number]

export interface SvgBox { x0: number; y0: number; x1: number; y1: number }

const SLIDE_WIDTH_PT = 960
const SLIDE_HEIGHT_PT = 540
/** 字体升部占字号的比例：Microsoft YaHei / PingFang 这类中文无衬线约 0.86～0.9，取中值让基线对齐 */
const TEXT_ASCENT_RATIO = 0.88
/** 文字框高度按最后一行再留的下沿（降部 + 行距余量） */
const TEXT_DESCENT_RATIO = 0.4
/** 宽度估算的安全系数：PowerPoint 的字宽比浏览器略宽时不至于折行 */
const TEXT_WIDTH_SAFETY = 1.08
const MIN_LINE_PT = 0.75
const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'
const IDENTITY: SvgMatrix = [1, 0, 0, 1, 0, 0]

/** 连矢量小图都裁不出来（或裁出来也不对）的元素：整页退回贴图 */
const PAGE_FALLBACK_TAGS = new Set(['foreignObject', 'use', 'switch', 'style', 'script'])
/** 原生预设形状表达不了、直接裁成矢量小图的元素 */
const FRAGMENT_TAGS = new Set(['path', 'polyline', 'polygon'])
/** 自身不渲染的定义类节点：遍历时跳过（小图需要时整体带走） */
const IGNORED_TAGS = new Set(['defs', 'title', 'desc', 'metadata', 'clipPath', 'linearGradient', 'radialGradient', 'stop', 'filter', 'mask', 'pattern', 'marker', 'symbol'])
const DEFINITION_TAGS = ['linearGradient', 'radialGradient', 'clipPath', 'filter', 'mask', 'pattern', 'marker', 'symbol'] as const
const FRAGMENT_ATTRIBUTES = ['clip-path', 'mask', 'filter', 'marker-start', 'marker-mid', 'marker-end'] as const

interface Gradient {
  from: string
  to: string
  angle: number
}

interface TextLine { text: string; dx: number; offsetY: number }

const NAMED_COLORS: Record<string, string> = {
  white: '#FFFFFF', black: '#000000', red: '#FF0000', blue: '#0000FF', green: '#008000',
  gray: '#808080', grey: '#808080', transparent: 'none', none: 'none',
}

function px2pt(px: number): string {
  return `${Math.round(px * 0.75 * 100) / 100}pt`
}

function num(value: string | null | undefined, fallback = 0): number {
  if (value == null) return fallback
  const n = Number.parseFloat(String(value).trim())
  return Number.isFinite(n) ? n : fallback
}

/** xmldom 对缺失属性返回 ''（老 DOM 行为），这里统一成 null，让「有没有写这个属性」的判断成立 */
function attr(element: Element, name: string): string | null {
  return element.hasAttribute(name) ? element.getAttribute(name) : null
}

/** 归一到 #RRGGBB；`none` / 透明保持 none；解析不了返回 undefined */
export function normalizeSvgColor(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined
  const value = raw.trim()
  if (!value) return undefined
  const lower = value.toLowerCase()
  if (NAMED_COLORS[lower]) return NAMED_COLORS[lower]
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  const h = hex?.[1]
  if (h) {
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
    return `#${full.toUpperCase()}`
  }
  const [, r, g, b] = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i) ?? []
  if (r !== undefined && g !== undefined && b !== undefined) {
    const toHex = (n: string) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0').toUpperCase()
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`
  }
  return undefined
}

/**
 * 估算一行文字在给定字号下的宽度（px）。中文按 1em，数字与标点约 0.6em，其它拉丁字符约 0.55em，空格 0.3em。
 * 与 canopy-ppt 04 的字宽表同源，宁可偏宽不可偏窄（偏窄会在 PowerPoint 里折行）。
 */
export function estimateTextWidthPx(text: string, fontSizePx: number): number {
  let units = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (ch === ' ') units += 0.3
    else if (code >= 0x2e80 || (code >= 0x3000 && code <= 0x30ff)) units += 1
    else if (/[0-9]/.test(ch)) units += 0.6
    else if (/[A-Z]/.test(ch)) units += 0.68
    else if (/[,.;:'"!|]/.test(ch)) units += 0.3
    else units += 0.55
  }
  return units * fontSizePx
}

/** roundRect 的 adj 值：圆角半径占短边的比例 × 100000，OOXML 上限 50000 */
export function roundRectAdjustment(rx: number, width: number, height: number): number {
  const shorter = Math.max(1, Math.min(width, height))
  return Math.max(0, Math.min(50000, Math.round((rx / shorter) * 100000)))
}

/** 线性渐变的角度：0 = 左→右，90 = 上→下，按 x1/y1/x2/y2（支持百分比或 0～1 小数） */
export function gradientAngle(x1: number, y1: number, x2: number, y2: number): number {
  const angle = Math.round((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI)
  return ((angle % 360) + 360) % 360
}

// ---------------------------------------------------------------------------
// 仿射变换与包围盒（矢量小图需要知道元素在页面坐标系里占多大）
// ---------------------------------------------------------------------------

/** m × n：先施加 n 再施加 m（SVG transform 列表从左到右依次相乘） */
export function multiplyMatrix(m: SvgMatrix, n: SvgMatrix): SvgMatrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

/** 解析 transform 列表（translate / scale / rotate / skewX / skewY / matrix）；空串为单位矩阵，解析不了返回 null */
export function parseSvgTransform(transform: string | null | undefined): SvgMatrix | null {
  if (!transform || !transform.trim()) return IDENTITY
  const pattern = /([a-zA-Z]+)\s*\(([^)]*)\)/g
  const rest = transform.replace(pattern, '').replace(/[\s,]/g, '')
  if (rest) return null
  let result: SvgMatrix = IDENTITY
  for (const match of transform.matchAll(pattern)) {
    const name = match[1] ?? ''
    const args = (match[2] ?? '').trim().split(/[\s,]+/).filter(Boolean).map((v) => Number.parseFloat(v))
    if (args.some((v) => !Number.isFinite(v))) return null
    const [a0 = 0, a1, a2, a3, a4, a5] = args
    let step: SvgMatrix
    switch (name) {
      case 'translate': step = [1, 0, 0, 1, a0, a1 ?? 0]; break
      case 'scale': step = [a0, 0, 0, a1 ?? a0, 0, 0]; break
      case 'rotate': {
        const radians = (a0 * Math.PI) / 180
        const rotation: SvgMatrix = [Math.cos(radians), Math.sin(radians), -Math.sin(radians), Math.cos(radians), 0, 0]
        step = a1 !== undefined && a2 !== undefined
          ? multiplyMatrix(multiplyMatrix([1, 0, 0, 1, a1, a2], rotation), [1, 0, 0, 1, -a1, -a2])
          : rotation
        break
      }
      case 'skewX': step = [1, 0, Math.tan((a0 * Math.PI) / 180), 1, 0, 0]; break
      case 'skewY': step = [1, Math.tan((a0 * Math.PI) / 180), 0, 1, 0, 0]; break
      case 'matrix':
        if (args.length < 6) return null
        step = [a0, a1 ?? 0, a2 ?? 0, a3 ?? 1, a4 ?? 0, a5 ?? 0]
        break
      default:
        return null
    }
    result = multiplyMatrix(result, step)
  }
  return result
}

function isTranslation(m: SvgMatrix): boolean {
  const epsilon = 1e-6
  return Math.abs(m[0] - 1) < epsilon && Math.abs(m[1]) < epsilon && Math.abs(m[2]) < epsilon && Math.abs(m[3] - 1) < epsilon
}

function unionBox(a: SvgBox | null, b: SvgBox | null): SvgBox | null {
  if (!a) return b
  if (!b) return a
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }
}

function transformBox(m: SvgMatrix, box: SvgBox): SvgBox {
  const corners: readonly (readonly [number, number])[] = [[box.x0, box.y0], [box.x1, box.y0], [box.x0, box.y1], [box.x1, box.y1]]
  const xs = corners.map(([x, y]) => m[0] * x + m[2] * y + m[4])
  const ys = corners.map(([x, y]) => m[1] * x + m[3] * y + m[5])
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

function padBox(box: SvgBox, pad: number): SvgBox {
  return { x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad, y1: box.y1 + pad }
}

function pointBox(x: number, y: number): SvgBox {
  return { x0: x, y0: y, x1: x, y1: y }
}

const NUMBER_TOKEN = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g

function pointsBox(points: string | null): SvgBox | null {
  const values = (points ?? '').match(NUMBER_TOKEN)?.map((v) => Number.parseFloat(v)) ?? []
  let box: SvgBox | null = null
  for (let i = 0; i + 1 < values.length; i += 2) box = unionBox(box, pointBox(values[i] ?? 0, values[i + 1] ?? 0))
  return box
}

/**
 * path d 的保守包围盒：收集所有端点与控制点（贝塞尔曲线落在控制点凸包内），
 * S / T 的隐式控制点按反射算出，弧线按两端点 ± 半径外扩。解析不了返回 null。
 */
export function pathDataBox(d: string | null): SvgBox | null {
  const tokens = (d ?? '').match(/[MmZzLlHhVvCcSsQqTtAa]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)
  if (!tokens || tokens.length === 0) return null
  let box: SvgBox | null = null
  let cx = 0
  let cy = 0
  let startX = 0
  let startY = 0
  let command = ''
  let lastControl: { x: number; y: number } | null = null
  let lastKind = ''
  let index = 0
  const add = (x: number, y: number): void => { box = unionBox(box, pointBox(x, y)) }
  while (index < tokens.length) {
    const token = tokens[index]
    if (token !== undefined && /^[A-Za-z]$/.test(token)) {
      command = token
      index += 1
      if (command === 'Z' || command === 'z') { cx = startX; cy = startY; lastKind = 'Z'; continue }
    }
    if (!command) return null
    const relative = command === command.toLowerCase()
    const kind = command.toUpperCase()
    const count = kind === 'H' || kind === 'V' ? 1 : kind === 'C' ? 6 : kind === 'S' || kind === 'Q' ? 4 : kind === 'A' ? 7 : 2
    const args: number[] = []
    for (let k = 0; k < count; k += 1) {
      const token = tokens[index]
      if (token === undefined || /^[A-Za-z]$/.test(token)) return null
      args.push(Number.parseFloat(token))
      index += 1
    }
    const arg = (k: number): number => args[k] ?? 0
    const ox = relative ? cx : 0
    const oy = relative ? cy : 0
    switch (kind) {
      case 'M':
        cx = ox + arg(0); cy = oy + arg(1); startX = cx; startY = cy; add(cx, cy)
        command = relative ? 'l' : 'L'
        lastControl = null
        break
      case 'L':
        cx = ox + arg(0); cy = oy + arg(1); add(cx, cy); lastControl = null
        break
      case 'H':
        cx = ox + arg(0); add(cx, cy); lastControl = null
        break
      case 'V':
        cy = oy + arg(0); add(cx, cy); lastControl = null
        break
      case 'C':
        add(ox + arg(0), oy + arg(1)); add(ox + arg(2), oy + arg(3))
        lastControl = { x: ox + arg(2), y: oy + arg(3) }
        cx = ox + arg(4); cy = oy + arg(5); add(cx, cy)
        break
      case 'S': {
        const reflected: { x: number; y: number } = lastKind === 'C' || lastKind === 'S' ? { x: 2 * cx - (lastControl?.x ?? cx), y: 2 * cy - (lastControl?.y ?? cy) } : { x: cx, y: cy }
        add(reflected.x, reflected.y); add(ox + arg(0), oy + arg(1))
        lastControl = { x: ox + arg(0), y: oy + arg(1) }
        cx = ox + arg(2); cy = oy + arg(3); add(cx, cy)
        break
      }
      case 'Q':
        add(ox + arg(0), oy + arg(1))
        lastControl = { x: ox + arg(0), y: oy + arg(1) }
        cx = ox + arg(2); cy = oy + arg(3); add(cx, cy)
        break
      case 'T': {
        const reflected: { x: number; y: number } = lastKind === 'Q' || lastKind === 'T' ? { x: 2 * cx - (lastControl?.x ?? cx), y: 2 * cy - (lastControl?.y ?? cy) } : { x: cx, y: cy }
        add(reflected.x, reflected.y)
        lastControl = reflected
        cx = ox + arg(0); cy = oy + arg(1); add(cx, cy)
        break
      }
      case 'A': {
        const rx = Math.abs(arg(0))
        const ry = Math.abs(arg(1))
        const endX = ox + arg(5)
        const endY = oy + arg(6)
        add(cx - rx, cy - ry); add(cx + rx, cy + ry); add(endX - rx, endY - ry); add(endX + rx, endY + ry)
        cx = endX; cy = endY; lastControl = null
        break
      }
      default:
        return null
    }
    lastKind = kind
  }
  return box
}

// ---------------------------------------------------------------------------
// 渐变、填充、描边
// ---------------------------------------------------------------------------

function parseGradientCoordinate(raw: string | null, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback
  const value = raw.trim()
  if (value.endsWith('%')) return num(value.slice(0, -1)) / 100
  return num(value, fallback)
}

function collectGradients(root: Element): Map<string, Gradient> {
  const gradients = new Map<string, Gradient>()
  const nodes = root.getElementsByTagName('linearGradient')
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes.item(i)
    if (!node) continue
    const id = attr(node, 'id')
    if (!id) continue
    const stops = node.getElementsByTagName('stop')
    if (stops.length < 2) continue
    const first = stops.item(0)
    const last = stops.item(stops.length - 1)
    const from = normalizeSvgColor(first ? attr(first, 'stop-color') : null)
    const to = normalizeSvgColor(last ? attr(last, 'stop-color') : null)
    if (!from || !to || from === 'none' || to === 'none') continue
    gradients.set(id, {
      from,
      to,
      angle: gradientAngle(
        parseGradientCoordinate(attr(node, 'x1'), 0),
        parseGradientCoordinate(attr(node, 'y1'), 0),
        parseGradientCoordinate(attr(node, 'x2'), 1),
        parseGradientCoordinate(attr(node, 'y2'), 0),
      ),
    })
  }
  return gradients
}

function stripHash(color: string): string {
  return color.startsWith('#') ? color.slice(1) : color
}

function lineProp(element: Element, warnings: string[]): string {
  const stroke = normalizeSvgColor(attr(element, 'stroke'))
  if (!stroke || stroke === 'none') return 'none'
  const widthPx = num(attr(element, 'stroke-width'), 1)
  const widthPt = Math.max(MIN_LINE_PT, Math.round(widthPx * 0.75 * 100) / 100)
  const dash = attr(element, 'stroke-dasharray')
  const style = dash && dash.trim() && dash.trim() !== 'none' ? ':dash' : ''
  if (attr(element, 'stroke-opacity')) warnings.push('描边透明度不支持，已按不透明描边')
  return `${stroke}:${widthPt}${style}`
}

/** 填充 → fill / gradient / opacity。解析不了的填充（进到这里前已由 paintProblem 拦下）按无填充处理 */
function fillProps(element: Element, gradients: Map<string, Gradient>, warnings: string[]): Record<string, string> {
  const props: Record<string, string> = {}
  const rawFill = attr(element, 'fill')
  const fill = rawFill == null ? '#000000' : rawFill.trim()
  const gradientId = fill.match(/^url\(#([^)]+)\)$/)?.[1]
  if (gradientId !== undefined) {
    const gradient = gradients.get(gradientId)
    if (gradient) props.gradient = `${stripHash(gradient.from)}-${stripHash(gradient.to)}-${gradient.angle}`
    else { warnings.push(`渐变 #${gradientId} 未定义，已按无填充`); props.fill = 'none' }
  } else {
    const color = normalizeSvgColor(fill)
    if (!color) { warnings.push(`填充色 ${fill} 解析不了，已按无填充`); props.fill = 'none' }
    else props.fill = color === 'none' ? 'none' : color
  }
  const opacity = attr(element, 'fill-opacity') ?? attr(element, 'opacity')
  if (opacity != null && props.fill !== 'none') {
    const value = Math.max(0, Math.min(1, num(opacity, 1)))
    if (value < 1) props.opacity = String(value)
  }
  return props
}

/** fill / stroke 里原生对象表达不了的画法（非线性渐变、图案、解析不了的颜色）→ 返回一句原因 */
function paintProblem(element: Element, tag: string, gradients: Map<string, Gradient>): string | null {
  for (const paint of ['fill', 'stroke'] as const) {
    const raw = attr(element, paint)
    if (raw == null) continue
    const value = raw.trim()
    if (!value) continue
    const reference = value.match(/^url\(#([^)]+)\)$/)?.[1]
    if (reference !== undefined) {
      if (paint === 'fill' && gradients.has(reference)) continue
      return `<${tag}> 的 ${paint} 引用了 #${reference}（非线性渐变或图案）`
    }
    if (!normalizeSvgColor(value)) return `<${tag}> 的 ${paint} 颜色 ${value} 解析不了`
  }
  return null
}

function boxProps(x: number, y: number, width: number, height: number): Record<string, string> {
  return { x: px2pt(x), y: px2pt(y), width: px2pt(width), height: px2pt(height) }
}

// ---------------------------------------------------------------------------
// 文字
// ---------------------------------------------------------------------------

function textContent(node: Node): string {
  return (node.textContent ?? '').replace(/\s+/g, ' ')
}

/** 把 <text> 及其 <tspan> 拆成行：每个带 x / y / dy 的 tspan 起一行，其余续在当前行；offsetY 是该行基线相对 text 基线的位移 */
function collectTextLines(text: Element, ownX: number, ownY: number): { lines: TextLine[]; lineGapPx: number | null } {
  const lines: TextLine[] = []
  let lineGapPx: number | null = null
  let current: TextLine | null = null
  let offsetY = 0
  const children = text.childNodes
  for (let i = 0; i < children.length; i++) {
    const child = children.item(i)
    if (!child) continue
    if (child.nodeType === 3) {
      const value = textContent(child)
      if (!value.trim()) continue
      if (!current) { current = { text: '', dx: 0, offsetY }; lines.push(current) }
      current.text += value
      continue
    }
    if (child.nodeType !== 1) continue
    const element = child as Element
    if (element.tagName !== 'tspan') continue
    const hasX = attr(element, 'x') != null
    const absoluteY = attr(element, 'y')
    const dy = attr(element, 'dy')
    const startsLine = hasX || dy != null || absoluteY != null || !current
    if (startsLine) {
      const dyValue = dy != null ? num(dy) : 0
      offsetY = absoluteY != null ? num(absoluteY) - ownY : offsetY + dyValue
      if (lines.length > 0 && dyValue > 0) lineGapPx = lineGapPx ?? dyValue
      current = { text: '', dx: hasX ? num(attr(element, 'x')) - ownX : 0, offsetY }
      lines.push(current)
    }
    if (current) current.text += textContent(element)
  }
  return { lines: lines.map((line) => ({ ...line, text: line.text.trim() })).filter((line) => line.text), lineGapPx }
}

function fontFamily(element: Element, inherited: string | null): string {
  const raw = attr(element, 'font-family') ?? inherited ?? 'Microsoft YaHei'
  const first = raw.split(',')[0]?.trim().replace(/^["']|["']$/g, '')
  return first || 'Microsoft YaHei'
}

/**
 * <text> → 文字框。各行 x 一致时合成一个多段文字框；有悬挂缩进（某行 x 不同）时每行单独一个框，
 * 保持每行的起点，文字仍可逐字编辑。offset 是祖先 translate 的累计（未缩放），scale 把画布换算到 1280×720。
 */
function compileText(text: Element, offset: { x: number; y: number }, scale: number, slideParent: string, warnings: string[], inheritedFont: string | null): SlideBatchCommand[] {
  const fontSize = num(attr(text, 'font-size'), 16) * scale
  const ownX = (num(attr(text, 'x')) + offset.x) * scale
  const baselineY = (num(attr(text, 'y')) + offset.y) * scale
  const collected = collectTextLines(text, num(attr(text, 'x')), num(attr(text, 'y')))
  const lines = collected.lines.map((line) => ({ ...line, dx: line.dx * scale, offsetY: line.offsetY * scale }))
  if (lines.length === 0) return []
  const lineGapPx = collected.lineGapPx == null ? null : collected.lineGapPx * scale
  const groups: TextLine[][] = lines.some((line) => line.dx !== 0) ? lines.map((line) => [line]) : [lines]
  const anchor = (attr(text, 'text-anchor') ?? 'start').trim()
  const color = normalizeSvgColor(attr(text, 'fill')) ?? '#000000'
  const weight = (attr(text, 'font-weight') ?? '').trim().toLowerCase()
  const bold = weight === 'bold' || weight === 'bolder' || num(weight, 0) >= 600
  const italic = (attr(text, 'font-style') ?? '').trim().toLowerCase() === 'italic'
  if (attr(text, 'letter-spacing')) warnings.push('letter-spacing 不支持，已忽略')
  const font = fontFamily(text, inheritedFont)
  const commands: SlideBatchCommand[] = []
  for (const group of groups) {
    const first = group[0]
    const last = group[group.length - 1]
    if (!first || !last) continue
    const gap = group.length > 1 ? (last.offsetY - first.offsetY) / (group.length - 1) : (lineGapPx ?? fontSize * 1.25)
    const widest = Math.max(...group.map((line) => estimateTextWidthPx(line.text, fontSize)))
    const widthPx = widest * TEXT_WIDTH_SAFETY + 4
    const heightPx = (last.offsetY - first.offsetY) + fontSize * (TEXT_ASCENT_RATIO + TEXT_DESCENT_RATIO)
    const topPx = baselineY + first.offsetY - fontSize * TEXT_ASCENT_RATIO
    const anchorX = ownX + first.dx
    let leftPx = anchorX
    let align = 'left'
    if (anchor === 'middle') { leftPx = anchorX - widthPx / 2; align = 'center' }
    else if (anchor === 'end') { leftPx = anchorX - widthPx; align = 'right' }
    const props: Record<string, string> = {
      text: group.map((line) => line.text).join('\n'),
      font,
      size: String(Math.round(fontSize * 0.75 * 10) / 10),
      color: color === 'none' ? '#000000' : color,
      ...boxProps(leftPx, topPx, widthPx, heightPx),
      margin: '0',
      autoFit: 'none',
      wordWrap: 'false',
      valign: 'top',
      align,
    }
    if (bold) props.bold = 'true'
    if (italic) props.italic = 'true'
    if (group.length > 1 && gap > 0) props.lineSpacing = `${Math.round((gap / fontSize) * 100) / 100}x`
    commands.push({ command: 'add', parent: slideParent, type: 'textbox', props })
  }
  return commands
}

/** 文字的保守包围盒（只给矢量小图算范围用，不要求精确） */
function textBox(text: Element): SvgBox | null {
  const fontSize = num(attr(text, 'font-size'), 16)
  const x = num(attr(text, 'x'))
  const y = num(attr(text, 'y'))
  const { lines } = collectTextLines(text, x, y)
  if (lines.length === 0) return null
  const width = Math.max(...lines.map((line) => estimateTextWidthPx(line.text, fontSize))) * 1.2
  const anchor = (attr(text, 'text-anchor') ?? 'start').trim()
  const left = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x
  const minDx = Math.min(...lines.map((line) => line.dx))
  const maxOffset = Math.max(...lines.map((line) => line.offsetY))
  return { x0: left + Math.min(0, minDx), y0: y - fontSize * 1.1, x1: left + width + Math.max(0, minDx), y1: y + maxOffset + fontSize * 0.5 }
}

// ---------------------------------------------------------------------------
// 图片
// ---------------------------------------------------------------------------

function decodeDataUri(href: string): { mime: string; bytes: Uint8Array } | null {
  const match = href.trim().match(/^data:(image\/(png|jpeg|jpg|gif));base64,(.+)$/is)
  const rawMime = match?.[1]
  const payload = match?.[3]
  if (!rawMime || !payload) return null
  const mime = rawMime.toLowerCase() === 'image/jpg' ? 'image/jpeg' : rawMime.toLowerCase()
  try {
    const buffer = Buffer.from(payload.replace(/\s+/g, ''), 'base64')
    if (buffer.length === 0) return null
    return { mime, bytes: new Uint8Array(buffer) }
  } catch {
    return null
  }
}

function mimeExtension(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/gif') return 'gif'
  return 'png'
}

/** 只读文件头拿位图原始尺寸（png IHDR / gif 逻辑屏 / jpeg SOF），读不出返回 null */
export function imageIntrinsicSize(bytes: Uint8Array, mime: string): { width: number; height: number } | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let size: { width: number; height: number } | null = null
  if (mime === 'image/png') {
    if (buffer.length >= 24 && buffer.toString('ascii', 12, 16) === 'IHDR') size = { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  } else if (mime === 'image/gif') {
    if (buffer.length >= 10) size = { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
  } else if (mime === 'image/jpeg') {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break
      const marker = buffer[offset + 1] ?? 0
      if (marker === 0xff) { offset += 1; continue }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue }
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isFrame) { size = { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }; break }
      offset += 2 + buffer.readUInt16BE(offset + 2)
    }
  }
  return size && size.width > 0 && size.height > 0 ? size : null
}

interface AspectFit { stretch: boolean; slice: boolean; alignX: number; alignY: number }

/** preserveAspectRatio：缺省 xMidYMid meet；none = 拉伸；slice = 盖满并裁掉溢出 */
function parseAspectFit(raw: string | null): AspectFit {
  const value = (raw ?? '').trim()
  if (/^none\b/i.test(value)) return { stretch: true, slice: false, alignX: 0.5, alignY: 0.5 }
  const align = value.match(/x(Min|Mid|Max)Y(Min|Mid|Max)/i)
  const pick = (token: string | undefined): number => (token?.toLowerCase() === 'min' ? 0 : token?.toLowerCase() === 'max' ? 1 : 0.5)
  return { stretch: false, slice: /\bslice\b/i.test(value), alignX: pick(align?.[1]), alignY: pick(align?.[2]) }
}

interface ClipShape { kind: 'rect' | 'ellipse'; box: SvgBox; rx: number }

/** 只含一个 rect / circle / ellipse 且没有 transform 的 clipPath：能编成原生图片的「裁剪 + 形状」 */
function collectClipShapes(root: Element): Map<string, ClipShape> {
  const shapes = new Map<string, ClipShape>()
  const nodes = root.getElementsByTagName('clipPath')
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes.item(i)
    const id = node ? attr(node, 'id') : null
    if (!node || !id || attr(node, 'transform')) continue
    const children: Element[] = []
    for (let k = 0; k < node.childNodes.length; k++) {
      const child = node.childNodes.item(k)
      if (child && child.nodeType === 1) children.push(child as Element)
    }
    const shape = children[0]
    if (children.length !== 1 || !shape || attr(shape, 'transform')) continue
    if (shape.tagName === 'rect') {
      const x = num(attr(shape, 'x'))
      const y = num(attr(shape, 'y'))
      shapes.set(id, { kind: 'rect', box: { x0: x, y0: y, x1: x + num(attr(shape, 'width')), y1: y + num(attr(shape, 'height')) }, rx: num(attr(shape, 'rx') ?? attr(shape, 'ry'), 0) })
    } else if (shape.tagName === 'circle') {
      const r = num(attr(shape, 'r'))
      shapes.set(id, { kind: 'ellipse', box: { x0: num(attr(shape, 'cx')) - r, y0: num(attr(shape, 'cy')) - r, x1: num(attr(shape, 'cx')) + r, y1: num(attr(shape, 'cy')) + r }, rx: 0 })
    } else if (shape.tagName === 'ellipse') {
      const rx = num(attr(shape, 'rx'))
      const ry = num(attr(shape, 'ry'))
      shapes.set(id, { kind: 'ellipse', box: { x0: num(attr(shape, 'cx')) - rx, y0: num(attr(shape, 'cy')) - ry, x1: num(attr(shape, 'cx')) + rx, y1: num(attr(shape, 'cy')) + ry }, rx: 0 })
    }
  }
  return shapes
}

function intersectBox(a: SvgBox, b: SvgBox): SvgBox | null {
  const box = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) }
  return box.x1 - box.x0 > 0.5 && box.y1 - box.y0 > 0.5 ? box : null
}

function clipReference(node: Element): string | undefined {
  return (attr(node, 'clip-path') ?? '').match(/^url\(#([^)]+)\)$/)?.[1]
}

// ---------------------------------------------------------------------------
// 矢量小图（元素级退回）
// ---------------------------------------------------------------------------

/** 元素（含子树与自身 transform）在 matrix 坐标系下的保守包围盒，已按描边 / 滤镜 / 箭头外扩 */
function elementBox(element: Element, matrix: SvgMatrix): SvgBox | null {
  const tag = element.tagName
  const own = parseSvgTransform(attr(element, 'transform')) ?? IDENTITY
  const m = multiplyMatrix(matrix, own)
  if (tag === 'g' || tag === 'svg' || tag === 'a') {
    let box: SvgBox | null = null
    const children = element.childNodes
    for (let i = 0; i < children.length; i++) {
      const child = children.item(i)
      if (!child || child.nodeType !== 1) continue
      const childElement = child as Element
      if (IGNORED_TAGS.has(childElement.tagName)) continue
      box = unionBox(box, elementBox(childElement, m))
    }
    return box
  }
  let local: SvgBox | null = null
  switch (tag) {
    case 'rect':
    case 'image': {
      const x = num(attr(element, 'x'))
      const y = num(attr(element, 'y'))
      local = { x0: x, y0: y, x1: x + num(attr(element, 'width')), y1: y + num(attr(element, 'height')) }
      break
    }
    case 'circle': {
      const r = num(attr(element, 'r'))
      local = { x0: num(attr(element, 'cx')) - r, y0: num(attr(element, 'cy')) - r, x1: num(attr(element, 'cx')) + r, y1: num(attr(element, 'cy')) + r }
      break
    }
    case 'ellipse': {
      const rx = num(attr(element, 'rx'))
      const ry = num(attr(element, 'ry'))
      local = { x0: num(attr(element, 'cx')) - rx, y0: num(attr(element, 'cy')) - ry, x1: num(attr(element, 'cx')) + rx, y1: num(attr(element, 'cy')) + ry }
      break
    }
    case 'line':
      local = unionBox(pointBox(num(attr(element, 'x1')), num(attr(element, 'y1'))), pointBox(num(attr(element, 'x2')), num(attr(element, 'y2'))))
      break
    case 'polyline':
    case 'polygon':
      local = pointsBox(attr(element, 'points'))
      break
    case 'path':
      local = pathDataBox(attr(element, 'd'))
      break
    case 'text':
      local = textBox(element)
      break
    default:
      return null
  }
  if (!local) return null
  const stroke = (attr(element, 'stroke') ?? '').trim()
  const strokeWidth = num(attr(element, 'stroke-width'), 1)
  // 尖角 miter 可以伸出描边宽度的好几倍，path 类按 2 倍描边留；其余按半个描边
  let pad = stroke && stroke !== 'none' ? (FRAGMENT_TAGS.has(tag) || tag === 'line' ? strokeWidth * 2 : strokeWidth / 2) : 0
  if (attr(element, 'filter')) pad += 24
  if (attr(element, 'marker-start') || attr(element, 'marker-mid') || attr(element, 'marker-end')) pad += strokeWidth * 4 + 8
  const stretch = Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]), 1e-6)
  return padBox(transformBox(m, local), pad * stretch + 1)
}

/** 取整并裁到画布内；裁完不足 1px 视为不可见 */
function snapBox(box: SvgBox, width: number, height: number): SvgBox | null {
  const x0 = Math.max(0, Math.floor(box.x0))
  const y0 = Math.max(0, Math.floor(box.y0))
  const x1 = Math.min(width, Math.ceil(box.x1))
  const y1 = Math.min(height, Math.ceil(box.y1))
  if (x1 - x0 < 1 || y1 - y0 < 1) return null
  return { x0, y0, x1, y1 }
}

/** 页面里所有定义类节点（渐变 / 裁剪 / 滤镜 / 遮罩 / 图案 / 箭头 / 符号）的序列化，小图整体带走 */
function collectDefinitions(root: Element, serializer: XMLSerializer): string {
  const nodes: Element[] = []
  for (const tag of DEFINITION_TAGS) {
    const list = root.getElementsByTagName(tag)
    for (let i = 0; i < list.length; i++) {
      const node = list.item(i)
      if (node) nodes.push(node)
    }
  }
  const set = new Set<Node>(nodes)
  const topLevel = nodes.filter((node) => {
    let parent: Node | null = node.parentNode
    while (parent) {
      if (set.has(parent)) return false
      parent = parent.parentNode
    }
    return true
  })
  return topLevel.map((node) => serializer.serializeToString(node)).join('')
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

/** 祖先 <g> 的开标签：保留 transform / fill / 字体等继承属性，去掉 id / class / style */
function ancestorOpenTag(element: Element): string {
  const parts: string[] = []
  const attributes = element.attributes
  for (let i = 0; i < attributes.length; i++) {
    const attribute = attributes.item(i)
    if (!attribute) continue
    const name = attribute.name
    if (name === 'id' || name === 'class' || name === 'style' || name.startsWith('xmlns')) continue
    parts.push(`${name}="${escapeAttribute(attribute.value)}"`)
  }
  return `<g${parts.length ? ` ${parts.join(' ')}` : ''}>`
}

/**
 * 小图的坐标系平移到原点（viewBox 从 0 0 起、内容整体 translate 回去）：OfficeCLI 的预览渲染器
 * 对「viewBox 原点不为 0 + clip-path」会整张渲染成空白（试验亲看），PowerPoint 本身两种写法都认。
 */
function buildFragmentSvg(element: Element, ancestors: readonly Element[], definitions: string, box: SvgBox, serializer: XMLSerializer): string {
  const width = box.x1 - box.x0
  const height = box.y1 - box.y0
  const open = ancestors.map(ancestorOpenTag).join('')
  const close = '</g>'.repeat(ancestors.length)
  return `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${definitions ? `<defs>${definitions}</defs>` : ''}<g transform="translate(${-box.x0} ${-box.y0})">${open}${serializer.serializeToString(element)}${close}</g></svg>`
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 编译一页。返回的 commands 里 parent 已是 options.slideParent；调用方负责先 `add slide`、
 * 把 media 落盘到 options.mediaDir（文件名即 media[].fileName），再把整批交给 OfficeCLI batch。
 */
export function compileSvgSlide(svgText: string, options: CompileSvgSlideOptions): CompiledSlide {
  const reasons: string[] = []
  const warnings: string[] = []
  const fragments: string[] = []
  const commands: SlideBatchCommand[] = []
  const media: CompiledMediaFile[] = []
  const stats = { shapes: 0, textboxes: 0, pictures: 0, fragments: 0 }

  const doc = new DOMParser({
    errorHandler: { warning: () => undefined, error: (message) => reasons.push(`SVG 解析错误：${String(message).slice(0, 120)}`), fatalError: (message) => reasons.push(`SVG 解析失败：${String(message).slice(0, 120)}`) },
  }).parseFromString(svgText, 'image/svg+xml')
  const root = doc.documentElement
  if (!root || root.tagName !== 'svg') {
    return { supported: false, reasons: ['根节点不是 <svg>'], warnings, fragments, commands, media, stats }
  }
  const viewBox = (attr(root, 'viewBox') ?? '').trim().split(/[\s,]+/).map((v) => num(v))
  const vbWidth = (viewBox.length === 4 ? viewBox[2] : undefined) ?? num(attr(root, 'width'), 1280)
  const vbHeight = (viewBox.length === 4 ? viewBox[3] : undefined) ?? num(attr(root, 'height'), 720)
  if (Math.abs(vbWidth / vbHeight - 16 / 9) > 0.01) reasons.push(`画布 ${vbWidth}×${vbHeight} 不是 16:9`)
  if (vbWidth !== 1280 || vbHeight !== 720) warnings.push(`画布 ${vbWidth}×${vbHeight} 按 1280×720 等比换算`)
  const scale = 1280 / (vbWidth || 1280)
  const gradients = collectGradients(root)
  const clipShapes = collectClipShapes(root)
  const serializer = new XMLSerializer()
  const definitions = collectDefinitions(root, serializer)
  const mediaDir = options.mediaDir.replace(/[\\/]+$/, '')
  let imageCount = 0
  let fragmentCount = 0

  /** 把一个元素（含子树）裁成矢量小图贴回原位 */
  const emitFragment = (node: Element, ancestors: readonly Element[], matrix: SvgMatrix, why: string): void => {
    const box = elementBox(node, matrix)
    const snapped = box ? snapBox(box, vbWidth, vbHeight) : null
    if (!snapped) { warnings.push(`${why}，但算不出可见范围，已跳过`); return }
    fragmentCount += 1
    const fileName = `${options.mediaPrefix}-vec${fragmentCount}.svg`
    const svg = buildFragmentSvg(node, ancestors, definitions, snapped, serializer)
    media.push({ fileName, mime: 'image/svg+xml', bytes: new Uint8Array(Buffer.from(svg, 'utf-8')) })
    commands.push({
      command: 'add', parent: options.slideParent, type: 'picture',
      props: { src: `${mediaDir}/${fileName}`, ...boxProps(snapped.x0 * scale, snapped.y0 * scale, (snapped.x1 - snapped.x0) * scale, (snapped.y1 - snapped.y0) * scale) },
    })
    stats.fragments += 1
    fragments.push(`${why} → 矢量小图 ${fileName}`)
  }

  /** 原生对象表达不了、需要裁成小图的理由；null 表示可以走原生 */
  const fragmentReason = (node: Element, tag: string, local: SvgMatrix): string | null => {
    if (FRAGMENT_TAGS.has(tag)) return `<${tag}>`
    if (!isTranslation(local)) return `<${tag}> 的 transform 含旋转 / 缩放 / 斜切`
    if (tag === 'image') {
      const clipId = clipReference(node)
      if (attr(node, 'clip-path') && (clipId === undefined || !clipShapes.has(clipId))) return '<image> 的 clip-path 不是单个矩形 / 圆 / 椭圆'
      for (const name of ['mask', 'filter'] as const) if (attr(node, name)) return `<${tag}> 带 ${name}`
      return null
    }
    for (const name of FRAGMENT_ATTRIBUTES) if (attr(node, name)) return `<${tag}> 带 ${name}`
    if (tag === 'g' || tag === 'a') {
      const opacity = attr(node, 'opacity')
      if (opacity != null && num(opacity, 1) < 1) return `<${tag}> 带整体透明度`
      return null
    }
    if (tag === 'line') {
      const horizontal = Math.abs(num(attr(node, 'y1')) - num(attr(node, 'y2'))) < 0.01
      const vertical = Math.abs(num(attr(node, 'x1')) - num(attr(node, 'x2'))) < 0.01
      if (!horizontal && !vertical) return '<line> 是斜线'
    }
    if (tag === 'text' && node.getElementsByTagName('textPath').length > 0) return '<text> 含 textPath'
    return paintProblem(node, tag, gradients)
  }

  const visit = (node: Element, ancestors: readonly Element[], matrix: SvgMatrix, inheritedFont: string | null): void => {
    const tag = node.tagName
    if (PAGE_FALLBACK_TAGS.has(tag)) { reasons.push(`<${tag}> 无法映射成原生对象，也裁不成矢量小图`); return }
    if (IGNORED_TAGS.has(tag)) return
    if (attr(node, 'style') || attr(node, 'class')) warnings.push(`<${tag}> 的 style/class 属性被忽略`)
    const own = parseSvgTransform(attr(node, 'transform'))
    if (!own) { reasons.push(`<${tag}> 的 transform 解析不了`); return }
    const local = multiplyMatrix(matrix, own)
    const why = tag === 'svg' ? null : fragmentReason(node, tag, local)
    if (why) { emitFragment(node, ancestors, matrix, why); return }
    const font = attr(node, 'font-family') ?? inheritedFont
    const offset = { x: local[4], y: local[5] }

    if (tag === 'g' || tag === 'svg' || tag === 'a') {
      const nextAncestors = tag === 'svg' ? ancestors : [...ancestors, node]
      const children = node.childNodes
      for (let i = 0; i < children.length; i++) {
        const child = children.item(i)
        if (child && child.nodeType === 1) visit(child as Element, nextAncestors, local, font)
      }
      return
    }

    if (tag === 'rect') {
      const x = (num(attr(node, 'x')) + offset.x) * scale
      const y = (num(attr(node, 'y')) + offset.y) * scale
      const width = num(attr(node, 'width')) * scale
      const height = num(attr(node, 'height')) * scale
      const rx = num(attr(node, 'rx') ?? attr(node, 'ry'), 0) * scale
      const props: Record<string, string> = { geometry: rx > 0 ? 'roundRect' : 'rect', ...boxProps(x, y, width, height), ...fillProps(node, gradients, warnings), line: lineProp(node, warnings) }
      if (rx > 0) props.adj = `adj:val ${roundRectAdjustment(rx, width, height)}`
      commands.push({ command: 'add', parent: options.slideParent, type: 'shape', props })
      stats.shapes += 1
      return
    }

    if (tag === 'circle' || tag === 'ellipse') {
      const cx = (num(attr(node, 'cx')) + offset.x) * scale
      const cy = (num(attr(node, 'cy')) + offset.y) * scale
      const rx = num(tag === 'circle' ? attr(node, 'r') : attr(node, 'rx')) * scale
      const ry = num(tag === 'circle' ? attr(node, 'r') : attr(node, 'ry')) * scale
      commands.push({ command: 'add', parent: options.slideParent, type: 'shape', props: { geometry: 'ellipse', ...boxProps(cx - rx, cy - ry, rx * 2, ry * 2), ...fillProps(node, gradients, warnings), line: lineProp(node, warnings) } })
      stats.shapes += 1
      return
    }

    if (tag === 'line') {
      const x1 = (num(attr(node, 'x1')) + offset.x) * scale
      const y1 = (num(attr(node, 'y1')) + offset.y) * scale
      const x2 = (num(attr(node, 'x2')) + offset.x) * scale
      const y2 = (num(attr(node, 'y2')) + offset.y) * scale
      const stroke = normalizeSvgColor(attr(node, 'stroke'))
      if (!stroke || stroke === 'none') return
      const thickness = Math.max(1, num(attr(node, 'stroke-width'), 1) * scale)
      const horizontal = Math.abs(y1 - y2) < 0.01
      const props: Record<string, string> = horizontal
        ? { geometry: 'rect', ...boxProps(Math.min(x1, x2), y1 - thickness / 2, Math.abs(x2 - x1), thickness), fill: stroke, line: 'none' }
        : { geometry: 'rect', ...boxProps(x1 - thickness / 2, Math.min(y1, y2), thickness, Math.abs(y2 - y1)), fill: stroke, line: 'none' }
      const opacity = attr(node, 'stroke-opacity')
      if (opacity != null && num(opacity, 1) < 1) props.opacity = String(Math.max(0, num(opacity, 1)))
      commands.push({ command: 'add', parent: options.slideParent, type: 'shape', props })
      stats.shapes += 1
      return
    }

    if (tag === 'text') {
      const textboxes = compileText(node, offset, scale, options.slideParent, warnings, font)
      for (const command of textboxes) commands.push(command)
      stats.textboxes += textboxes.length
      return
    }

    if (tag === 'image') {
      const href = attr(node, 'href') ?? attr(node, 'xlink:href') ?? ''
      const decoded = decodeDataUri(href)
      if (!decoded) { warnings.push('<image> 只支持 png/jpeg/gif 的 data URI，外链或其它格式已跳过'); return }
      const boxX = (num(attr(node, 'x')) + offset.x) * scale
      const boxY = (num(attr(node, 'y')) + offset.y) * scale
      const boxW = num(attr(node, 'width')) * scale
      const boxH = num(attr(node, 'height')) * scale
      const box: SvgBox = { x0: boxX, y0: boxY, x1: boxX + boxW, y1: boxY + boxH }
      // 先按 preserveAspectRatio 算出位图内容实际铺到哪（meet 居中留白、slice 盖满溢出、none 拉伸）
      const fit = parseAspectFit(attr(node, 'preserveAspectRatio'))
      const size = imageIntrinsicSize(decoded.bytes, decoded.mime)
      let content = box
      if (!fit.stretch && size && boxW > 0 && boxH > 0) {
        const ratio = fit.slice ? Math.max(boxW / size.width, boxH / size.height) : Math.min(boxW / size.width, boxH / size.height)
        const contentW = size.width * ratio
        const contentH = size.height * ratio
        const contentX = boxX + (boxW - contentW) * fit.alignX
        const contentY = boxY + (boxH - contentH) * fit.alignY
        content = { x0: contentX, y0: contentY, x1: contentX + contentW, y1: contentY + contentH }
      } else if (!fit.stretch && !size) {
        warnings.push('<image> 读不出位图原始尺寸，已按拉伸铺满')
      }
      // 可见区 = 内容 ∩ 图片框 ∩ 裁切形状；溢出的部分用 PowerPoint 的图片裁剪（srcRect）切掉
      let visible = intersectBox(content, box)
      const clip = (() => { const id = clipReference(node); return id === undefined ? undefined : clipShapes.get(id) })()
      let geometry: string | undefined
      let adjustment: string | undefined
      if (clip && visible) {
        const clipBox: SvgBox = { x0: (clip.box.x0 + offset.x) * scale, y0: (clip.box.y0 + offset.y) * scale, x1: (clip.box.x1 + offset.x) * scale, y1: (clip.box.y1 + offset.y) * scale }
        visible = intersectBox(visible, clipBox)
        if (clip.kind === 'ellipse') geometry = 'ellipse'
        else if (clip.rx > 0 && visible) { geometry = 'roundRect'; adjustment = `adj:val ${roundRectAdjustment(clip.rx * scale, visible.x1 - visible.x0, visible.y1 - visible.y0)}` }
      }
      if (!visible) { warnings.push('<image> 裁切后没有可见区域，已跳过'); return }
      imageCount += 1
      const fileName = `${options.mediaPrefix}-img${imageCount}.${mimeExtension(decoded.mime)}`
      media.push({ fileName, mime: decoded.mime, bytes: decoded.bytes })
      const props: Record<string, string> = { src: `${mediaDir}/${fileName}`, ...boxProps(visible.x0, visible.y0, visible.x1 - visible.x0, visible.y1 - visible.y0) }
      const contentW = content.x1 - content.x0
      const contentH = content.y1 - content.y0
      const crop = [
        (visible.x0 - content.x0) / contentW,
        (visible.y0 - content.y0) / contentH,
        (content.x1 - visible.x1) / contentW,
        (content.y1 - visible.y1) / contentH,
      ].map((fraction) => Math.max(0, Math.round(fraction * 10000) / 100))
      if (crop.some((percent) => percent > 0)) props.crop = crop.join(',')
      if (geometry) props.geometry = geometry
      if (adjustment) props.adj = adjustment
      const opacity = attr(node, 'opacity')
      if (opacity != null && num(opacity, 1) < 1) props.opacity = String(Math.max(0, num(opacity, 1)))
      commands.push({ command: 'add', parent: options.slideParent, type: 'picture', props })
      stats.pictures += 1
      return
    }

    reasons.push(`<${tag}> 不在契约允许的元素里`)
  }

  visit(root, [], IDENTITY, null)

  // 契约外的坐标：越出画布的对象会在 PowerPoint 里露到页外，作为警告而不是拒绝
  for (const command of commands) {
    const x = Number.parseFloat(command.props.x ?? '0')
    const y = Number.parseFloat(command.props.y ?? '0')
    const w = Number.parseFloat(command.props.width ?? '0')
    const h = Number.parseFloat(command.props.height ?? '0')
    if (x < -0.5 || y < -0.5 || x + w > SLIDE_WIDTH_PT + 0.5 || y + h > SLIDE_HEIGHT_PT + 0.5) {
      warnings.push(`${command.type} 越出画布：x=${command.props.x} y=${command.props.y} w=${command.props.width} h=${command.props.height}`)
    }
  }

  return { supported: reasons.length === 0, reasons, warnings, fragments, commands, media, stats }
}
