/**
 * PSD 合成规格（纯逻辑）：Agent 用一份 JSON 描述「文档 + 自下而上的图层」，这里负责校验、补默认值、
 * 给每层分配稳定 id。不碰文件系统，不依赖 sharp / ag-psd，方便单测。
 *
 * 设计取舍：
 * - 图层顺序**自下而上**（与 Photoshop 图层面板从下往上读一致，也与 ag-psd 的 children 顺序一致）；
 * - 坐标一律以文档左上角为原点的像素；
 * - 文字层只描述内容与样式，像素由 psd-text-render 渲染，Photoshop 打开后仍是可编辑文字层；
 * - 效果（投影 / 外发光 / 描边 / 内阴影 / 渐变叠加）写进 PSD 由 Photoshop 实时渲染，
 *   我方预览合成器对五种都做近似渲染（描边位置、渐变角度等细节以 Photoshop 为准）；
 * - 形状 / 调整 / 画板 / 智能对象是 Photoshop 原生对象：写进 PSD 的是矢量路径、调整参数、画板矩形、
 *   嵌入的原文件，预览用我方近似算法栅格化。
 */

export type PsdBlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten'
  | 'color dodge' | 'color burn' | 'hard light' | 'soft light' | 'difference' | 'exclusion'
  | 'linear dodge' | 'hue' | 'saturation' | 'color' | 'luminosity'

export const PSD_BLEND_MODES: ReadonlySet<string> = new Set<PsdBlendMode>([
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color dodge', 'color burn', 'hard light', 'soft light', 'difference', 'exclusion',
  'linear dodge', 'hue', 'saturation', 'color', 'luminosity',
])

export interface PsdShadowEffectSpec {
  color?: string
  /** 0~1，默认 0.75 */
  opacity?: number
  /** 光源角度（度），Photoshop 口径：120 = 左上打光、影子落在右下；默认 120 */
  angle?: number
  /** 偏移距离（像素），默认 8 */
  distance?: number
  /** 模糊大小（像素），默认 10 */
  size?: number
}

export interface PsdGlowEffectSpec {
  color?: string
  opacity?: number
  size?: number
}

export interface PsdStrokeEffectSpec {
  color?: string
  /** 像素，默认 3 */
  size?: number
  position?: 'outside' | 'inside' | 'center'
  opacity?: number
}

export interface PsdGradientOverlayEffectSpec {
  /** 至少两个颜色，均匀分布 */
  colors: string[]
  /** 度，默认 90（自下而上） */
  angle?: number
  opacity?: number
}

export interface PsdEffectsSpec {
  dropShadow?: PsdShadowEffectSpec
  innerShadow?: PsdShadowEffectSpec
  outerGlow?: PsdGlowEffectSpec
  stroke?: PsdStrokeEffectSpec
  gradientOverlay?: PsdGradientOverlayEffectSpec
}

export interface PsdMaskSpec {
  /** 灰度蒙版图片（png/jpg，白=显示、黑=隐藏），相对规格文件目录或绝对路径 */
  source?: string
  /** 矩形蒙版：只显示矩形内 */
  rect?: { left: number; top: number; width: number; height: number }
  /** 边缘羽化像素 */
  feather?: number
}

interface PsdLayerBaseSpec {
  name: string
  hidden?: boolean
  /** 0~1，默认 1 */
  opacity?: number
  blendMode?: PsdBlendMode
  effects?: PsdEffectsSpec
  mask?: PsdMaskSpec
  /** 剪贴蒙版：只在下一层（更靠下的那层）的不透明区域内显示 */
  clipToBelow?: boolean
}

export interface PsdImageLayerSpec extends PsdLayerBaseSpec {
  type: 'image'
  /** png / jpg / jpeg / webp / gif / svg，相对规格文件目录或绝对路径 */
  source: string
  left?: number
  top?: number
  /** 给了就缩放到该尺寸；只给一边按比例算另一边 */
  width?: number
  height?: number
  /** 同时给了 width/height 时的适配方式，默认 fill（直接拉伸） */
  fit?: 'contain' | 'cover' | 'fill'
  /** 作为智能对象嵌入（原图文件整个存进 PSD，Photoshop 里可双击编辑 / 替换内容） */
  smartObject?: boolean
}

export interface PsdSvgLayerSpec extends PsdLayerBaseSpec {
  type: 'svg'
  /** 内联 SVG 标记（与 source 二选一） */
  svg?: string
  /** SVG 文件路径 */
  source?: string
  left?: number
  top?: number
  /** 栅格化尺寸；不给就按 SVG 自身的 width/height，再不然按文档尺寸 */
  width?: number
  height?: number
}

export interface PsdFillLayerSpec extends PsdLayerBaseSpec {
  type: 'fill'
  color: string
  left?: number
  top?: number
  /** 不给就铺满文档 */
  width?: number
  height?: number
  /** 圆角像素 */
  radius?: number
}

export interface PsdTextLayerSpec extends PsdLayerBaseSpec {
  type: 'text'
  text: string
  /** 字体家族名，如 "Microsoft YaHei"、"Source Han Sans SC"、"Arial"；默认 Microsoft YaHei（Windows）/ PingFang SC（mac） */
  font?: string
  /** 像素，默认 32 */
  fontSize?: number
  color?: string
  bold?: boolean
  italic?: boolean
  align?: 'left' | 'center' | 'right'
  left?: number
  top?: number
  /** 文本框宽度（像素），超出自动换行；不给就到文档右边缘 */
  width?: number
  /** 行高倍数，默认 1.3 */
  lineHeight?: number
  /** 字间距（像素） */
  letterSpacing?: number
}

export interface PsdGroupLayerSpec extends PsdLayerBaseSpec {
  type: 'group'
  children: PsdLayerSpec[]
  /** 打开时组是否展开，默认 true */
  opened?: boolean
}

/** 矢量形状层：Photoshop 里是可拖锚点的形状图层（矢量蒙版 + 填充 / 描边） */
export interface PsdShapeLayerSpec extends PsdLayerBaseSpec {
  type: 'shape'
  shape: 'rect' | 'ellipse' | 'polygon' | 'path'
  /** rect / ellipse 的外接框 */
  left?: number
  top?: number
  width?: number
  height?: number
  /** rect 圆角 */
  radius?: number
  /** polygon 的顶点（文档坐标） */
  points?: Array<[number, number]>
  /** path 的 SVG path data（文档坐标；M L H V C Q Z） */
  d?: string
  /** null = 无填充；默认 #000000 */
  fill?: string | null
  stroke?: { color: string; width: number }
}

export type PsdAdjustmentKind =
  | 'brightness/contrast' | 'hue/saturation' | 'black & white' | 'invert'
  | 'posterize' | 'threshold' | 'exposure' | 'vibrance' | 'photo filter' | 'solid color'

export const PSD_ADJUSTMENT_KINDS: ReadonlySet<string> = new Set<PsdAdjustmentKind>([
  'brightness/contrast', 'hue/saturation', 'black & white', 'invert', 'posterize', 'threshold', 'exposure', 'vibrance', 'photo filter', 'solid color',
])

export interface PsdAdjustmentParams {
  kind: PsdAdjustmentKind
  /** -150 ~ 150 */
  brightness?: number
  /** -50 ~ 100 */
  contrast?: number
  /** -180 ~ 180 */
  hue?: number
  /** -100 ~ 100 */
  saturation?: number
  /** -100 ~ 100 */
  lightness?: number
  /** posterize：2 ~ 255 */
  levels?: number
  /** threshold：1 ~ 255 */
  level?: number
  /** -20 ~ 20 */
  exposure?: number
  /** -0.5 ~ 0.5 */
  offset?: number
  /** 0.01 ~ 9.99 */
  gamma?: number
  /** -100 ~ 100 */
  vibrance?: number
  /** photo filter / solid color 的颜色 */
  color?: string
  /** photo filter 浓度 0 ~ 100 */
  density?: number
}

/** 调整层：作用于它下面的所有图层（clipToBelow 时只作用于下一层） */
export interface PsdAdjustmentLayerSpec extends PsdLayerBaseSpec, Omit<PsdAdjustmentParams, 'kind'> {
  type: 'adjustment'
  adjustment: PsdAdjustmentKind
}

/** 画板：一个文件里放多块画板；children 的坐标相对画板左上角 */
export interface PsdArtboardLayerSpec extends PsdLayerBaseSpec {
  type: 'artboard'
  left: number
  top: number
  width: number
  height: number
  /** 画板底色；null = 透明。默认 #ffffff */
  background?: string | null
  children: PsdLayerSpec[]
}

export type PsdLayerSpec =
  | PsdImageLayerSpec | PsdSvgLayerSpec | PsdFillLayerSpec | PsdTextLayerSpec | PsdGroupLayerSpec
  | PsdShapeLayerSpec | PsdAdjustmentLayerSpec | PsdArtboardLayerSpec

export interface PsdGuideSpec {
  direction: 'horizontal' | 'vertical'
  /** 像素位置 */
  position: number
}

export interface PsdComposeSpec {
  width: number
  height: number
  /** 默认 72 */
  dpi?: number
  /** 底色；null = 透明。默认 #ffffff */
  background?: string | null
  /** 自下而上 */
  layers: PsdLayerSpec[]
  guides?: PsdGuideSpec[]
}

/** 归一化后的规格：所有默认值已填、每层有稳定 id（自下而上路径，如 "2/0"） */
export interface NormalizedPsdLayer {
  id: string
  spec: PsdLayerSpec
  name: string
  hidden: boolean
  opacity: number
  blendMode: PsdBlendMode
  effects: PsdEffectsSpec | undefined
  mask: PsdMaskSpec | undefined
  clipToBelow: boolean
  children?: NormalizedPsdLayer[]
}

export interface NormalizedPsdSpec {
  width: number
  height: number
  dpi: number
  background: string | null
  layers: NormalizedPsdLayer[]
  guides: PsdGuideSpec[]
  warnings: string[]
}

export class PsdSpecError extends Error {}

export const PSD_MAX_DIMENSION = 30_000
export const PSD_MAX_PIXELS = 100_000_000
export const PSD_MAX_LAYERS = 500

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_RE.test(value.trim())
}

function fail(message: string): never {
  throw new PsdSpecError(message)
}

function readNumber(value: unknown, field: string, options: { min?: number; max?: number; integer?: boolean; fallback?: number }): number {
  if (value === undefined || value === null) {
    if (options.fallback === undefined) fail(`${field} 缺失`)
    return options.fallback
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${field} 必须是数字，收到 ${JSON.stringify(value)}`)
  if (options.integer && !Number.isInteger(value)) fail(`${field} 必须是整数，收到 ${value}`)
  if (options.min !== undefined && value < options.min) fail(`${field} 不能小于 ${options.min}，收到 ${value}`)
  if (options.max !== undefined && value > options.max) fail(`${field} 不能大于 ${options.max}，收到 ${value}`)
  return value
}

function readOptionalNumber(value: unknown, field: string, options: { min?: number; max?: number; integer?: boolean }): number | undefined {
  if (value === undefined || value === null) return undefined
  return readNumber(value, field, options)
}

/** 统一成 #rrggbb / #rrggbbaa 小写（#rgb / #rgba 展开） */
export function normalizeHexColor(value: string): string {
  const raw = value.trim().replace(/^#/, '').toLowerCase()
  const full = raw.length === 3 || raw.length === 4 ? raw.split('').map((ch) => ch + ch).join('') : raw
  return `#${full}`
}

function readColor(value: unknown, field: string, fallback?: string): string {
  if (value === undefined || value === null) {
    if (fallback === undefined) fail(`${field} 缺失`)
    return fallback
  }
  if (!isHexColor(value)) fail(`${field} 必须是 #rgb / #rrggbb / #rrggbbaa 形式的颜色，收到 ${JSON.stringify(value)}`)
  return normalizeHexColor(value)
}

function readEffects(value: unknown, where: string, warnings: string[]): PsdEffectsSpec | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) fail(`${where}.effects 必须是对象`)
  const raw = value as Record<string, unknown>
  const out: PsdEffectsSpec = {}
  const shadow = (v: unknown, name: string): PsdShadowEffectSpec => {
    const s = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
    return {
      color: readColor(s.color, `${where}.effects.${name}.color`, '#000000'),
      opacity: readNumber(s.opacity, `${where}.effects.${name}.opacity`, { min: 0, max: 1, fallback: 0.75 }),
      angle: readNumber(s.angle, `${where}.effects.${name}.angle`, { min: -360, max: 360, fallback: 120 }),
      distance: readNumber(s.distance, `${where}.effects.${name}.distance`, { min: 0, max: 1000, fallback: 8 }),
      size: readNumber(s.size, `${where}.effects.${name}.size`, { min: 0, max: 1000, fallback: 10 }),
    }
  }
  if (raw.dropShadow) out.dropShadow = shadow(raw.dropShadow, 'dropShadow')
  if (raw.innerShadow) out.innerShadow = shadow(raw.innerShadow, 'innerShadow')
  if (raw.outerGlow) {
    const g = (typeof raw.outerGlow === 'object' ? raw.outerGlow : {}) as Record<string, unknown>
    out.outerGlow = {
      color: readColor(g.color, `${where}.effects.outerGlow.color`, '#ffffbe'),
      opacity: readNumber(g.opacity, `${where}.effects.outerGlow.opacity`, { min: 0, max: 1, fallback: 0.75 }),
      size: readNumber(g.size, `${where}.effects.outerGlow.size`, { min: 0, max: 1000, fallback: 12 }),
    }
  }
  if (raw.stroke) {
    const s = (typeof raw.stroke === 'object' ? raw.stroke : {}) as Record<string, unknown>
    const position = s.position === 'inside' || s.position === 'center' ? s.position : 'outside'
    out.stroke = {
      color: readColor(s.color, `${where}.effects.stroke.color`, '#000000'),
      size: readNumber(s.size, `${where}.effects.stroke.size`, { min: 0, max: 500, fallback: 3 }),
      position,
      opacity: readNumber(s.opacity, `${where}.effects.stroke.opacity`, { min: 0, max: 1, fallback: 1 }),
    }
    if (position !== 'outside') warnings.push(`${where}：描边位置 ${position} 在预览图里按 outside 近似，Photoshop 里按设置渲染`)
  }
  if (raw.gradientOverlay) {
    const g = (typeof raw.gradientOverlay === 'object' ? raw.gradientOverlay : {}) as Record<string, unknown>
    const colors = Array.isArray(g.colors) ? g.colors : []
    if (colors.length < 2) fail(`${where}.effects.gradientOverlay.colors 至少要两个颜色`)
    out.gradientOverlay = {
      colors: colors.map((c, i) => readColor(c, `${where}.effects.gradientOverlay.colors[${i}]`)),
      angle: readNumber(g.angle, `${where}.effects.gradientOverlay.angle`, { min: -360, max: 360, fallback: 90 }),
      opacity: readNumber(g.opacity, `${where}.effects.gradientOverlay.opacity`, { min: 0, max: 1, fallback: 1 }),
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function readMask(value: unknown, where: string): PsdMaskSpec | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) fail(`${where}.mask 必须是对象`)
  const raw = value as Record<string, unknown>
  const mask: PsdMaskSpec = {}
  if (typeof raw.source === 'string' && raw.source.trim()) mask.source = raw.source.trim()
  if (raw.rect && typeof raw.rect === 'object') {
    const r = raw.rect as Record<string, unknown>
    mask.rect = {
      left: readNumber(r.left, `${where}.mask.rect.left`, { fallback: 0 }),
      top: readNumber(r.top, `${where}.mask.rect.top`, { fallback: 0 }),
      width: readNumber(r.width, `${where}.mask.rect.width`, { min: 1 }),
      height: readNumber(r.height, `${where}.mask.rect.height`, { min: 1 }),
    }
  }
  const feather = readOptionalNumber(raw.feather, `${where}.mask.feather`, { min: 0, max: 500 })
  if (feather !== undefined) mask.feather = feather
  if (!mask.source && !mask.rect) fail(`${where}.mask 需要 source（灰度图）或 rect（矩形）之一`)
  return mask
}

function readLayer(value: unknown, id: string, depth: number, doc: { width: number; height: number }, warnings: string[], counter: { n: number }): NormalizedPsdLayer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`layers[${id}] 必须是对象`)
  counter.n += 1
  if (counter.n > PSD_MAX_LAYERS) fail(`图层超过 ${PSD_MAX_LAYERS} 层上限`)
  if (depth > 8) fail(`layers[${id}] 分组嵌套过深（超过 8 层）`)
  const raw = value as Record<string, unknown>
  const where = `layers[${id}]`
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 255) : `图层 ${id}`
  const type = raw.type
  const opacity = readNumber(raw.opacity, `${where}.opacity`, { min: 0, max: 1, fallback: 1 })
  const blendModeRaw = raw.blendMode === undefined ? 'normal' : raw.blendMode
  if (typeof blendModeRaw !== 'string' || !PSD_BLEND_MODES.has(blendModeRaw)) {
    fail(`${where}.blendMode 不支持：${JSON.stringify(blendModeRaw)}；可用：${[...PSD_BLEND_MODES].join(' / ')}`)
  }
  const base = {
    id,
    name,
    hidden: raw.hidden === true,
    opacity,
    blendMode: blendModeRaw as PsdBlendMode,
    effects: readEffects(raw.effects, where, warnings),
    mask: readMask(raw.mask, where),
    clipToBelow: raw.clipToBelow === true,
  }
  const left = readOptionalNumber(raw.left, `${where}.left`, {})
  const top = readOptionalNumber(raw.top, `${where}.top`, {})
  const width = readOptionalNumber(raw.width, `${where}.width`, { min: 1 })
  const height = readOptionalNumber(raw.height, `${where}.height`, { min: 1 })

  switch (type) {
    case 'image': {
      if (typeof raw.source !== 'string' || !raw.source.trim()) fail(`${where}.source 缺失（图片文件路径）`)
      const fit = raw.fit === 'contain' || raw.fit === 'cover' ? raw.fit : 'fill'
      const spec: PsdImageLayerSpec = { type: 'image', name, source: raw.source.trim(), left: left ?? 0, top: top ?? 0, width, height, fit, smartObject: raw.smartObject === true }
      return { ...base, spec }
    }
    case 'shape': {
      const shape = raw.shape
      if (shape !== 'rect' && shape !== 'ellipse' && shape !== 'polygon' && shape !== 'path') fail(`${where}.shape 必须是 rect / ellipse / polygon / path`)
      const fill = raw.fill === null ? null : readColor(raw.fill, `${where}.fill`, '#000000')
      let stroke: PsdShapeLayerSpec['stroke']
      if (raw.stroke !== undefined && raw.stroke !== null) {
        if (typeof raw.stroke !== 'object') fail(`${where}.stroke 必须是对象 { color, width }`)
        const s = raw.stroke as Record<string, unknown>
        stroke = { color: readColor(s.color, `${where}.stroke.color`, '#000000'), width: readNumber(s.width, `${where}.stroke.width`, { min: 0.1, max: 500, fallback: 2 }) }
      }
      if (fill === null && !stroke) fail(`${where} 既无填充也无描边，什么都画不出来`)
      const spec: PsdShapeLayerSpec = { type: 'shape', name, shape, fill, stroke }
      if (shape === 'rect' || shape === 'ellipse') {
        if (width === undefined || height === undefined) fail(`${where}.width / height 缺失（${shape} 的外接框）`)
        spec.left = left ?? 0
        spec.top = top ?? 0
        spec.width = width
        spec.height = height
        if (shape === 'rect') spec.radius = readNumber(raw.radius, `${where}.radius`, { min: 0, max: 5000, fallback: 0 })
      } else if (shape === 'polygon') {
        if (!Array.isArray(raw.points) || raw.points.length < 3) fail(`${where}.points 至少要 3 个 [x, y]`)
        spec.points = raw.points.map((p, i) => {
          if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number') fail(`${where}.points[${i}] 必须是 [x, y]`)
          return [p[0], p[1]] as [number, number]
        })
      } else {
        if (typeof raw.d !== 'string' || !raw.d.trim()) fail(`${where}.d 缺失（SVG path 数据）`)
        spec.d = raw.d.trim()
      }
      return { ...base, spec }
    }
    case 'adjustment': {
      const kind = raw.adjustment
      if (typeof kind !== 'string' || !PSD_ADJUSTMENT_KINDS.has(kind)) fail(`${where}.adjustment 必须是 ${[...PSD_ADJUSTMENT_KINDS].join(' / ')}`)
      const spec: PsdAdjustmentLayerSpec = {
        type: 'adjustment',
        name,
        adjustment: kind as PsdAdjustmentKind,
        brightness: readOptionalNumber(raw.brightness, `${where}.brightness`, { min: -150, max: 150 }),
        contrast: readOptionalNumber(raw.contrast, `${where}.contrast`, { min: -50, max: 100 }),
        hue: readOptionalNumber(raw.hue, `${where}.hue`, { min: -180, max: 180 }),
        saturation: readOptionalNumber(raw.saturation, `${where}.saturation`, { min: -100, max: 100 }),
        lightness: readOptionalNumber(raw.lightness, `${where}.lightness`, { min: -100, max: 100 }),
        levels: readOptionalNumber(raw.levels, `${where}.levels`, { min: 2, max: 255, integer: true }),
        level: readOptionalNumber(raw.level, `${where}.level`, { min: 1, max: 255, integer: true }),
        exposure: readOptionalNumber(raw.exposure, `${where}.exposure`, { min: -20, max: 20 }),
        offset: readOptionalNumber(raw.offset, `${where}.offset`, { min: -0.5, max: 0.5 }),
        gamma: readOptionalNumber(raw.gamma, `${where}.gamma`, { min: 0.01, max: 9.99 }),
        vibrance: readOptionalNumber(raw.vibrance, `${where}.vibrance`, { min: -100, max: 100 }),
        color: raw.color === undefined || raw.color === null ? undefined : readColor(raw.color, `${where}.color`),
        density: readOptionalNumber(raw.density, `${where}.density`, { min: 0, max: 100 }),
      }
      if ((kind === 'solid color') && !spec.color) fail(`${where}.color 缺失（纯色填充层的颜色）`)
      return { ...base, spec }
    }
    case 'artboard': {
      if (!Array.isArray(raw.children)) fail(`${where}.children 必须是数组`)
      if (width === undefined || height === undefined) fail(`${where}.width / height 缺失（画板尺寸）`)
      const boardLeft = left ?? 0
      const boardTop = top ?? 0
      if (boardLeft + width > doc.width || boardTop + height > doc.height || boardLeft < 0 || boardTop < 0) {
        warnings.push(`${where}「${name}」：画板 (${boardLeft},${boardTop}) ${width}×${height} 超出文档 ${doc.width}×${doc.height}，超出部分会被裁掉`)
      }
      const background = raw.background === null ? null : readColor(raw.background, `${where}.background`, '#ffffff')
      const children = raw.children.map((child, index) => readLayer(child, `${id}/${index}`, depth + 1, { width, height }, warnings, counter))
      const spec: PsdArtboardLayerSpec = { type: 'artboard', name, left: boardLeft, top: boardTop, width, height, background, children: children.map((c) => c.spec) }
      return { ...base, spec, children }
    }
    case 'svg': {
      const svg = typeof raw.svg === 'string' && raw.svg.trim() ? raw.svg : undefined
      const source = typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : undefined
      if (!svg && !source) fail(`${where} 需要 svg（内联标记）或 source（SVG 文件）之一`)
      if (svg && !/<svg[\s>]/i.test(svg)) fail(`${where}.svg 不是 SVG 标记（缺少 <svg 根元素）`)
      const spec: PsdSvgLayerSpec = { type: 'svg', name, svg, source, left: left ?? 0, top: top ?? 0, width, height }
      return { ...base, spec }
    }
    case 'fill': {
      const spec: PsdFillLayerSpec = {
        type: 'fill',
        name,
        color: readColor(raw.color, `${where}.color`),
        left: left ?? 0,
        top: top ?? 0,
        width: width ?? doc.width,
        height: height ?? doc.height,
        radius: readNumber(raw.radius, `${where}.radius`, { min: 0, max: 5000, fallback: 0 }),
      }
      return { ...base, spec }
    }
    case 'text': {
      if (typeof raw.text !== 'string' || !raw.text.trim()) fail(`${where}.text 缺失或为空`)
      const align = raw.align === 'center' || raw.align === 'right' ? raw.align : 'left'
      const font = typeof raw.font === 'string' && raw.font.trim() ? raw.font.trim() : defaultFontFamily()
      const spec: PsdTextLayerSpec = {
        type: 'text',
        name,
        text: raw.text,
        font,
        fontSize: readNumber(raw.fontSize, `${where}.fontSize`, { min: 4, max: 2000, fallback: 32 }),
        color: readColor(raw.color, `${where}.color`, '#000000'),
        bold: raw.bold === true,
        italic: raw.italic === true,
        align,
        left: left ?? 0,
        top: top ?? 0,
        width,
        lineHeight: readNumber(raw.lineHeight, `${where}.lineHeight`, { min: 0.5, max: 5, fallback: 1.3 }),
        letterSpacing: readNumber(raw.letterSpacing, `${where}.letterSpacing`, { min: -50, max: 500, fallback: 0 }),
      }
      return { ...base, spec }
    }
    case 'group': {
      if (!Array.isArray(raw.children)) fail(`${where}.children 必须是数组`)
      const children = raw.children.map((child, index) => readLayer(child, `${id}/${index}`, depth + 1, doc, warnings, counter))
      const spec: PsdGroupLayerSpec = { type: 'group', name, children: children.map((c) => c.spec), opened: raw.opened !== false }
      return { ...base, spec, children }
    }
    default:
      fail(`${where}.type 必须是 image / svg / fill / text / group / shape / adjustment / artboard，收到 ${JSON.stringify(type)}`)
  }
}

/** 系统默认中文字体：Windows 微软雅黑、mac 苹方、其他 Noto */
export function defaultFontFamily(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'Microsoft YaHei'
  if (platform === 'darwin') return 'PingFang SC'
  return 'Noto Sans CJK SC'
}

/**
 * 校验并归一化一份合成规格。任何结构错误都抛 PsdSpecError（信息可直接回给模型改），
 * 不影响成品但值得知道的事放进 warnings。
 */
export function normalizePsdSpec(input: unknown): NormalizedPsdSpec {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('规格必须是 JSON 对象')
  const raw = input as Record<string, unknown>
  const width = readNumber(raw.width, 'width', { min: 1, max: PSD_MAX_DIMENSION, integer: true })
  const height = readNumber(raw.height, 'height', { min: 1, max: PSD_MAX_DIMENSION, integer: true })
  if (width * height > PSD_MAX_PIXELS) fail(`文档 ${width}×${height} 超过 ${PSD_MAX_PIXELS / 1_000_000} 百万像素上限`)
  const dpi = readNumber(raw.dpi, 'dpi', { min: 1, max: 3000, fallback: 72 })
  const background = raw.background === null ? null : readColor(raw.background, 'background', '#ffffff')
  if (!Array.isArray(raw.layers) || raw.layers.length === 0) fail('layers 必须是非空数组（自下而上）')
  const warnings: string[] = []
  const counter = { n: 0 }
  const layers = raw.layers.map((layer, index) => readLayer(layer, String(index), 0, { width, height }, warnings, counter))
  const guides: PsdGuideSpec[] = []
  if (raw.guides !== undefined) {
    if (!Array.isArray(raw.guides)) fail('guides 必须是数组')
    raw.guides.forEach((g, i) => {
      const guide = (g && typeof g === 'object' ? g : {}) as Record<string, unknown>
      const direction = guide.direction === 'vertical' ? 'vertical' : guide.direction === 'horizontal' ? 'horizontal' : fail(`guides[${i}].direction 必须是 horizontal / vertical`)
      guides.push({ direction, position: readNumber(guide.position, `guides[${i}].position`, { min: 0, max: PSD_MAX_DIMENSION }) })
    })
  }
  return { width, height, dpi, background, layers, guides, warnings }
}

/** 扁平列出所有图层（含分组内），自下而上、先子后父的自然顺序无关，仅用于统计与查找 */
export function flattenNormalizedLayers(layers: NormalizedPsdLayer[]): NormalizedPsdLayer[] {
  const out: NormalizedPsdLayer[] = []
  const walk = (list: NormalizedPsdLayer[]): void => {
    for (const layer of list) {
      out.push(layer)
      if (layer.children) walk(layer.children)
    }
  }
  walk(layers)
  return out
}
