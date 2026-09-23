/**
 * Office 文档编辑工具组（docx / xlsx / pptx）。
 *
 * 由随包分发的 OfficeCLI 提供能力，**不需要用户装 Python、openpyxl/pandas、
 * python-docx/pptx 或 LibreOffice**——这正是内置 docx/xlsx/pptx 三个 Skill 的痛点：
 * 它们靠 Bash 调 Python 库改文档、靠 LibreOffice 重算公式，而这些依赖我方一概不随包
 * 提供，用户机器上常常缺（实测本机 openpyxl / pandas / LibreOffice 全缺）。
 *
 * ⚠️ **分流不要靠 `promptSnippet`**。Canopy 给 Pi 传的是 `systemPromptOverride`，
 * 上游 `buildSystemPrompt` 走 customPrompt 分支就直接 return，把由各工具
 * promptSnippet 拼成的 "Available tools" 整段跳过了；进系统提示词的只有
 * `<available_skills>`。所以这里的 promptSnippet 模型看不到，能到模型手上的
 * 只有工具 schema 里的 `description`。真正的分流写在三个 Skill 的
 * 「Step 0：先选执行路径」里（docx/xlsx/pptx 的 SKILL.md，v1.1.0 起）。
 *
 * 实测能力面（`officecli help <format>`）比 Skill 文档假设的宽得多：
 * docx 有 revision（修订痕迹）/ comment / toc / markdown（把 MD 展开成 Word 原生元素），
 * xlsx 有 pivottable / conditionalformatting / sparkline 且公式写入即算，
 * pptx 有 chart / picture / table / slidelayout / theme / animation / notes。
 * `view … screenshot` 还能把文档渲染成 PNG——已由 `OfficeInspect` 的
 * mode=screenshot 接出，视觉 QA 不再需要 LibreOffice + Poppler。
 *
 * 边界：路径一律经 `resolveEditableOfficePath` 落在授权根内，截图输出另走
 * `resolveScreenshotOutputPath`（锁死 .png）；不使用 OfficeCLI 的 `mcp` 模式
 * （上游 issue #303：该模式绕过自更新抑制开关）。
 */

import { extname } from 'node:path'
import { Type } from 'typebox'
import type { KernelToolDefinition } from '@canopy/kernel'
import {
  OfficeCliUnavailableError,
  OfficeDocumentAccessError,
  defaultScreenshotOutputPath,
  describeEnvelope,
  resolveCreatableOfficePath,
  resolveEditableOfficePath,
  resolveReadableLegacyOfficePath,
  resolveScreenshotOutputPath,
  runOfficeCliJson,
  runOfficeCliScreenshot,
} from '../officecli-service'
import { LEGACY_INSPECT_MODES, legacyOfficeKindOf, modernOfficeExtensionFor } from '../legacy-office-formats'
import { runLegacyOfficeTaskOffThread } from '../legacy-office-parser'
import { buildSvgDeck, resolveReadableSvgPath, type SvgDeckMode } from '../svg-deck-builder'

export interface OfficeToolsContext {
  agentCwd?: string
  allowedRoots?: string[]
}

function getAuthorizedRoots(ctx: OfficeToolsContext): string[] {
  return [ctx.agentCwd, ...(ctx.allowedRoots ?? [])].filter((root): root is string => Boolean(root))
}

function textResult(text: string): { content: [{ type: 'text'; text: string }]; details: { text: string } } {
  return { content: [{ type: 'text', text }], details: { text } }
}

/** 把访问类错误转成给模型看的可纠正提示，而不是抛出去变成一句泛泛的工具失败。 */
function toFriendlyError(error: unknown): string {
  if (error instanceof OfficeDocumentAccessError || error instanceof OfficeCliUnavailableError) {
    return `失败：${error.message}`
  }
  throw error
}

const PROP_HINT = '属性名与取值同 OfficeCLI 的 --prop，例如 value=你好、formula=SUM(A1:A10)、bold=true、numberformat=#,##0.00'

export function buildOfficeTools(ctx: OfficeToolsContext): KernelToolDefinition[] {
  return [
    {
      name: 'OfficeInspect',
      label: '查看 Office 文档结构',
      description: 'Inspect a .docx/.xlsx/.pptx document: read its outline, a node at a given path, elements matching a selector, or render pages to a PNG you can then look at with the image-reading tool. Use this before editing so paths are real rather than guessed, and after editing to see what the result actually looks like. Also reads legacy Office 97-2003 files (.doc/.xls/.ppt) read-only with mode=text/outline/stats — use this instead of the plain file-reading tool, which cannot decode these binary formats; they cannot be edited, queried or screenshotted. Even if the user asks to change a legacy file directly, do NOT rewrite or convert it yourself with Python libraries, pip-installed packages or LibreOffice (that loses formatting and alters the user\'s environment) — tell the user to re-save it as .docx/.xlsx/.pptx in Office/WPS first, then edit that copy with the Office tools. Requires no Python, Office, or LibreOffice.',
      promptSnippet: 'OfficeInspect: read structure/values from Office documents (paths like /Sheet1/A1), or render them to PNG with mode=screenshot. Always inspect before OfficeEdit so you edit real paths.',
      parameters: Type.Object({
        filePath: Type.String({ description: 'Absolute or workspace-relative path to the .docx/.xlsx/.pptx file, or to a legacy .doc/.xls/.ppt file (read-only: text/outline/stats).' }),
        mode: Type.Union([
          Type.Literal('outline'),
          Type.Literal('text'),
          Type.Literal('stats'),
          Type.Literal('issues'),
          Type.Literal('get'),
          Type.Literal('query'),
          Type.Literal('screenshot'),
        ], { description: 'outline/text/stats read the whole document; issues reports detected problems (for .pptx this includes low-contrast text); get reads one node at `path`; query matches `selector`; screenshot renders pages to a PNG file — read that file with the image tool to actually see the layout.' }),
        path: Type.Optional(Type.String({ description: 'Node path for mode=get, e.g. /Sheet1/A1, /Sheet1/row[3] or /slide[1]/shape[2]. Keep it as narrow as possible — reading a whole sheet can return hundreds of KB.' })),
        selector: Type.Optional(Type.String({ description: 'CSS-like selector for mode=query, e.g. cell[formula], row[Salary>5000], cell:contains(总计).' })),
        maxLines: Type.Optional(Type.Number({ description: 'Line cap for mode=text. Defaults to 200; raise it only when you truly need more.' })),
        page: Type.Optional(Type.String({ description: 'Pages to render for mode=screenshot, e.g. "1", "1-5" or "1,3,5". Defaults to page 1.' })),
        grid: Type.Optional(Type.Number({ description: 'For mode=screenshot: render the whole document as one contact sheet with this many columns, instead of separate pages. Good for a quick overview of a long deck.' })),
        outPath: Type.Optional(Type.String({ description: 'For mode=screenshot: where to write the .png. Must be inside an authorized directory. Defaults to <document>-preview.png next to the document.' })),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const args = params as {
          filePath?: string
          mode?: string
          path?: string
          selector?: string
          maxLines?: number
          page?: string
          grid?: number
          outPath?: string
        }
        try {
          const mode = args.mode ?? 'outline'
          const legacyKind = legacyOfficeKindOf(args.filePath ?? '')
          if (legacyKind) {
            // 旧版 97-2003 格式 OfficeCLI 不认：内置解析器只读，放后台线程跑，不卡主进程
            if (!LEGACY_INSPECT_MODES.has(mode)) {
              return textResult(`失败：旧版 ${extname(args.filePath ?? '').toLowerCase()} 只支持 mode=text / outline / stats（只读）。按路径取节点、选择器筛选、问题检查与截图都需要新格式，请用户先另存为 ${modernOfficeExtensionFor(legacyKind)} 后再用这些模式`)
            }
            const legacyFile = resolveReadableLegacyOfficePath(args.filePath ?? '', getAuthorizedRoots(ctx), ctx.agentCwd)
            const maxLines = Number.isFinite(args.maxLines) && (args.maxLines as number) > 0 ? Math.floor(args.maxLines as number) : 200
            try {
              const result = await runLegacyOfficeTaskOffThread({ type: 'inspect', filePath: legacyFile, mode: mode as 'outline' | 'text' | 'stats', maxLines })
              return textResult(describeEnvelope({ success: true, message: result.message, data: result.data }))
            } catch (error) {
              return textResult(`失败：${error instanceof Error ? error.message : String(error)}`)
            }
          }
          const file = resolveEditableOfficePath(args.filePath ?? '', getAuthorizedRoots(ctx), ctx.agentCwd)
          if (mode === 'screenshot') {
            const requestedOut = (args.outPath ?? '').trim()
            // 默认输出落在文档旁边：文档已过授权根判定，同目录必然也在根内。
            const outPath = requestedOut
              ? resolveScreenshotOutputPath(requestedOut, getAuthorizedRoots(ctx), ctx.agentCwd)
              : defaultScreenshotOutputPath(file)
            const cliArgs = ['view', file, 'screenshot', '-o', outPath]
            const grid = Number.isFinite(args.grid) && (args.grid as number) > 0
              ? Math.floor(args.grid as number)
              : undefined
            // grid 是整份文档的联系表，与 page 互斥；同时给会让 CLI 忽略其一，这里显式二选一。
            if (grid !== undefined) cliArgs.push('--grid', String(grid))
            else if ((args.page ?? '').trim()) cliArgs.push('--page', (args.page as string).trim())
            // 截图不走 JSON 信封（stdout 只有路径、页数在 stderr），单独判定，见 runOfficeCliScreenshot 注释。
            const envelope = await runOfficeCliScreenshot(cliArgs, outPath)
            if (!envelope.success) return textResult(describeEnvelope(envelope))
            return textResult(
              `${envelope.message ?? '已渲染'}，文件：${outPath}\n用读取图片的工具打开这个文件再判断版式——结构正确不代表看起来没问题（重叠、溢出、留白不均只有看图才发现）。看不了图的模型改用 VisionRelay 把这张图交给视觉助手描述。`,
            )
          }
          if (mode === 'get') {
            // 不默认取 `/`：整份文档的 JSON 实测能到 800KB，会直接撑爆模型上下文。
            const path = (args.path ?? '').trim()
            if (!path) {
              return textResult('失败：mode=get 需要提供 path（例如 /Sheet1/A1 或 /slide[1]）。先用 mode=outline 看清结构再取具体节点——整份文档一次读回来会撑爆上下文。')
            }
            return textResult(describeEnvelope(await runOfficeCliJson(['get', file, path])))
          }
          if (mode === 'query') {
            const selector = (args.selector ?? '').trim()
            if (!selector) return textResult('失败：mode=query 需要提供 selector')
            return textResult(describeEnvelope(await runOfficeCliJson(['query', file, selector])))
          }
          if (mode === 'text') {
            const maxLines = Number.isFinite(args.maxLines) && (args.maxLines as number) > 0
              ? Math.floor(args.maxLines as number)
              : 200
            return textResult(describeEnvelope(await runOfficeCliJson(['view', file, 'text', '--max-lines', String(maxLines)])))
          }
          return textResult(describeEnvelope(await runOfficeCliJson(['view', file, mode])))
        } catch (error) {
          return textResult(toFriendlyError(error))
        }
      },
    },
    {
      name: 'OfficeEdit',
      label: '编辑 Office 文档',
      description: `Edit a .docx/.xlsx/.pptx document in place: set properties on a node, add/remove/move elements. Formulas written into .xlsx are evaluated by the bundled engine, so no LibreOffice recalculation step is needed. ${PROP_HINT}. Requires no Python or installed Office. Legacy .doc/.xls/.ppt files cannot be edited: read them with OfficeInspect, never modify them via Python/pip/LibreOffice, and ask the user to re-save as .docx/.xlsx/.pptx before any change.`,
      promptSnippet: 'OfficeEdit: modify Office documents in place (cells, formulas, text, rows/columns). Prefer it over Python/openpyxl scripts — it needs no user-installed dependencies. Use OfficeBatch for several edits at once so they apply atomically.',
      parameters: Type.Object({
        filePath: Type.String({ description: 'Absolute or workspace-relative path to the .docx/.xlsx/.pptx file.' }),
        operation: Type.Union([
          Type.Literal('set'),
          Type.Literal('add'),
          Type.Literal('remove'),
          Type.Literal('move'),
        ], { description: 'set changes properties of an existing node; add creates a child under `path`; remove deletes the node; move relocates it.' }),
        path: Type.String({ description: 'Target node path. For operation=add this is the PARENT under which the new element is created, e.g. /Sheet1; otherwise the node itself, e.g. /Sheet1/B3 or /slide[1]/shape[1].' }),
        props: Type.Optional(Type.Record(Type.String(), Type.String(), {
          description: `Property map for set/add. ${PROP_HINT}`,
        })),
        type: Type.Optional(Type.String({ description: 'Element type for operation=add, e.g. row, column, cell, shape, chart.' })),
        to: Type.Optional(Type.String({ description: 'Destination path for operation=move.' })),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const args = params as {
          filePath?: string
          operation?: string
          path?: string
          props?: Record<string, string>
          type?: string
          to?: string
        }
        try {
          const file = resolveEditableOfficePath(args.filePath ?? '', getAuthorizedRoots(ctx), ctx.agentCwd)
          const path = (args.path ?? '').trim()
          if (!path) return textResult('失败：需要提供 path')
          const operation = args.operation ?? 'set'
          const cli: string[] = [operation, file, path]

          if (operation === 'set' || operation === 'add') {
            const entries = Object.entries(args.props ?? {})
            if (operation === 'add' && args.type) cli.push('--type', args.type)
            // 只有 set 必须带属性；add 允许不带（插一个空行/空列/空幻灯片是常见需求，
            // OfficeCLI 本身也接受）。
            if (operation === 'set' && entries.length === 0) {
              return textResult('失败：operation=set 需要提供 props（例如 {"value":"年假"} 或 {"formula":"SUM(A1:A10)"}）')
            }
            // OfficeCLI 要求每条属性一个 --prop key=value；裸写 key=value 会被忽略并告警。
            for (const [key, value] of entries) cli.push('--prop', `${key}=${value}`)
          } else if (operation === 'move') {
            if (!args.to) return textResult('失败：operation=move 需要提供 to')
            cli.push('--to', args.to)
          }
          return textResult(describeEnvelope(await runOfficeCliJson(cli)))
        } catch (error) {
          return textResult(toFriendlyError(error))
        }
      },
    },
    {
      name: 'OfficeBatch',
      label: '批量编辑 Office 文档',
      description: 'Apply several edits to one Office document in a single atomic pass — if any item fails, the whole batch rolls back and the file is left untouched. Prefer this over repeated OfficeEdit calls: it is both faster and safer.',
      promptSnippet: 'OfficeBatch: apply multiple Office document edits atomically (all-or-nothing). Use it whenever more than one change is needed.',
      parameters: Type.Object({
        filePath: Type.String({ description: 'Absolute or workspace-relative path to the .docx/.xlsx/.pptx file.' }),
        commands: Type.Array(
          Type.Object({
            command: Type.String({ description: 'Bare verb: set / add / remove / move / swap.' }),
            path: Type.Optional(Type.String({ description: 'Target node path for set/remove/move.' })),
            parent: Type.Optional(Type.String({ description: 'Parent path for add.' })),
            type: Type.Optional(Type.String({ description: 'Element type for add.' })),
            props: Type.Optional(Type.Record(Type.String(), Type.String(), { description: PROP_HINT })),
            to: Type.Optional(Type.String({ description: 'Destination for move.' })),
            path2: Type.Optional(Type.String({ description: 'Second path for swap.' })),
          }),
          { description: 'Edits applied in order, atomically.' },
        ),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const args = params as { filePath?: string; commands?: unknown[] }
        try {
          const file = resolveEditableOfficePath(args.filePath ?? '', getAuthorizedRoots(ctx), ctx.agentCwd)
          const commands = Array.isArray(args.commands) ? args.commands : []
          if (commands.length === 0) return textResult('失败：commands 不能为空')
          // JSON 走 stdin，不拼进命令行：Windows 的 CreateProcess 上限约 32767 字符，
          // 实测 150 行 × 5 列的批量载荷就有 5 万字符，拼 argv 会直接 spawn ENAMETOOLONG。
          // OfficeCLI 的 batch 省略 --commands/--input 时正是从 stdin 读。
          return textResult(describeEnvelope(
            await runOfficeCliJson(['batch', file], { stdin: JSON.stringify(commands) }),
          ))
        } catch (error) {
          return textResult(toFriendlyError(error))
        }
      },
    },
    {
      name: 'OfficeCreate',
      label: '新建 Office 文档',
      description: 'Create a new empty .docx/.xlsx/.pptx file, then fill it with OfficeEdit/OfficeBatch. Refuses to overwrite an existing file. Requires no Python or installed Office.',
      promptSnippet: 'OfficeCreate: create a new empty Office document, then fill it with OfficeBatch. Use this instead of writing Python to generate .xlsx/.docx/.pptx.',
      parameters: Type.Object({
        filePath: Type.String({ description: 'Path of the file to create, absolute or relative to the working directory. Must end in .docx/.xlsx/.pptx and must not already exist.' }),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const args = params as { filePath?: string }
        try {
          // 新建走的判定与编辑不同：目标**不能**已存在，所以校验的是父目录在授权根内。
          const target = resolveCreatableOfficePath(args.filePath ?? '', getAuthorizedRoots(ctx), ctx.agentCwd)
          return textResult(describeEnvelope(await runOfficeCliJson(['create', target])))
        } catch (error) {
          return textResult(toFriendlyError(error))
        }
      },
    },
    {
      name: 'OfficeSlidesFromSvg',
      label: '用 SVG 页生成 PPTX',
      description: 'Build a new .pptx from 1280×720 SVG slide files that follow the canopy-ppt contract. mode=native (default) compiles rect/roundRect/ellipse/horizontal-vertical lines/text/linear gradients/data-URI images into editable PowerPoint shapes and text boxes; elements it cannot express (path, polyline, polygon, diagonal lines, filter, clip-path, slice-cropped images, rotations/scales, radial gradients) are cut out as small vector pictures placed exactly where they were, so the rest of the page stays editable; the result lists them per page. Only pages with use/foreignObject/style/script fall back to one full-page picture. mode=picture pastes every page as one picture. Embedded images are written to a media/ folder next to the .pptx. Refuses to overwrite an existing file. Requires no Python or installed Office.',
      promptSnippet: 'OfficeSlidesFromSvg: turn canopy-ppt SVG pages into a .pptx in one call; native mode makes text editable, elements it cannot express (path, diagonal lines, clipped images, rotations) become small vector pictures in place and are listed per page.',
      parameters: Type.Object({
        filePath: Type.String({ description: 'Path of the .pptx to create, absolute or relative to the working directory. Must not already exist.' }),
        svgPaths: Type.Array(Type.String(), { description: 'SVG files in slide order, absolute or workspace-relative. Each must be inside an authorized directory and end in .svg.' }),
        mode: Type.Optional(Type.Union([Type.Literal('native'), Type.Literal('picture')], { description: 'native (default): editable shapes/text with per-page picture fallback; picture: every page as one full-page image.' })),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const args = params as { filePath?: string; svgPaths?: unknown; mode?: string }
        try {
          const target = resolveCreatableOfficePath(args.filePath ?? '', getAuthorizedRoots(ctx), ctx.agentCwd)
          if (!target.toLowerCase().endsWith('.pptx')) return textResult('失败：只能生成 .pptx')
          const rawPaths = Array.isArray(args.svgPaths) ? args.svgPaths.filter((p): p is string => typeof p === 'string' && p.trim() !== '') : []
          if (rawPaths.length === 0) return textResult('失败：svgPaths 不能为空，按页序给出 SVG 文件路径')
          const svgPaths = rawPaths.map((p) => resolveReadableSvgPath(p, getAuthorizedRoots(ctx), ctx.agentCwd))
          const mode: SvgDeckMode = args.mode === 'picture' ? 'picture' : 'native'
          const result = await buildSvgDeck(target, svgPaths, mode)
          return textResult(result.success ? result.message : `失败：${result.message}`)
        } catch (error) {
          return textResult(toFriendlyError(error))
        }
      },
    },
  ]
}
