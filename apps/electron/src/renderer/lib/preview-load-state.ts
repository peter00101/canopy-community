/**
 * preview-load-state — 文本类内联预览加载结果分类（纯逻辑，可单测）
 *
 * DiffTabContent 的 previewOnly 文本路径（含 Markdown）此前在
 * `resolveAndReadFile` 返回 null（文件不存在 / 读取失败）时把内容当空串渲染，
 * Markdown 预览因此呈现一片空白且无任何提示（维护者 2026-08-24 报障）。
 * 这里把「结果 → 用户可见状态」的判定收敛成纯函数，空白态一律给出明确文案。
 */

export interface TextPreviewReadResult {
  resolvedPath: string
  content: string
  isBinary: boolean
  isTooLarge: boolean
}

export type TextPreviewLoadState =
  | { kind: 'ok'; content: string }
  | { kind: 'unavailable'; reason: string }

/** 与主进程 MAX_TEXT_PREVIEW_SIZE（5MB）联动的文案，此处仅展示用 */
const TOO_LARGE_REASON = '此文本文件超过 5 MB，无法安全进行内联预览，请使用默认应用打开。'
const BINARY_REASON = '此二进制或编码异常文件暂不支持内联预览，请使用默认应用打开。'

/** 「未找到文件」提示的固定开头，同时用于反推降级卡片的标题（见 buildUnsupportedPreviewHeading） */
export const NOT_FOUND_REASON_PREFIX = '未找到文件：'

export function buildPreviewNotFoundReason(filePath: string): string {
  return `${NOT_FOUND_REASON_PREFIX}${filePath}\n文件可能已被移动、重命名或删除；若已恢复，可点击上方「刷新」重试。`
}

/**
 * 降级卡片的标题。
 *
 * 这张卡片原本只服务「二进制 / 超 5MB」，标题写死成「无法安全内联预览」；让它兼职
 * 承载「文件找不到」后标题没跟着改，于是找不到文件也被说成「不安全」——听着像文件有风险或
 * 格式不支持，与实际原因不符（维护者 2026-08-29 报障时正是被这句话误导）。
 */
export function buildUnsupportedPreviewHeading(reason: string): string {
  return reason.startsWith(NOT_FOUND_REASON_PREFIX) ? '未找到文件' : '无法安全内联预览'
}

/**
 * 分类文本预览的读取结果。
 * - null（解析不到 / 读取异常）→ unavailable，附带被请求的路径，绝不静默空白
 * - isTooLarge / isBinary → unavailable，沿用既有文案
 * - 其余 → ok（content 可为空串，空文件由渲染层显示「文件为空」占位）
 */
export function classifyTextPreviewResult(
  result: TextPreviewReadResult | null | undefined,
  filePath: string,
): TextPreviewLoadState {
  if (!result) {
    return { kind: 'unavailable', reason: buildPreviewNotFoundReason(filePath) }
  }
  if (result.isTooLarge) {
    return { kind: 'unavailable', reason: TOO_LARGE_REASON }
  }
  if (result.isBinary) {
    return { kind: 'unavailable', reason: BINARY_REASON }
  }
  return { kind: 'ok', content: result.content ?? '' }
}
