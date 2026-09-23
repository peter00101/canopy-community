/**
 * 右侧面板的 PSD 内联预览：渲染合成图到 canopy-preview 临时目录，注册成受令牌保护的
 * canopy-file 地址，连同图层树一起交给渲染层。同一文件重新渲染（点眼睛改显隐）时删掉上一张。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PsdPreviewOptions, PsdPreviewResult } from '@canopy/shared'
import { renderPsd } from './psd-service'

const DEFAULT_MAX_SIDE = 2048
const MAX_MAX_SIDE = 4096

/** 每个 PSD 路径上一次渲染出的临时 PNG，重渲染时清理 */
const lastRendered = new Map<string, string>()

export async function preparePsdPreview(resolvedPath: string, options: PsdPreviewOptions = {}): Promise<PsdPreviewResult> {
  const maxSide = options.maxSide && options.maxSide > 0 ? Math.min(MAX_MAX_SIDE, Math.floor(options.maxSide)) : DEFAULT_MAX_SIDE
  const result = await renderPsd(resolvedPath, {
    hiddenIds: options.hiddenLayerIds ?? [],
    visibleIds: options.visibleLayerIds ?? [],
    maxSide,
  })
  const dir = join(tmpdir(), 'canopy-preview')
  await mkdir(dir, { recursive: true })
  const pngPath = join(dir, `psd-${randomUUID()}.png`)
  await writeFile(pngPath, result.png)
  const previous = lastRendered.get(resolvedPath)
  if (previous && previous !== pngPath) await rm(previous, { force: true }).catch(() => undefined)
  lastRendered.set(resolvedPath, pngPath)
  const { registerAppFilePath } = await import('./local-file-protocol')
  return {
    resolvedPath,
    width: result.width,
    height: result.height,
    compositeUrl: registerAppFilePath(pngPath),
    layers: result.layers,
    engine: result.engine,
    colorMode: result.colorMode,
    warnings: result.warnings.length ? result.warnings : undefined,
  }
}
