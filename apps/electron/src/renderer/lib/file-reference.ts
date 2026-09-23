/**
 * 文件引用识别与展示的纯逻辑（零依赖，供 FilePathChip / MarkdownInlineCode 使用，可直接单测）。
 *
 * - isAbsoluteFilePath / isRelativeFilePath：判断 Agent 正文里的一段文本像不像文件路径
 * - isLocalFileReference：Markdown 链接目标专用的宽口径判定（上游 #2020）
 * - resolveInlineFileReference：把裸文件名 / 相对路径按「本轮 → 会话」两级映射补全为绝对路径
 * - mergeCandidateBasePaths：把 props 候选与消息级候选合并成 chip 的解析基准目录列表
 * - buildFilePathChipTitle：chip 悬停提示文案——未解析的相对引用不能声称「文件不存在」，
 *   也不能把猜出来的拼接路径当事实展示（上游 issue #1691 的误报正是这么来的）
 */

/** 图片扩展名 */
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])
/** 视频扩展名 */
export const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov'])
/**
 * 代码/结构化文本扩展名
 * 需与主进程 file-preview-service.ts 的 CODE_EXTENSIONS + MARKDOWN_EXTENSIONS 保持一致，
 * 否则消息中的相对路径无法被识别为可点击 chip。
 */
export const CODE_EXTS = new Set([
  'md', 'markdown',
  'json', 'jsonc', 'json5',
  'xml', 'html', 'htm',
  'txt', 'log', 'csv',
  'yaml', 'yml', 'toml', 'ini', 'env', 'lock',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'h', 'cpp', 'hpp', 'cs',
  'sh', 'bash', 'zsh', 'fish',
  'css', 'scss', 'less',
  'sql', 'rb', 'php',
  'diff', 'patch',
])
/** 文档扩展名（psd 走 PsdFilePreview，0.19.13 起可内联预览） */
export const DOC_EXTS = new Set(['pdf', 'docx', 'psd'])

/** 所有可预览的扩展名集合（用于相对路径检测） */
export const ALL_PREVIEWABLE_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS, ...CODE_EXTS, ...DOC_EXTS])

/** 路径分隔符正则（同时匹配 / 和 \） */
export const PATH_SEP_RE = /[\\/]/

/** 末尾路径分隔符正则（用于剥除 base 末尾的斜杠） */
export const TRAILING_SEP_RE = /[\\/]+$/

/** Windows 盘符绝对路径前缀（如 C:\ D:/ e:\） */
export const WIN_DRIVE_RE = /^[A-Za-z]:[\\/]/

/** 从路径提取文件名（同时支持 / 和 \） */
export function getFileName(filePath: string): string {
  const parts = filePath.split(PATH_SEP_RE)
  return parts[parts.length - 1] || filePath
}

/** 从文件名提取扩展名（小写，不含点） */
export function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot === -1) return ''
  return filename.slice(dot + 1).toLowerCase()
}

/**
 * 从路径中剥离末尾的行号/列号后缀（如 :42 或 :42:15）
 * Agent 模式下模型常输出 file_path:line_number 格式
 */
export function stripLineCol(filePath: string): { path: string; suffix: string } {
  const m = filePath.match(/^(.+?)(:\d+(?::\d+)?)$/)
  if (m && !m[1]!.endsWith(':')) {
    return { path: m[1]!, suffix: m[2]! }
  }
  return { path: filePath, suffix: '' }
}

/** 判断路径是否指向可在内置预览中显示的图片。 */
export function isImageFilePath(filePath: string): boolean {
  return IMAGE_EXTS.has(getExtension(filePath.trim()))
}

/**
 * 检测文本是否为绝对文件路径
 *
 * 匹配规则：
 * - macOS/Linux: 以 / 开头，至少两级路径
 * - Windows: 以 C:\ 或 C:/ 等盘符开头（大小写盘符均支持，反斜杠和正斜杠均支持）
 */
export function isAbsoluteFilePath(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 2) return false

  // 剥离末尾行号后缀再检测
  const { path: clean } = stripLineCol(trimmed)

  // macOS/Linux 绝对路径：以 / 开头，至少两级
  if (clean.startsWith('/') && /^\/[^\n]+\/[^\n]+$/.test(clean)) {
    // 排除常见的非路径模式（如 /regex/ 模式）
    if (clean.endsWith('/') && !clean.includes('.')) return false
    return true
  }

  // Windows 绝对路径（支持反斜杠和正斜杠、大小写盘符）
  if (WIN_DRIVE_RE.test(clean)) return true

  return false
}

/**
 * 检测文本是否为相对文件路径（需要 basePath 才有意义）
 *
 * 匹配规则：
 * - 含有可预览的文件扩展名
 * - 看起来像文件名或相对路径（不含空格、不含特殊字符）
 * - 排除常见的非路径 inline code（如命令、变量名等）
 * - 同时支持 / 和 \ 路径分隔符
 */
export function isRelativeFilePath(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 3) return false

  // 剥离末尾行号后缀再检测
  const { path: clean } = stripLineCol(trimmed)

  // 提取扩展名
  const ext = getExtension(clean)
  if (!ext || !ALL_PREVIEWABLE_EXTS.has(ext)) return false

  // 必须看起来像文件路径：允许 字母数字、点、横线、下划线、斜杠（含反斜杠）
  // 排除含空格或特殊字符的（太可能是其他内容）
  if (!/^[\w./@\\-]+$/.test(clean)) return false

  // 排除以点开头的隐藏文件（如 .gitignore），但保留含子路径的相对路径（如 .context/file.md）
  if (clean.startsWith('.') && !PATH_SEP_RE.test(clean)) return false

  return true
}

/** 无扩展名但确实是文件的常见文件名（Markdown 链接里出现时按文件引用处理）。 */
const EXTENSIONLESS_FILE_NAMES = new Set(['makefile', 'dockerfile', 'license', 'readme', 'agents'])

/** 单条文件引用的长度上限，挡住把整段正文当路径塞进来的畸形输入。 */
const MAX_FILE_REFERENCE_LENGTH = 4096

/** ASCII 控制字符（含 DEL）；真实文件名里不会出现，出现即判定不是文件引用。 */
const CONTROL_CHAR_RE = new RegExp('[\\u0000-\\u001F\\u007F]')

/**
 * Markdown 链接目标里的相对文件引用（上游 #2020）。
 *
 * 这里负责「像文件路径」而非「一定存在」：最终必须由主进程按可信候选根解析并校验
 * （见 main/lib/preview-access-policy.ts）。允许 Unicode、空格与括号，兼容模型常见的
 * 自然语言文件名；扩展名不再限于可预览白名单，因为链接的语义本来就是「打开这个文件」。
 *
 * ⚠️ **我方与上游的落地差异**：上游 #2020 直接把这套宽规则写进了 `isRelativeFilePath`，
 * 而我方的 `isRelativeFilePath` 还同时被 `MarkdownInlineCode` 用来判断行内代码要不要变成
 * chip——一放宽，`v0.18.65`、`array.length`、`res.data` 这类行内代码都会被当成文件路径渲染成
 * 断链芯片。故这里另起一个函数，只服务于 Markdown 链接（`isLocalFileReference`），
 * `isRelativeFilePath` 维持原有的严格白名单不动。若维护者要求与上游完全一致，
 * 把 `isRelativeFilePath` 的函数体换成这里的实现即可。
 */
function isRelativeMarkdownLinkFileReference(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 2 || trimmed.length > MAX_FILE_REFERENCE_LENGTH) return false
  // 控制字符不可能出现在真实文件名里
  if (CONTROL_CHAR_RE.test(trimmed)) return false

  const { path: clean } = stripLineCol(trimmed)
  // 任何绝对路径形态都交给 isAbsoluteFilePath 判定，这里只处理相对引用
  // （与主进程 file-preview-service.isAbsolutePreviewPath 同口径）
  if (!clean || clean.startsWith('/') || clean.startsWith('\\') || WIN_DRIVE_RE.test(clean)) return false
  // 回复中的相对引用不得跨出候选根；需要父目录文件时模型应输出已授权的绝对路径
  if (clean.split(PATH_SEP_RE).includes('..')) return false
  // 不把 URL、file URI 或协议相对地址当成本地文件路径
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(clean) || clean.startsWith('//')) return false
  if (clean.endsWith('/') || clean.endsWith('\\')) return false

  const filename = getFileName(clean)
  const ext = getExtension(filename)
  const hasExplicitRelativePrefix = clean.startsWith('./') || clean.startsWith('.\\')
  // 仅因含分隔符而无扩展名的链接（如 v1/users）很可能是站内路由，不能劫持为文件预览
  return hasExplicitRelativePrefix || Boolean(ext) || EXTENSIONLESS_FILE_NAMES.has(filename.toLowerCase())
}

/**
 * 可安全交给主进程解析的本地文件引用（绝对或相对）。
 * 只用于 Markdown 链接目标：`[报告](workspace-files/plan/report.md)` 这类相对链接在
 * #2020 之前根本不会变成可点芯片，点了等于没反应。
 */
export function isLocalFileReference(text: string): boolean {
  // `//cdn.example.com/x.js` 这类协议相对 URL 会被 isAbsoluteFilePath 的 POSIX 规则误判成
  // 绝对路径（既有行为）。链接场景下必须先挡掉，否则外链会被劫持成断链文件芯片。
  if (text.trim().startsWith('//')) return false
  return isAbsoluteFilePath(text) || isRelativeMarkdownLinkFileReference(text)
}

/**
 * 内联文件引用补全：把裸文件名 / 相对路径按「本轮 → 会话」两级映射补全为绝对路径。
 * 本轮映射只覆盖当前 turn；Agent 隔几轮再裸提早先写过的文件（典型：长期记忆目录里的
 * `xxx.md`）时本轮映射命不中，只能拿裸名去候选目录猜、猜不到就误报「文件不存在」
 * （上游 issue #1691）。查找顺序：本轮映射 → 会话映射 → 返回 null 让调用方维持原样降级。
 * 保留行号后缀（`file.ts:42` / `file.ts:42:7`）。同名不同目录的文件已由映射构建方剔除。
 */
export function resolveInlineFileReference(
  text: string,
  turnFileMap: Map<string, string> | undefined,
  sessionFileMap: Map<string, string> | undefined,
): string | null {
  if ((!turnFileMap || turnFileMap.size === 0) && (!sessionFileMap || sessionFileMap.size === 0)) return null
  const trimmed = text.trim()
  const { path: pathPart, suffix } = stripLineCol(trimmed)
  const baseName = getFileName(pathPart)
  const abs = turnFileMap?.get(baseName) ?? sessionFileMap?.get(baseName)
  return abs ? abs + suffix : null
}

export type FilePathChipStatus = 'idle' | 'resolved' | 'broken'

/**
 * chip 悬停提示文案。
 * - 已解析：显示主进程真正命中的绝对路径（可能在子目录 / 长期记忆目录，不是「首个候选目录 + 文件名」的猜测）
 * - 未解析且是绝对路径：那条路径确实不存在
 * - 未解析且是相对引用 / 裸文件名：只是在候选目录里没找到，不能说「文件不存在」，更不能把猜的路径当事实
 * - 尚未检查：显示猜测的展示路径
 */
/**
 * 合并 chip 的候选基准目录：props 显式给的排前，消息级候选（BasePathsContext）补后。
 *
 * 背景（0.18.16 修维护者报障）：`TurnFileChangesSummary` / `write-result` 这类调用点只传单个
 * `basePath`（会话工作台）甚至什么都不传，而 Agent 在「项目文件」cwd 模式下写的相对路径要用
 * **项目文件根**才拼得出来——于是改动摘要里的 chip 点开必报「未找到文件」，同一个文件在左侧
 * 文件树里却能正常打开。消息级候选（sessionPath + 项目文件根 + 附加目录）本来就齐全，这里把它
 * 作为兜底补进来，让所有调用点共享同一份候选，不必逐个传参。
 *
 * 顺序即优先级：显式 props 先于上下文兜底；去重且丢弃空值。
 */
export function mergeCandidateBasePaths(
  basePath: string | undefined,
  basePaths: string[] | undefined,
  contextBasePaths: string[] | undefined,
): string[] {
  const merged: string[] = []
  const push = (value: string | undefined): void => {
    if (!value || merged.includes(value)) return
    merged.push(value)
  }
  if (basePaths && basePaths.length > 0) {
    for (const path of basePaths) push(path)
  } else {
    push(basePath)
  }
  for (const path of contextBasePaths ?? []) push(path)
  return merged
}

export function buildFilePathChipTitle(input: {
  status: FilePathChipStatus
  isAbsolute: boolean
  requestedPath: string
  displayPath: string
  resolvedPath?: string | null
}): string {
  if (input.status === 'resolved') return input.resolvedPath || input.displayPath
  if (input.status === 'broken') {
    return input.isAbsolute
      ? `文件不存在: ${input.displayPath}`
      : `未找到文件: ${input.requestedPath}（已在会话工作目录、附加目录与长期记忆目录中查找）`
  }
  return input.displayPath
}
