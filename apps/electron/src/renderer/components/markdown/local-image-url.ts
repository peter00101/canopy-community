/**
 * 本地图片 src → `canopy-file://` URL 的解析（IPC 侧）。
 *
 * 纯字符串归一在 `markdown-image-src.ts`（哪些 src 算本地、归一出哪些候选），
 * 本模块只管「拿着候选逐个问主进程要 URL」这一步，两个消费方共用同一份实现：
 * - `use-local-image-resolver.ts` —— LiveMarkdown 文件预览里的图片（0.18.38 起）
 * - `ai-elements/message.tsx` 的 `MarkdownImage` —— Agent 回复正文里的图片（0.18.68 起）
 *
 * 授权边界仍由主进程按 `access` 里的 sessionId / 候选目录判定（显式根集合），
 * 渲染层只负责把候选按顺序递过去。
 */

import type { FileAccessOptions, ResolvedFileUrl } from '@canopy/shared'
import { getLocalImagePathCandidates } from './markdown-image-src'

/** 解析单个路径的依赖，默认走 preload 的 file:resolve-path；测试可注入假实现。 */
export type ResolveFilePathFn = (
  filePath: string,
  access: FileAccessOptions,
) => Promise<(ResolvedFileUrl & { resolvedPath?: string }) | null>

const defaultResolveFilePath: ResolveFilePathFn = (filePath, access) =>
  window.electronAPI.resolveFilePath(filePath, access)

/**
 * 把图片 src 解析成可直接交给 `<img>` 的 URL；不是本地形态或全部候选都失败时返回 null。
 *
 * 候选按 `getLocalImagePathCandidates` 给出的顺序尝试（原样优先、解码形态兜底），
 * 首个拿到 url 的即采用；单个候选被拒（越界 / 不存在 / 是目录）不影响后续候选。
 */
export async function resolveLocalImageUrl(
  src: string,
  access: FileAccessOptions,
  resolveFilePath: ResolveFilePathFn = defaultResolveFilePath,
): Promise<string | null> {
  const candidates = getLocalImagePathCandidates(src)
  if (candidates.length === 0) return null

  for (const candidate of candidates) {
    try {
      const resolved = await resolveFilePath(candidate, access)
      if (resolved?.url) return resolved.url
    } catch {
      // 单个候选解析失败（越界被拒 / IPC 异常）继续尝试下一个候选
    }
  }
  return null
}
