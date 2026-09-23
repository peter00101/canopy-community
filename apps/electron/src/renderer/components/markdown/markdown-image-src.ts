/**
 * Markdown 图片 src 的本地路径归一。
 *
 * LiveMarkdown 预览里的图片分两类：
 * - 直接可加载：http(s)/data/blob/canopy-file，交给 <img> 即可（CSP 已放行）；
 * - 本地路径：相对/绝对/file: URL，渲染层无文件权限，必须经 file:resolve-path IPC
 *   换成 canopy-file:// URL 才能显示。
 *
 * 本模块只做纯字符串归一（可单测），IPC 解析在 use-local-image-resolver 里。
 */

/** 直接可由 <img> 加载、无需本地解析的 src（协议白名单与 InlineImageWidget 一致）。 */
export function isDirectRenderableImageSrc(src: string): boolean {
  return /^(?:https?:|data:|blob:|canopy-file:)/i.test(src)
}

const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:[\\/]/
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i

/**
 * 把图片 src 归一成本地路径候选列表（按顺序逐个尝试解析）。
 * 返回空数组 = 不是本地可解析形态（外链/data/blob/canopy-file/其他 scheme/协议相对/空串）。
 *
 * 裸形态的 src 可能带百分号编码（`img%20a.png`），角括号形态则是原始字符；
 * 编码与否无法从字符串本身判定，因此原样与解码后两种候选都给。
 */
export function getLocalImagePathCandidates(src: string): string[] {
  const trimmed = src.trim()
  if (!trimmed || isDirectRenderableImageSrc(trimmed)) return []
  // 协议相对 URL（//cdn.example/x.png）不是本地路径，也不进白名单——保持不加载
  if (trimmed.startsWith('//')) return []
  if (/^file:/i.test(trimmed)) {
    try {
      return [decodeURIComponent(new URL(trimmed).pathname)]
    } catch {
      return []
    }
  }
  // 其他 scheme（mailto:/obsidian:/…）不是本地路径；Windows 盘符（C:/）除外
  if (URL_SCHEME_PATTERN.test(trimmed) && !WINDOWS_DRIVE_PATTERN.test(trimmed)) return []
  const decoded = (() => {
    try {
      return decodeURIComponent(trimmed)
    } catch {
      return trimmed
    }
  })()
  return decoded === trimmed ? [trimmed] : [trimmed, decoded]
}
