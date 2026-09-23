import * as React from 'react'
import type { FileAccessOptions } from '@canopy/shared'
import type { ResolveLiveMarkdownImageSrc } from './LiveMarkdownPreview'
import { resolveLocalImageUrl } from './local-image-url'

/**
 * 供 LiveMarkdownEditor 使用的本地图片解析器：把 Markdown 里的本地路径 src
 * 经 file:resolve-path IPC 换成 canopy-file:// URL。
 *
 * 相对路径优先按 Markdown 文件自身目录解析（同目录图片是最常见形态），
 * 再回落到调用方 fileAccess 里已有的候选目录（会话工作台/附加目录等）。
 * 同一份文件内重复出现的 src 只发一次 IPC；文件或访问上下文切换时缓存整体作废。
 */
export function useLocalMarkdownImageResolver(
  fileAccess: FileAccessOptions,
  markdownDir: string | null,
): ResolveLiveMarkdownImageSrc {
  const access = React.useMemo<FileAccessOptions>(() => {
    const bases = [
      ...(markdownDir ? [markdownDir] : []),
      ...(fileAccess.candidateBasePaths ?? []),
    ]
    return {
      ...fileAccess,
      candidateBasePaths: bases.filter((path, index) => path && bases.indexOf(path) === index),
    }
  }, [fileAccess, markdownDir])

  const requestsRef = React.useRef(new Map<string, Promise<string | null>>())
  const accessRef = React.useRef(access)
  if (accessRef.current !== access) {
    accessRef.current = access
    requestsRef.current = new Map()
  }

  return React.useCallback((src: string): Promise<string | null> => {
    const cached = requestsRef.current.get(src)
    if (cached) return cached
    // 候选归一与逐个解析在 local-image-url.ts，与 Agent 消息正文的图片共用同一份实现
    const request = resolveLocalImageUrl(src, accessRef.current)
    requestsRef.current.set(src, request)
    return request
  }, [access])
}
