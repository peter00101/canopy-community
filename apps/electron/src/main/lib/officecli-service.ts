/**
 * OfficeCLI 文档编辑服务 — Agent 工具的业务层。
 *
 * 与预览链路（`file-preview-service.ts`）共用同一个内嵌二进制与 `runBundledOfficeCli`
 * 封装，但**路径解析完全独立**：
 *
 * ⚠️ 预览走的 `resolveTargetPath()` 会「任何存在的绝对路径直接放行、找不到还按文件名
 * 跨目录搜」——那是登记的既有缺口，读的时候勉强能忍，写就绝对不行：
 * 复用它等于把「能读任意文件」升级成「能写任意文件」。这里一律走 `file-access-policy`
 * 的授权根判定，输入与输出都要落在 Agent 已授权目录内。
 *
 * 能力来自 OfficeCLI 的 Open XML SDK 实现，**不依赖本机安装 Office / LibreOffice /
 * Python**，公式由它自带的引擎写入即算（本机实测 CONCATENATE / SUM 均返回计算值）。
 */

import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { isPathWithinRoots, realpathOrResolve, resolveExistingRealPath } from './file-access-policy'
import { getBundledOfficeCliPath, isBundledOfficeCliTrusted, runBundledOfficeCli } from './officecli-manager'
import { legacyOfficeKindOf, modernOfficeExtensionFor } from './legacy-office-formats'

/** OfficeCLI 支持结构化编辑的三种格式；旧二进制格式（.doc/.xls/.ppt）它不认。 */
export const OFFICE_EDITABLE_EXTENSIONS: ReadonlySet<string> = new Set(['.docx', '.xlsx', '.pptx'])

const OFFICECLI_EDIT_TIMEOUT_MS = 30_000
const OFFICECLI_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
/** 单个文档的处理上限：超大文件让 OfficeCLI 整体载入内存不划算，也容易撞 maxBuffer。 */
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024

export class OfficeCliUnavailableError extends Error {}
export class OfficeDocumentAccessError extends Error {}

export interface OfficeCliJsonEnvelope {
  success: boolean
  message?: string
  data?: unknown
  error?: { code?: string; error?: string; message?: string }
  warnings?: unknown[]
  results?: unknown[]
}

/**
 * 把 Agent 给的路径解析成一个「确实存在、且在授权根内」的绝对路径。
 *
 * 三层：① 必须是可编辑扩展名；② realpath 之后必须落在授权根内（symlink 指出去的
 * 一律拒绝）；③ 必须是常规文件且不超上限。
 */
export function resolveEditableOfficePath(
  filePath: string,
  authorizedRoots: readonly string[],
  baseDir?: string,
): string {
  if (!filePath || typeof filePath !== 'string') {
    throw new OfficeDocumentAccessError('未提供文件路径')
  }
  const extension = extname(filePath).toLowerCase()
  if (!OFFICE_EDITABLE_EXTENSIONS.has(extension)) {
    const legacyKind = legacyOfficeKindOf(filePath)
    throw new OfficeDocumentAccessError(legacyKind
      ? `旧版 ${extension} 不能编辑，也不能截图或按路径 / 选择器读取：可以用 OfficeInspect 的 mode=text / outline / stats 只读查看；不要改用 Python / pip / LibreOffice 自行改写，要修改需请用户先在 Office / WPS 里另存为新格式（${modernOfficeExtensionFor(legacyKind)}）`
      : `仅支持 .docx / .xlsx / .pptx，收到 ${extension || '（无扩展名）'}。旧版 .doc/.xls/.ppt 需先另存为新格式`)
  }
  return resolveAuthorizedExistingDocument(filePath, authorizedRoots, baseDir)
}

/**
 * 旧版 .doc / .xls / .ppt 的只读路径判定：授权规则与 `resolveEditableOfficePath` 完全相同，只是扩展名放行的是旧格式。
 * 只给 OfficeInspect 的只读模式用，编辑类工具仍走 `resolveEditableOfficePath` 并被拒。
 */
export function resolveReadableLegacyOfficePath(
  filePath: string,
  authorizedRoots: readonly string[],
  baseDir?: string,
): string {
  if (!filePath || typeof filePath !== 'string') {
    throw new OfficeDocumentAccessError('未提供文件路径')
  }
  if (!legacyOfficeKindOf(filePath)) {
    throw new OfficeDocumentAccessError(`不是旧版 Office 格式（.doc / .xls / .ppt）：${filePath}`)
  }
  return resolveAuthorizedExistingDocument(filePath, authorizedRoots, baseDir)
}

/** 存在性、realpath 落在授权根内、常规文件、体积上限——编辑与只读共用 */
function resolveAuthorizedExistingDocument(
  filePath: string,
  authorizedRoots: readonly string[],
  baseDir?: string,
): string {
  if (authorizedRoots.length === 0) {
    throw new OfficeDocumentAccessError('当前会话没有已授权的目录，无法访问文档')
  }

  // 工具描述允许「工作区相对路径」，就必须真的按 Agent 的工作目录解析——
  // 否则 resolve() 相对的是 Electron 主进程的 cwd，模型传「排班.xlsx」永远报不存在。
  const absolute = isAbsolute(filePath) ? filePath : resolve(baseDir || process.cwd(), filePath)
  const resolved = resolveExistingRealPath(absolute)
  if (!resolved) {
    throw new OfficeDocumentAccessError(`文件不存在：${filePath}${baseDir && !isAbsolute(filePath) ? `（按工作目录 ${baseDir} 解析）` : ''}`)
  }
  // getRoots 是惰性的；这里根集合已在手，直接返回归一化后的结果。
  if (!isPathWithinRoots(resolved, () => authorizedRoots.map((root) => realpathOrResolve(root)))) {
    throw new OfficeDocumentAccessError(
      `文件不在本次会话已授权的目录内：${filePath}。把它放进项目目录，或让用户在「文件」面板附加所在目录`,
    )
  }
  const stats = statSync(resolved)
  if (!stats.isFile()) {
    throw new OfficeDocumentAccessError(`不是常规文件：${filePath}`)
  }
  if (stats.size > MAX_DOCUMENT_BYTES) {
    throw new OfficeDocumentAccessError(`文档超过 ${Math.floor(MAX_DOCUMENT_BYTES / 1024 / 1024)}MB 处理上限`)
  }
  return resolved
}

/**
 * 新建文档的路径判定：目标**不能**已存在，所以校验的是它的**父目录**在授权根内。
 *
 * 不能复用 `resolveEditableOfficePath`——那个要求文件先存在。这里父目录必须真实存在
 * 并 realpath 后落在授权根内（防 symlink 把新文件写到根外），目标本身必须不存在。
 */
export function resolveCreatableOfficePath(
  filePath: string,
  authorizedRoots: readonly string[],
  baseDir?: string,
): string {
  if (!filePath || typeof filePath !== 'string') {
    throw new OfficeDocumentAccessError('未提供文件路径')
  }
  const extension = extname(filePath).toLowerCase()
  if (!OFFICE_EDITABLE_EXTENSIONS.has(extension)) {
    throw new OfficeDocumentAccessError(`仅支持新建 .docx / .xlsx / .pptx，收到 ${extension || '（无扩展名）'}`)
  }
  if (authorizedRoots.length === 0) {
    throw new OfficeDocumentAccessError('当前会话没有已授权的目录，无法新建文档')
  }

  const absolute = isAbsolute(filePath) ? filePath : resolve(baseDir || process.cwd(), filePath)
  if (existsSync(absolute)) {
    throw new OfficeDocumentAccessError(`文件已存在：${filePath}。新建不会覆盖已有文件；要改它请用 OfficeEdit`)
  }
  const parent = dirname(absolute)
  const resolvedParent = resolveExistingRealPath(parent)
  if (!resolvedParent) {
    throw new OfficeDocumentAccessError(`目录不存在：${parent}`)
  }
  if (!isPathWithinRoots(resolvedParent, () => authorizedRoots.map((root) => realpathOrResolve(root)))) {
    throw new OfficeDocumentAccessError(`目录不在本次会话已授权的范围内：${parent}`)
  }
  return join(resolvedParent, basename(absolute))
}

/** 截图产物只允许 PNG：把渲染这条链路的可写面锁死，免得它变成任意写文件的口子。 */
const SCREENSHOT_OUTPUT_EXTENSION = '.png'

/**
 * 幻灯片/页面渲染图的输出路径判定。
 *
 * 与 `resolveCreatableOfficePath` 同样只认「父目录 realpath 落在授权根内」，但有一处
 * 故意放宽：**允许覆盖已存在的同名 PNG**。视觉 QA 本身是「渲染 → 改 → 再渲染」的循环，
 * 每轮都换个新文件名只会在用户目录里堆一地图片。扩展名锁死 .png，覆盖面就限定在
 * 本链路自己产出的图上，不会波及文档或源码。
 */
export function resolveScreenshotOutputPath(
  filePath: string,
  authorizedRoots: readonly string[],
  baseDir?: string,
): string {
  if (!filePath || typeof filePath !== 'string') {
    throw new OfficeDocumentAccessError('未提供截图输出路径')
  }
  if (extname(filePath).toLowerCase() !== SCREENSHOT_OUTPUT_EXTENSION) {
    throw new OfficeDocumentAccessError(`截图只能输出 .png，收到 ${extname(filePath) || '（无扩展名）'}`)
  }
  if (authorizedRoots.length === 0) {
    throw new OfficeDocumentAccessError('当前会话没有已授权的目录，无法写出截图')
  }

  const absolute = isAbsolute(filePath) ? filePath : resolve(baseDir || process.cwd(), filePath)
  const parent = dirname(absolute)
  const resolvedParent = resolveExistingRealPath(parent)
  if (!resolvedParent) {
    throw new OfficeDocumentAccessError(`目录不存在：${parent}`)
  }
  if (!isPathWithinRoots(resolvedParent, () => authorizedRoots.map((root) => realpathOrResolve(root)))) {
    throw new OfficeDocumentAccessError(`目录不在本次会话已授权的范围内：${parent}`)
  }
  return join(resolvedParent, basename(absolute))
}

/** 未指定输出路径时，截图默认落在文档旁边，名字从文档名派生。 */
export function defaultScreenshotOutputPath(documentPath: string): string {
  const extension = extname(documentPath)
  return join(dirname(documentPath), `${basename(documentPath, extension)}-preview${SCREENSHOT_OUTPUT_EXTENSION}`)
}

async function requireTrustedOfficeCli(): Promise<string> {
  const executable = getBundledOfficeCliPath()
  if (!existsSync(executable)) {
    throw new OfficeCliUnavailableError('OfficeCLI 未随本次安装分发，无法编辑 Office 文档')
  }
  if (!await isBundledOfficeCliTrusted(executable)) {
    throw new OfficeCliUnavailableError('OfficeCLI 完整性校验未通过，已停用（避免使用被替换过的二进制）')
  }
  return executable
}

/**
 * 解析 OfficeCLI 的 `--json` 输出。
 *
 * 它在失败时**也会**打印 JSON 信封并以非零码退出，`execFile` 会把这种情况当成异常抛出，
 * 所以两条路径都要取 stdout 再解析——否则失败原因（`error.code`）就丢了，只剩一句
 * "Command failed"，Agent 无从纠错。
 */
function parseEnvelope(stdout: string): OfficeCliJsonEnvelope {
  const trimmed = stdout.trim()
  if (!trimmed) return { success: false, message: 'OfficeCLI 无输出' }
  try {
    return JSON.parse(trimmed) as OfficeCliJsonEnvelope
  } catch {
    return { success: false, message: trimmed.slice(0, 2000) }
  }
}

export async function runOfficeCliJson(
  args: readonly string[],
  options: { stdin?: string } = {},
): Promise<OfficeCliJsonEnvelope> {
  const executable = await requireTrustedOfficeCli()
  try {
    const { stdout, stderr, timedOut } = await runBundledOfficeCli(executable, [...args, '--json'], {
      timeoutMs: OFFICECLI_EDIT_TIMEOUT_MS,
      maxBuffer: OFFICECLI_MAX_OUTPUT_BYTES,
      stdin: options.stdin,
    })
    if (timedOut) {
      return { success: false, message: `执行超时（${OFFICECLI_EDIT_TIMEOUT_MS / 1000}s）——文档可能过大或正被其他程序占用` }
    }
    if (stdout.trim()) return parseEnvelope(stdout)
    if (stderr.trim()) return { success: false, message: stderr.trim().slice(0, 2000) }
    return { success: false, message: 'OfficeCLI 无输出' }
  } catch (error) {
    // spawn 本身失败（可执行文件不存在等）。命令行过长已由 stdin 规避。
    return { success: false, message: (error instanceof Error ? error.message : String(error)).slice(0, 2000) }
  }
}

/** 截图类命令的判定输入：进程结果 + 输出文件是否真的落盘。 */
export interface ScreenshotRunObservation {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  /** 输出 PNG 是否存在且非空（由调用方 stat 得到） */
  outputWritten: boolean
}

/**
 * `view <file> screenshot` 不走 JSON 信封：即使带 `--json`，stdout 也只是输出路径，
 * `[pages] total=N` 走 stderr。0.18.75 首版把它塞进 runOfficeCliJson，parseEnvelope 把那行路径
 * 当成失败信息，于是「文件已写出、工具却报失败」（0.18.85 canopy-ppt 样例实测，模型因此去找
 * Python / Playwright 自渲染）。判定只看三件事：没超时、退出码为 0、PNG 真的落盘且非空。
 */
export function interpretScreenshotRun(observation: ScreenshotRunObservation): OfficeCliJsonEnvelope {
  if (observation.timedOut) {
    return { success: false, message: `截图超时（${OFFICECLI_EDIT_TIMEOUT_MS / 1000}s）——文档可能过大，先试 page 指定单页` }
  }
  const stderr = observation.stderr.trim()
  const stdout = observation.stdout.trim()
  if (observation.code !== 0) {
    const detail = stderr || stdout || `退出码 ${observation.code}`
    return { success: false, message: `OfficeCLI 截图失败：${detail.slice(0, 2000)}` }
  }
  if (!observation.outputWritten) {
    const detail = stderr || stdout
    return { success: false, message: `OfficeCLI 未写出截图文件${detail ? `：${detail.slice(0, 2000)}` : ''}` }
  }
  // 用 String.match 而不用 RegExp 的同名执行方法：officecli-manager.test 的调用点收敛守卫会把后者当子进程调用。
  const pages = stderr.match(/\[pages\]\s*total=(\d+)/)?.[1]
  return { success: true, message: pages ? `已渲染 ${pages} 页` : '已渲染' }
}

/**
 * 运行截图命令（不带 `--json`），按 interpretScreenshotRun 判定。
 * `outPath` 必须是调用方已过授权判定的绝对路径。
 */
export async function runOfficeCliScreenshot(args: readonly string[], outPath: string): Promise<OfficeCliJsonEnvelope> {
  const executable = await requireTrustedOfficeCli()
  try {
    const result = await runBundledOfficeCli(executable, [...args], {
      timeoutMs: OFFICECLI_EDIT_TIMEOUT_MS,
      maxBuffer: OFFICECLI_MAX_OUTPUT_BYTES,
    })
    let outputWritten = false
    try {
      outputWritten = existsSync(outPath) && statSync(outPath).size > 0
    } catch {
      outputWritten = false
    }
    return interpretScreenshotRun({ ...result, outputWritten })
  } catch (error) {
    return { success: false, message: (error instanceof Error ? error.message : String(error)).slice(0, 2000) }
  }
}

/**
 * 单次工具结果给模型的字节上限。
 *
 * 实测：一张 400 行 × 5 列的表（文件才 12KB），`get /` 的 JSON 输出有 866KB。
 * 直接灌进上下文会当场撑爆模型窗口，下一轮就是超限或触发压缩。宁可截断并告诉
 * 模型「缩小范围重试」，也不能把整份文档倒给它。
 */
const MAX_TOOL_TEXT_BYTES = 48 * 1024

function capForModel(text: string): string {
  const bytes = Buffer.byteLength(text)
  if (bytes <= MAX_TOOL_TEXT_BYTES) return text
  // 按字节截断，尾部可能切坏多字节字符，用非 fatal 解码后去掉替换符
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(Buffer.from(text, 'utf-8').subarray(0, MAX_TOOL_TEXT_BYTES))
    .replace(/�+$/, '')
  const hint = `（结果过长已截断，完整约 ${Math.round(bytes / 1024)}KB。请用更具体的 path、selector，或用 maxLines / range 缩小范围后重试）`
  return `${head}\n\n…${hint}`
}

/**
 * 把信封压成给模型看的一段文本。
 *
 * 失败路径必须挖到 `data.results[]`：batch 的失败信封**没有顶层 error / message**，
 * 具体是哪一条、什么 code、什么原因全在 results 数组里（实测确认）。不挖出来，
 * 模型只会收到「未知错误」，完全无法自纠。
 */
export function describeEnvelope(envelope: OfficeCliJsonEnvelope): string {
  if (envelope.success) {
    const payload = envelope.data ?? envelope.results
    const body = payload === undefined
      ? ''
      : (typeof payload === 'string' ? payload : JSON.stringify(payload))
    const head = envelope.message ? `${envelope.message}\n` : ''
    return capForModel(`${head}${body}`.trim() || '完成')
  }

  const failures = extractBatchFailures(envelope)
  if (failures.length > 0) {
    const rolledBack = getBatchSummary(envelope)?.atomicRolledBack ? '（整批已回滚，文件未改动）' : ''
    return capForModel(`失败${rolledBack}：\n${failures.join('\n')}`)
  }
  const code = envelope.error?.code ? `[${envelope.error.code}] ` : ''
  const detail = envelope.error?.error || envelope.error?.message || envelope.message || '未知错误'
  return capForModel(`失败：${code}${detail}`)
}

function getBatchResults(envelope: OfficeCliJsonEnvelope): Record<string, unknown>[] {
  const fromData = (envelope.data as { results?: unknown } | undefined)?.results
  const raw = Array.isArray(fromData) ? fromData : (Array.isArray(envelope.results) ? envelope.results : [])
  return raw.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
}

function getBatchSummary(envelope: OfficeCliJsonEnvelope): { atomicRolledBack?: boolean } | undefined {
  const summary = (envelope.data as { summary?: unknown } | undefined)?.summary
  return typeof summary === 'object' && summary !== null ? summary as { atomicRolledBack?: boolean } : undefined
}

function extractBatchFailures(envelope: OfficeCliJsonEnvelope): string[] {
  return getBatchResults(envelope)
    .filter((item) => item.success === false)
    .map((item) => {
      const index = typeof item.index === 'number' ? `第 ${item.index + 1} 条` : '某条'
      const itemPath = (item.item as { path?: string } | undefined)?.path
      const where = itemPath ? `（${itemPath}）` : ''
      const errCode = typeof item.code === 'string' ? `[${item.code}] ` : ''
      const detail = typeof item.error === 'string' ? item.error : '未知错误'
      return `- ${index}${where}：${errCode}${detail}`
    })
}
