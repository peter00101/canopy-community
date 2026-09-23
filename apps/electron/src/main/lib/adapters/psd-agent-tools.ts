/**
 * PSD 工具组：读取（PsdInspect）、合成（PsdCompose）、编辑（PsdEdit）。
 *
 * 能力来自随包分发的 ag-psd + sharp，**不需要用户装 Photoshop 或 Python**；用户机器上恰好有
 * Python + psd-tools 时读取与合成自动升级为高保真引擎（psd-tools-bridge）。三个工具都把合成图
 * 作为图片块返回，模型看得见自己做出来的东西，能自检版式（与 OfficeInspect 的 screenshot 同思路）。
 *
 * 路径一律经 psd-paths 落在会话授权根内；输出默认不覆盖已有文件。
 */

import { dirname } from 'node:path'
import { readFile } from 'node:fs/promises'
import { Type } from 'typebox'
import type { KernelToolDefinition, KernelToolResult } from '@canopy/kernel'
import { PsdSpecError } from '../psd-spec'
import {
  PsdAccessError,
  PSD_EXTENSIONS,
  defaultPreviewPngPath,
  resolveReadablePsdPath,
  resolveReadableSpecPath,
  resolveWritablePath,
} from '../psd-paths'
import { MODEL_PREVIEW_MAX_SIDE, composePsd, describeLayerTree, editPsd, renderPsd, renderPsdLayer, type PsdEditOperation } from '../psd-service'
import { getPsdToolsAvailability } from '../psd-tools-bridge'

export interface PsdToolsContext {
  agentCwd?: string
  allowedRoots?: string[]
}

const PNG_EXTENSIONS: ReadonlySet<string> = new Set(['.png'])

function getAuthorizedRoots(ctx: PsdToolsContext): string[] {
  return [ctx.agentCwd, ...(ctx.allowedRoots ?? [])].filter((root): root is string => Boolean(root))
}

function textResult(text: string): KernelToolResult<{ text: string }> {
  return { content: [{ type: 'text', text }], details: { text } }
}

function imageResult(text: string, png: Buffer, details: Record<string, unknown>): KernelToolResult<unknown> {
  return {
    content: [
      { type: 'text', text },
      { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
    ],
    details: { ...details, previewBytes: png.length },
  }
}

/** 访问 / 规格类错误转成模型可纠正的提示；其他异常原样抛出 */
function toFriendlyError(error: unknown): string {
  if (error instanceof PsdAccessError || error instanceof PsdSpecError) return `失败：${error.message}`
  if (error instanceof Error && /Input buffer contains unsupported image format|unsupported image format/i.test(error.message)) {
    return `失败：素材不是可解码的图片（${error.message}）`
  }
  throw error
}

function formatWarnings(warnings: string[]): string {
  return warnings.length ? `\n提醒：\n- ${warnings.join('\n- ')}` : ''
}

/**
 * 没探测到 psd-tools 时给模型的一句话：默认内置引擎就够，只有任务确实要高保真才按 Skill Step 0 征得同意后安装；
 * 装完直接再调工具即可（探测到不可用的结果一分钟内会重探）。装了但缺可选依赖时也点一句。
 */
async function engineHint(): Promise<string> {
  const availability = await getPsdToolsAvailability()
  if (!availability.available) {
    return '\n（本机没探测到 Python + psd-tools，预览由内置引擎合成，图层效果与调整层为近似渲染。内置引擎默认够用；只有用户任务确实需要高保真时，才按 canopy-psd Skill 的 Step 0 征得用户同意后安装 `python -m pip install "psd-tools[composite]"`，装完直接再调本工具即可自动生效。不要擅自安装。）'
  }
  if (availability.missingOptionalDeps?.length) {
    return `\n（psd-tools ${availability.version ?? ''} 已启用，但缺可选依赖 ${availability.missingOptionalDeps.join(' / ')}：矢量描边 / 调整层 / 渐变这些场景会回退内置引擎；补齐命令 \`python -m pip install "psd-tools[composite]"\`，同样先征得用户同意。）`
  }
  return ''
}

const SPEC_HINT = 'Spec shape: { width, height, dpi?, background? (hex or null for transparent), guides?, layers: [bottom → top] }. Layer types: image { source, left, top, width?, height?, fit?, smartObject? (embed the file as a Smart Object) }, svg { svg (inline markup) | source, left, top, width?, height? }, fill { color, left?, top?, width?, height?, radius? }, text { text, font?, fontSize?, color?, bold?, italic?, align?, left, top, width? (wrap box), lineHeight?, letterSpacing? }, shape { shape: rect | ellipse | polygon | path, left/top/width/height (+radius) | points [[x,y]…] | d (SVG path data, M L H V C Q Z), fill? (hex or null), stroke? { color, width } } — a real Photoshop vector shape layer, adjustment { adjustment: "brightness/contrast" | "hue/saturation" | "black & white" | "invert" | "posterize" | "threshold" | "exposure" | "vibrance" | "photo filter" | "solid color", plus its parameters (brightness, contrast, hue, saturation, lightness, levels, level, exposure, offset, gamma, vibrance, color, density) } — affects every layer below it (clipToBelow: only the layer below), artboard { left, top, width, height, background?, children (coordinates relative to the artboard) }, group { children, opened? }. Every layer accepts name, hidden, opacity (0-1), blendMode, effects { dropShadow | innerShadow | outerGlow | stroke | gradientOverlay }, mask { source | rect, feather }, clipToBelow. Relative source paths resolve against the spec file directory (or the working directory for inline specs). Full contract: the canopy-psd skill.'

export function buildPsdTools(ctx: PsdToolsContext): KernelToolDefinition[] {
  return [
    {
      name: 'PsdInspect',
      label: '查看 PSD 图层与合成图',
      description: 'Read a Photoshop .psd file: returns the layer tree (id, kind, name, bounds, text content, visibility, opacity, blend mode, masks, effects) as text AND the composited image as a picture you can look at. Use it before PsdEdit so layer ids/names are real, and after PsdCompose/PsdEdit to check the result visually. Works without Photoshop or Python; if the user has Python with psd-tools installed it automatically renders with that higher-fidelity engine. Optionally hide/show layers for the rendering only (the file is not modified), or pass `layer` to get one layer alone (its own pixels on a transparent background, cropped to its bounds — a group/artboard renders its children) instead of the whole composite. .psb (large document) is not supported.',
      promptSnippet: 'PsdInspect: list PSD layers and see the composite image (or one layer alone with `layer`). Always inspect before editing and after producing a PSD.',
      parameters: Type.Object({
        filePath: Type.String({ description: 'Absolute or workspace-relative path to the .psd file.' }),
        layer: Type.Optional(Type.String({ description: 'Layer id (e.g. "2/0") or exact name: return only this layer\'s pixels (transparent background, cropped to its bounds) instead of the whole composite.' })),
        hiddenLayers: Type.Optional(Type.Array(Type.String(), { description: 'Layer ids (e.g. "2/0") or names to hide in this rendering only.' })),
        visibleLayers: Type.Optional(Type.Array(Type.String(), { description: 'Layer ids or names to force visible in this rendering only.' })),
        maxSide: Type.Optional(Type.Number({ description: 'Longest side of the returned picture in pixels (default 1280).' })),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const args = params as { filePath?: string; layer?: string; hiddenLayers?: string[]; visibleLayers?: string[]; maxSide?: number }
        try {
          const file = resolveReadablePsdPath(args.filePath ?? '', getAuthorizedRoots(ctx), ctx.agentCwd)
          const maxSide = Number.isFinite(args.maxSide) && (args.maxSide as number) > 0 ? Math.min(4096, Math.floor(args.maxSide as number)) : MODEL_PREVIEW_MAX_SIDE
          if (typeof args.layer === 'string' && args.layer.trim()) {
            const single = await renderPsdLayer(file, args.layer, { maxSide })
            const b = single.bounds
            const engine = single.engine === 'psd-tools' ? 'psd-tools（高保真）' : '内置 ag-psd'
            const summary = `${file}\n图层 [${single.layerId}] ${single.kind} ${single.name} @(${b.left},${b.top}) ${b.right - b.left}×${b.bottom - b.top} · 引擎：${engine}${formatWarnings(single.warnings)}\n下面这张图只有这一层自己的像素（透明背景，已裁到外接矩形）。`
            return imageResult(summary, single.png, { filePath: file, layerId: single.layerId, name: single.name, kind: single.kind, bounds: b, engine: single.engine })
          }
          // 名字引用先渲染一次拿树，再翻译成 id；只传 id 时直接走
          let hiddenIds = args.hiddenLayers ?? []
          let visibleIds = args.visibleLayers ?? []
          const needsNameLookup = [...hiddenIds, ...visibleIds].some((ref) => !/^\d+(\/\d+)*$/.test(ref))
          let result = await renderPsd(file, needsNameLookup ? { maxSide: 64 } : { hiddenIds, visibleIds, maxSide })
          if (needsNameLookup) {
            const { findLayerIdByName } = await import('../psd-document')
            const translate = (refs: string[]): string[] => refs.map((ref) => (/^\d+(\/\d+)*$/.test(ref) ? ref : (findLayerIdByName(result.layers, ref) ?? ref)))
            hiddenIds = translate(hiddenIds)
            visibleIds = translate(visibleIds)
            result = await renderPsd(file, { hiddenIds, visibleIds, maxSide })
          }
          const engine = result.engine === 'psd-tools' ? 'psd-tools（高保真）' : '内置 ag-psd'
          const summary = `${file}\n${result.width}×${result.height} · ${result.colorMode.toUpperCase()} · 引擎：${engine}\n图层（自上而下，[id] 类型 名称 @(左,上) 宽×高）：\n${describeLayerTree(result.layers)}${formatWarnings(result.warnings)}\n下面这张图就是当前合成结果，先看图再判断版式。${await engineHint()}`
          return imageResult(summary, result.png, { filePath: file, width: result.width, height: result.height, engine: result.engine, layers: result.layers })
        } catch (error) {
          return textResult(toFriendlyError(error))
        }
      },
    },
    {
      name: 'PsdCompose',
      label: '按图层规格生成 PSD',
      description: `Build a new layered Photoshop .psd from a JSON spec (bottom-to-top layers of images / inline SVG / solid fills / editable text / native vector shapes / adjustment layers / artboards / Smart Objects / groups, with masks, blend modes, opacity and Photoshop layer effects). Writes the .psd plus a full-size PNG preview next to it, and returns the composited picture so you can check the layout. Text layers stay editable in Photoshop (their pixels are pre-rendered so the file opens fully drawn); shape layers keep draggable anchor points; adjustment layers keep their sliders. Prefer one SVG or shape per visual element so each becomes its own layer. Requires no Photoshop or Python. ${SPEC_HINT}`,
      promptSnippet: 'PsdCompose: turn a layer spec (images, SVG, shapes, text, adjustments, artboards, groups, effects) into a layered .psd with a preview picture. Use this instead of Python/PIL scripts.',
      parameters: Type.Object({
        outputPath: Type.String({ description: 'Path of the .psd to create, absolute or relative to the working directory. Must end in .psd; existing files are not overwritten unless overwrite=true.' }),
        specPath: Type.Optional(Type.String({ description: 'Path to a .json spec file (recommended for large specs; relative source paths resolve against its directory).' })),
        spec: Type.Optional(Type.Object({}, { additionalProperties: true, description: 'Inline spec object (alternative to specPath).' })),
        previewPath: Type.Optional(Type.String({ description: 'Where to write the full-size PNG preview. Defaults to <output>-preview.png next to the .psd.' })),
        overwrite: Type.Optional(Type.Boolean({ description: 'Allow overwriting an existing .psd / preview file.' })),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const args = params as { outputPath?: string; specPath?: string; spec?: unknown; previewPath?: string; overwrite?: boolean }
        try {
          const roots = getAuthorizedRoots(ctx)
          const outputPsdPath = resolveWritablePath(args.outputPath ?? '', roots, ctx.agentCwd, { extensions: PSD_EXTENSIONS, allowOverwrite: args.overwrite === true })
          let spec: unknown = args.spec
          let specBaseDir = ctx.agentCwd ?? dirname(outputPsdPath)
          if (args.specPath) {
            const specFile = resolveReadableSpecPath(args.specPath, roots, ctx.agentCwd)
            spec = JSON.parse(await readFile(specFile, 'utf8'))
            specBaseDir = dirname(specFile)
          }
          if (!spec || typeof spec !== 'object') return textResult('失败：需要 spec（内联对象）或 specPath（.json 文件）之一')
          const previewPngPath = resolveWritablePath(args.previewPath ?? defaultPreviewPngPath(outputPsdPath), roots, ctx.agentCwd, { extensions: PNG_EXTENSIONS, allowOverwrite: true })
          const result = await composePsd(spec, { roots, specBaseDir, outputPsdPath, previewPngPath })
          const summary = `已生成 ${result.psdPath}（${result.width}×${result.height}，${result.layerCount} 层）\n预览 PNG：${result.previewPngPath}\n图层（自上而下）：\n${describeLayerTree(result.layers)}${formatWarnings(result.warnings)}\n下面这张图是合成结果：检查文字有没有溢出、元素有没有重叠、留白是否均匀；要改就用 PsdEdit 或改规格后 overwrite=true 重新生成。${await engineHint()}`
          return imageResult(summary, result.previewPng, { psdPath: result.psdPath, previewPngPath: result.previewPngPath, width: result.width, height: result.height, layerCount: result.layerCount, layers: result.layers })
        } catch (error) {
          if (error instanceof SyntaxError) return textResult(`失败：规格文件不是合法 JSON（${error.message}）`)
          return textResult(toFriendlyError(error))
        }
      },
    },
    {
      name: 'PsdEdit',
      label: '编辑 PSD 图层',
      description: 'Modify an existing .psd layer by layer and write the result: change text (content/font/size/color/alignment — the layer stays an editable text layer), replace a layer\'s picture, show/hide, set opacity or blend mode, move, rename, remove, set layer effects, or add a new layer from a spec (same layer shape as PsdCompose, including shape / adjustment / artboard / Smart Object). Layers are referenced by id from PsdInspect (e.g. "2/0") or by exact name. Writes to outputPath (defaults to overwriting the source file after a successful render) plus a PNG preview, and returns the composited picture. Photoshop-only features the built-in engine cannot represent (smart filters, 3D, curves/levels-type adjustment layers) are kept in the file as-is but not shown in the preview — check the returned tree and picture; when in doubt write to a new outputPath.',
      promptSnippet: 'PsdEdit: change text, swap images, toggle/move/reorder layers in a .psd; inspect first, then apply operations in one call.',
      parameters: Type.Object({
        filePath: Type.String({ description: 'The .psd to edit (absolute or workspace-relative).' }),
        operations: Type.Array(
          Type.Object({
            op: Type.Union([
              Type.Literal('setText'), Type.Literal('replaceImage'), Type.Literal('setVisible'), Type.Literal('setOpacity'),
              Type.Literal('setBlendMode'), Type.Literal('move'), Type.Literal('rename'), Type.Literal('remove'),
              Type.Literal('setEffects'), Type.Literal('addLayer'),
            ]),
            layer: Type.Optional(Type.String({ description: 'Target layer id or exact name (all ops except addLayer).' })),
            text: Type.Optional(Type.String({ description: 'setText: new content (line breaks allowed).' })),
            font: Type.Optional(Type.String()),
            fontSize: Type.Optional(Type.Number()),
            color: Type.Optional(Type.String({ description: 'Hex color like #ff3366.' })),
            bold: Type.Optional(Type.Boolean()),
            italic: Type.Optional(Type.Boolean()),
            align: Type.Optional(Type.Union([Type.Literal('left'), Type.Literal('center'), Type.Literal('right')])),
            width: Type.Optional(Type.Number({ description: 'setText: wrap box width in pixels.' })),
            lineHeight: Type.Optional(Type.Number()),
            letterSpacing: Type.Optional(Type.Number()),
            source: Type.Optional(Type.String({ description: 'replaceImage: picture file (png/jpg/webp/svg…).' })),
            fit: Type.Optional(Type.Union([Type.Literal('contain'), Type.Literal('cover'), Type.Literal('fill'), Type.Literal('natural')], { description: 'replaceImage: how to fit the old layer box; natural keeps the picture size.' })),
            hidden: Type.Optional(Type.Boolean({ description: 'setVisible.' })),
            opacity: Type.Optional(Type.Number({ description: 'setOpacity: 0-1.' })),
            blendMode: Type.Optional(Type.String({ description: 'setBlendMode: normal, multiply, screen, overlay, darken, lighten, color dodge, color burn, hard light, soft light, difference, exclusion, linear dodge, hue, saturation, color, luminosity.' })),
            left: Type.Optional(Type.Number({ description: 'move: new left edge.' })),
            top: Type.Optional(Type.Number({ description: 'move: new top edge.' })),
            name: Type.Optional(Type.String({ description: 'rename.' })),
            effects: Type.Optional(Type.Union([Type.Object({}, { additionalProperties: true }), Type.Null()], { description: 'setEffects: effects object as in PsdCompose, or null to clear.' })),
            spec: Type.Optional(Type.Object({}, { additionalProperties: true, description: 'addLayer: one layer spec (image / svg / fill / text / shape / adjustment / artboard / group, same as PsdCompose).' })),
            above: Type.Optional(Type.String({ description: 'addLayer: insert directly above this layer (id or name); default on top.' })),
          }),
          { description: 'Operations applied in order.' },
        ),
        outputPath: Type.Optional(Type.String({ description: 'Where to write the edited .psd. Defaults to the source file (overwritten only after the whole edit succeeds).' })),
        previewPath: Type.Optional(Type.String({ description: 'Full-size PNG preview path. Defaults to <output>-preview.png.' })),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const args = params as { filePath?: string; operations?: unknown[]; outputPath?: string; previewPath?: string }
        try {
          const roots = getAuthorizedRoots(ctx)
          const source = resolveReadablePsdPath(args.filePath ?? '', roots, ctx.agentCwd)
          const operations = Array.isArray(args.operations) ? (args.operations as PsdEditOperation[]) : []
          if (operations.length === 0) return textResult('失败：operations 不能为空')
          const outputPsdPath = args.outputPath
            ? resolveWritablePath(args.outputPath, roots, ctx.agentCwd, { extensions: PSD_EXTENSIONS, allowOverwrite: true })
            : source
          const previewPngPath = resolveWritablePath(args.previewPath ?? defaultPreviewPngPath(outputPsdPath), roots, ctx.agentCwd, { extensions: PNG_EXTENSIONS, allowOverwrite: true })
          const result = await editPsd(source, operations, { roots, baseDir: ctx.agentCwd ?? dirname(source), outputPsdPath, previewPngPath })
          const summary = `已写入 ${result.outputPath}\n应用的操作：\n- ${result.applied.join('\n- ')}\n预览 PNG：${result.previewPngPath}\n图层（自上而下）：\n${describeLayerTree(result.layers)}${formatWarnings(result.warnings)}\n下面这张图是编辑后的合成结果。`
          return imageResult(summary, result.previewPng, { outputPath: result.outputPath, previewPngPath: result.previewPngPath, applied: result.applied, layers: result.layers })
        } catch (error) {
          return textResult(toFriendlyError(error))
        }
      },
    },
  ]
}
