/**
 * 把一组受限 SVG 页编排成一份 PPTX 的批处理计划（纯逻辑）+ 落盘执行。
 *
 * 每页两条路：`native`（svg-slide-compiler 编成原生形状 / 文本框 / 图片，可在 PowerPoint 里逐字编辑）
 * 或 `picture`（整页 SVG 贴图，0.18.85 canopy-ppt 第一阶段的路线）。默认 native：原生表达不了的单个元素
 * 由编译器裁成矢量小图贴回原位（元素级退回，页面其余仍可编辑），只有整页裁不出来时才退回 picture 并记原因；
 * 调用方（OfficeSlidesFromSvg 工具）把小图清单与原因原样报给模型，模型写进 README。
 *
 * 整批只调用一次 OfficeCLI batch（原子：任一条失败整份回滚），媒体文件先落到 `<pptx 同目录>/media/`。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { isPathWithinRoots, realpathOrResolve, resolveExistingRealPath } from './file-access-policy'
import { OfficeDocumentAccessError, describeEnvelope, runOfficeCliJson } from './officecli-service'
import { compileSvgSlide, type CompiledMediaFile, type SlideBatchCommand } from './svg-slide-compiler'

export type SvgDeckMode = 'native' | 'picture'

export interface SvgDeckBatchCommand {
  command: 'add'
  parent: string
  type: 'slide' | 'shape' | 'textbox' | 'picture'
  props?: Record<string, string>
}

export interface SvgDeckPagePlan {
  index: number
  svgPath: string
  route: SvgDeckMode
  /** native 被退回 picture 的原因；主动选 picture 时为空 */
  reasons: string[]
  warnings: string[]
  /** 元素级退回：这页里哪些元素因为什么编成了矢量小图（小图内容不可逐字编辑） */
  fragments: string[]
  stats: { shapes: number; textboxes: number; pictures: number; fragments: number }
}

export interface SvgDeckPlan {
  pages: SvgDeckPagePlan[]
  commands: SvgDeckBatchCommand[]
  media: { path: string; bytes: Uint8Array }[]
}

/** 单张 SVG 源文件的上限：契约要求图片走 data URI，一页 1MB 图 + 文本绰绰有余 */
const MAX_SVG_BYTES = 4 * 1024 * 1024
const SLIDE_WIDTH_IN = '13.333in'
const SLIDE_HEIGHT_IN = '7.5in'

/** 读 SVG 源文件的授权判定：与 Office 文档同一套根集合，只认 .svg、≤4MB、常规文件 */
export function resolveReadableSvgPath(filePath: string, authorizedRoots: readonly string[], baseDir?: string): string {
  if (!filePath || typeof filePath !== 'string') throw new OfficeDocumentAccessError('未提供 SVG 路径')
  if (extname(filePath).toLowerCase() !== '.svg') throw new OfficeDocumentAccessError(`只接受 .svg 文件，收到 ${basename(filePath)}`)
  if (authorizedRoots.length === 0) throw new OfficeDocumentAccessError('当前会话没有已授权的目录，无法读取 SVG')
  const absolute = isAbsolute(filePath) ? filePath : resolve(baseDir || process.cwd(), filePath)
  const resolved = resolveExistingRealPath(absolute)
  if (!resolved) throw new OfficeDocumentAccessError(`SVG 不存在：${filePath}`)
  if (!isPathWithinRoots(resolved, () => authorizedRoots.map((root) => realpathOrResolve(root)))) {
    throw new OfficeDocumentAccessError(`SVG 不在本次会话已授权的目录内：${filePath}`)
  }
  const stats = statSync(resolved)
  if (!stats.isFile()) throw new OfficeDocumentAccessError(`不是常规文件：${filePath}`)
  if (stats.size > MAX_SVG_BYTES) throw new OfficeDocumentAccessError(`SVG 超过 ${MAX_SVG_BYTES / 1024 / 1024}MB：${basename(filePath)}`)
  return resolved
}

function fullPagePicture(slideParent: string, svgPath: string): SvgDeckBatchCommand {
  return { command: 'add', parent: slideParent, type: 'picture', props: { src: svgPath, x: '0', y: '0', width: SLIDE_WIDTH_IN, height: SLIDE_HEIGHT_IN } }
}

function mediaPrefix(svgPath: string, index: number): string {
  const stem = basename(svgPath, extname(svgPath)).replace(/[^A-Za-z0-9_-]/g, '')
  return stem || `p${String(index).padStart(2, '0')}`
}

/**
 * 纯规划：给定每页的 SVG 路径与内容，产出整份的 batch 命令与待落盘媒体。
 * `mode: 'picture'` 一律贴图；`'native'` 逐页尝试编译，不支持的页退回贴图。
 */
export function planSvgDeck(
  pages: readonly { svgPath: string; svgText: string }[],
  options: { mode: SvgDeckMode; mediaDir: string },
): SvgDeckPlan {
  const plan: SvgDeckPlan = { pages: [], commands: [], media: [] }
  pages.forEach((page, i) => {
    const index = i + 1
    const slideParent = `/slide[${index}]`
    plan.commands.push({ command: 'add', parent: '/', type: 'slide' })
    if (options.mode === 'picture') {
      plan.commands.push(fullPagePicture(slideParent, page.svgPath))
      plan.pages.push({ index, svgPath: page.svgPath, route: 'picture', reasons: [], warnings: [], fragments: [], stats: { shapes: 0, textboxes: 0, pictures: 1, fragments: 0 } })
      return
    }
    const compiled = compileSvgSlide(page.svgText, { slideParent, mediaDir: options.mediaDir, mediaPrefix: mediaPrefix(page.svgPath, index) })
    if (!compiled.supported || compiled.commands.length === 0) {
      plan.commands.push(fullPagePicture(slideParent, page.svgPath))
      plan.pages.push({
        index, svgPath: page.svgPath, route: 'picture',
        reasons: compiled.commands.length === 0 && compiled.supported ? ['页面里没有可编译的元素'] : compiled.reasons,
        warnings: compiled.warnings, fragments: [], stats: { shapes: 0, textboxes: 0, pictures: 1, fragments: 0 },
      })
      return
    }
    for (const command of compiled.commands) plan.commands.push(command as SlideBatchCommand)
    for (const file of compiled.media) plan.media.push({ path: join(options.mediaDir, file.fileName), bytes: file.bytes })
    plan.pages.push({ index, svgPath: page.svgPath, route: 'native', reasons: [], warnings: compiled.warnings, fragments: compiled.fragments, stats: compiled.stats })
  })
  return plan
}

export interface BuildSvgDeckResult {
  success: boolean
  message: string
  pages: SvgDeckPagePlan[]
}

/** 小图清单按原因归并计数（「<path> ×3、<line> 是斜线 ×1」），全部列出而不是只截前几条 */
function summarizeFragments(fragments: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const entry of fragments) {
    const reason = entry.split(' → ')[0] ?? entry
    counts.set(reason, (counts.get(reason) ?? 0) + 1)
  }
  return [...counts.entries()].map(([reason, count]) => `${reason} ×${count}`).join('、')
}

/** 给模型看的逐页汇总：哪页原生、哪页贴图及原因，越界等警告 */
export function describeSvgDeckPlan(pages: readonly SvgDeckPagePlan[]): string {
  const native = pages.filter((page) => page.route === 'native').length
  const lines = [`共 ${pages.length} 页：原生可编辑 ${native} 页，整页贴图 ${pages.length - native} 页。`]
  for (const page of pages) {
    const name = basename(page.svgPath)
    if (page.route === 'native') {
      const fragmentNote = page.stats.fragments > 0 ? `；矢量小图不可逐字编辑：${summarizeFragments(page.fragments)}` : ''
      lines.push(`- 第 ${page.index} 页 ${name}：原生（形状 ${page.stats.shapes} / 文字框 ${page.stats.textboxes} / 图片 ${page.stats.pictures} / 矢量小图 ${page.stats.fragments}）${fragmentNote}${page.warnings.length ? `；警告：${page.warnings.slice(0, 3).join('；')}` : ''}`)
    } else {
      lines.push(`- 第 ${page.index} 页 ${name}：贴图${page.reasons.length ? `，原因：${page.reasons.slice(0, 3).join('；')}` : ''}`)
    }
  }
  return lines.join('\n')
}

/**
 * 落盘执行：读 SVG、写媒体、`create` 空 pptx、一次 batch。
 * `target` 与 `svgPaths` 必须已经过授权判定（resolveCreatableOfficePath / resolveReadableSvgPath）。
 */
export async function buildSvgDeck(target: string, svgPaths: readonly string[], mode: SvgDeckMode): Promise<BuildSvgDeckResult> {
  const mediaDir = join(dirname(target), 'media')
  const pages = svgPaths.map((svgPath) => ({ svgPath, svgText: readFileSync(svgPath, 'utf-8') }))
  const plan = planSvgDeck(pages, { mode, mediaDir })
  if (plan.media.length > 0) {
    if (!existsSync(mediaDir)) mkdirSync(mediaDir, { recursive: true })
    for (const file of plan.media) writeFileSync(file.path, file.bytes)
  }
  const created = await runOfficeCliJson(['create', target])
  if (!created.success) return { success: false, message: `新建 PPTX 失败：${describeEnvelope(created)}`, pages: plan.pages }
  const batch = await runOfficeCliJson(['batch', target], { stdin: JSON.stringify(plan.commands) })
  if (!batch.success) return { success: false, message: `写入失败（整批已回滚）：${describeEnvelope(batch)}`, pages: plan.pages }
  return { success: true, message: `已生成 ${target}\n${describeSvgDeckPlan(plan.pages)}`, pages: plan.pages }
}
