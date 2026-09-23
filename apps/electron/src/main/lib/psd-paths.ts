/**
 * PSD 工具的路径授权：与 Office 工具同一套判定（realpath 落在会话授权根内、常规文件、体积上限），
 * 只是放行的扩展名不同。集中在这里，免得三个工具各写一遍。
 */

import { existsSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { isPathWithinRoots, realpathOrResolve, resolveExistingRealPath } from './file-access-policy'

export class PsdAccessError extends Error {}

/** ag-psd 不支持 PSB（大型文档），只认 .psd */
export const PSD_EXTENSIONS: ReadonlySet<string> = new Set(['.psd'])
/** 可作为图层来源 / 蒙版来源的图片格式（sharp 能解码的） */
export const PSD_ASSET_EXTENSIONS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.tif', '.tiff', '.bmp', '.avif'])
/** 规格文件 */
export const PSD_SPEC_EXTENSIONS: ReadonlySet<string> = new Set(['.json'])

const MAX_PSD_BYTES = 500 * 1024 * 1024
const MAX_ASSET_BYTES = 100 * 1024 * 1024

function ensureRoots(roots: readonly string[]): void {
  if (roots.length === 0) throw new PsdAccessError('当前会话没有已授权的目录，无法访问文件')
}

function toAbsolute(filePath: string, baseDir?: string): string {
  return isAbsolute(filePath) ? filePath : resolve(baseDir || process.cwd(), filePath)
}

function withinRoots(resolved: string, roots: readonly string[]): boolean {
  return isPathWithinRoots(resolved, () => roots.map((root) => realpathOrResolve(root)))
}

function resolveExistingWithin(filePath: string, roots: readonly string[], baseDir: string | undefined, maxBytes: number): string {
  ensureRoots(roots)
  const absolute = toAbsolute(filePath, baseDir)
  const resolved = resolveExistingRealPath(absolute)
  if (!resolved) {
    throw new PsdAccessError(`文件不存在：${filePath}${baseDir && !isAbsolute(filePath) ? `（按工作目录 ${baseDir} 解析）` : ''}`)
  }
  if (!withinRoots(resolved, roots)) {
    throw new PsdAccessError(`文件不在本次会话已授权的目录内：${filePath}。把它放进项目目录，或让用户在「文件」面板附加所在目录`)
  }
  const stats = statSync(resolved)
  if (!stats.isFile()) throw new PsdAccessError(`不是常规文件：${filePath}`)
  if (stats.size > maxBytes) throw new PsdAccessError(`文件超过 ${Math.floor(maxBytes / 1024 / 1024)}MB 处理上限：${filePath}`)
  return resolved
}

/** 已存在的 .psd（读取 / 编辑的输入） */
export function resolveReadablePsdPath(filePath: string, roots: readonly string[], baseDir?: string): string {
  if (!filePath || typeof filePath !== 'string') throw new PsdAccessError('未提供文件路径')
  const ext = extname(filePath).toLowerCase()
  if (ext === '.psb') throw new PsdAccessError('暂不支持 .psb（大型文档格式），请在 Photoshop 里另存为 .psd')
  if (!PSD_EXTENSIONS.has(ext)) throw new PsdAccessError(`只支持 .psd，收到 ${ext || '（无扩展名）'}`)
  return resolveExistingWithin(filePath, roots, baseDir, MAX_PSD_BYTES)
}

/** 图层素材 / 蒙版图片 */
export function resolveReadableAssetPath(filePath: string, roots: readonly string[], baseDir?: string): string {
  if (!filePath || typeof filePath !== 'string') throw new PsdAccessError('未提供素材路径')
  const ext = extname(filePath).toLowerCase()
  if (!PSD_ASSET_EXTENSIONS.has(ext)) throw new PsdAccessError(`素材只支持 ${[...PSD_ASSET_EXTENSIONS].join(' / ')}，收到 ${ext || '（无扩展名）'}：${filePath}`)
  return resolveExistingWithin(filePath, roots, baseDir, MAX_ASSET_BYTES)
}

/** 规格 JSON 文件 */
export function resolveReadableSpecPath(filePath: string, roots: readonly string[], baseDir?: string): string {
  if (!filePath || typeof filePath !== 'string') throw new PsdAccessError('未提供规格文件路径')
  const ext = extname(filePath).toLowerCase()
  if (!PSD_SPEC_EXTENSIONS.has(ext)) throw new PsdAccessError(`规格文件必须是 .json，收到 ${ext || '（无扩展名）'}`)
  return resolveExistingWithin(filePath, roots, baseDir, 20 * 1024 * 1024)
}

/**
 * 输出文件（.psd 或 .png）的路径判定：父目录必须真实存在且在授权根内。
 * 默认拒绝覆盖已有文件；allowOverwrite 只给「编辑并写回同一文件」这种明确意图用。
 */
export function resolveWritablePath(
  filePath: string,
  roots: readonly string[],
  baseDir: string | undefined,
  options: { extensions: ReadonlySet<string>; allowOverwrite?: boolean },
): string {
  if (!filePath || typeof filePath !== 'string') throw new PsdAccessError('未提供输出路径')
  const ext = extname(filePath).toLowerCase()
  if (!options.extensions.has(ext)) throw new PsdAccessError(`输出只支持 ${[...options.extensions].join(' / ')}，收到 ${ext || '（无扩展名）'}`)
  ensureRoots(roots)
  const absolute = toAbsolute(filePath, baseDir)
  if (!options.allowOverwrite && existsSync(absolute)) {
    throw new PsdAccessError(`文件已存在：${filePath}。默认不覆盖已有文件，要覆盖请显式传 overwrite=true`)
  }
  const parent = dirname(absolute)
  const resolvedParent = resolveExistingRealPath(parent)
  if (!resolvedParent) throw new PsdAccessError(`目录不存在：${parent}`)
  if (!withinRoots(resolvedParent, roots)) throw new PsdAccessError(`目录不在本次会话已授权的范围内：${parent}`)
  return join(resolvedParent, basename(absolute))
}

/** 预览 PNG 默认落在 PSD 旁边：<名字>-preview.png */
export function defaultPreviewPngPath(psdPath: string): string {
  const ext = extname(psdPath)
  return `${psdPath.slice(0, psdPath.length - ext.length)}-preview.png`
}
