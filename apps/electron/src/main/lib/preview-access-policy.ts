/**
 * 内联预览家族（file:resolve-and-read / file:resolve-path / file:prepare-pdf-preview /
 * file:prepare-html-preview / file:office-to-html / file:resolve-markdown-media）的授权判定纯逻辑。
 *
 * 0.18.66 前这 6 个通道只做候选基路径解析后直读，渲染层被攻破时可读任意文件。
 * 上游 #2020 的正解：不复用 isPathAllowed 的聚合根（getAgentWorkspacesDir() 会让单个会话的
 * 权限横向扩张到别的会话），而是另建一套**更窄的显式根集合**，并给用户主动选择的可信 UI 入口
 * （文件面板、聊天附件）留 `unrestricted` 开关。
 *
 * 与 file-access-policy.ts 同样的分工：这里只做「路径 + 显式根集合 → 允不允许 / 解析到哪」，
 * **不知道**根集合怎么来——由 ipc.ts 的 getPreviewAccessScope() 收集后注入，因此可直接用普通
 * Bun 测试覆盖，不依赖 electron 与各 manager。
 *
 * 判定口径：
 * 1. `unrestricted` 时直接放行（存在性由调用方 resolveFilePath 已保证）；
 * 2. 目录判定：realpath 后须位于任一显式目录根之下；
 * 3. 文件判定：目录判定通过，或恰好是某个单文件授权（会话/工作区附加的单个文件）本身——
 *    单文件授权**不**放行同目录兄弟文件；
 * 4. 相对引用只按「显式授权的候选根」拼接，且解析结果的 realpath 必须仍留在这些候选根内
 *    （防符号链接把相对预览带出会话目录）；绝对路径同样只接受当前会话的显式目录/文件授权。
 */

import { dirname } from 'node:path'
import { isUnderRoot, realpathOrResolve } from './file-access-policy'
import { isAbsolutePreviewPath, resolveFilePath } from './file-preview-service'

/** 一次预览请求的授权范围：由 ipc.ts 按 FileAccessOptions 收集，本模块只消费。 */
export interface PreviewAccessScope {
  /** 显式目录根（agentCwd / Skill 基路径 / 会话附加目录与 worktree / 会话工作台 / 项目文件 / 记忆目录 / 附件与下载目录 / 教程配图等） */
  directoryRoots: readonly string[]
  /** 单文件授权（会话/工作区附加的单个文件），仅放行文件本身 */
  filePaths: readonly string[]
  /** 可信 UI 主动选择的入口：不按显式根收窄 */
  unrestricted?: boolean
}

/** 目录（或候选基路径）是否落在显式目录根内。 */
export function isExplicitPreviewDirectoryPath(path: string, scope: PreviewAccessScope): boolean {
  if (scope.unrestricted) return true
  const resolved = realpathOrResolve(path)
  return scope.directoryRoots.some((root) => isUnderRoot(resolved, root))
}

/** 预览文件必须属于显式目录根，或恰好是单文件授权本身。 */
export function isExplicitPreviewFilePath(path: string, scope: PreviewAccessScope): boolean {
  if (scope.unrestricted) return true
  const resolved = realpathOrResolve(path)
  if (scope.directoryRoots.some((root) => isUnderRoot(resolved, root))) return true
  return scope.filePaths.some((file) => realpathOrResolve(file) === resolved)
}

/** 只保留落在显式目录根内的候选基路径；渲染层传来的候选目录不能凭空变成授权根。 */
export function filterExplicitPreviewBasePaths(
  candidateBasePaths: readonly string[] | undefined,
  scope: PreviewAccessScope,
): string[] {
  return (candidateBasePaths ?? []).filter((basePath) => isExplicitPreviewDirectoryPath(basePath, scope))
}

/**
 * 所有内联预览在注册文件 URL 或读取内容前，都必须经这里验证最终 realpath 的授权范围。
 * 返回 null 表示：文件不存在、不在显式授权范围内、或相对引用逃出了显式候选目录。
 */
export function resolveAuthorizedPreviewPath(
  filePath: string,
  candidateBasePaths: readonly string[] | undefined,
  scope: PreviewAccessScope,
): string | null {
  if (typeof filePath !== 'string' || filePath.length === 0) return null
  const explicitBasePaths = filterExplicitPreviewBasePaths(candidateBasePaths, scope)
  const resolved = resolveFilePath(filePath, explicitBasePaths)
  if (!resolved || !isExplicitPreviewFilePath(resolved, scope)) return null

  // 相对引用必须留在最初的显式候选目录中。聚合工作区授权不能让绝对或相对预览
  // 横向扩张到其他会话；绝对路径同样只接受当前会话的显式目录/文件授权。
  if (!isAbsolutePreviewPath(filePath) && !scope.unrestricted) {
    const realResolved = realpathOrResolve(resolved)
    if (!explicitBasePaths.some((basePath) => isUnderRoot(realResolved, basePath))) return null
  }
  return resolved
}

/**
 * HTML 预览是否可以把所在目录整体注册为 URL 根（让相对 CSS/JS/图片可加载）。
 * 单文件授权只放行 HTML 本体：父目录不在显式目录根内时返回 false，调用方只注册文件。
 */
export function canRegisterPreviewDirectory(resolvedFilePath: string, scope: PreviewAccessScope): boolean {
  return isExplicitPreviewDirectoryPath(dirname(resolvedFilePath), scope)
}
