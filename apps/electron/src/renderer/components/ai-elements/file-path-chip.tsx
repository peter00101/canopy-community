/**
 * FilePathChip — 文件路径可点击芯片
 *
 * 在 Agent 消息中检测到文件路径时，渲染为可点击的芯片。
 * 支持绝对路径和相对路径（相对于 basePath 解析）。
 * 点击后按用户偏好（标签页 / 侧边分屏）打开文件预览。
 */

import * as React from 'react'
import { useStore } from 'jotai'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { useOpenPreview } from '@/components/diff/preview-opener'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'

import {
  buildFilePathChipTitle,
  getFileName,
  isAbsoluteFilePath,
  isImageFilePath,
  isLocalFileReference,
  isRelativeFilePath,
  mergeCandidateBasePaths,
  PATH_SEP_RE,
  stripLineCol,
  TRAILING_SEP_RE,
  WIN_DRIVE_RE,
} from '@/lib/file-reference'
import { BasePathsContext } from './base-paths-context'

// 识别 / 补全 / 文案等纯逻辑已下沉到 @/lib/file-reference（可单测）；这里保留原有导出名，既有 import 站点不变。
export { isAbsoluteFilePath, isImageFilePath, isLocalFileReference, isRelativeFilePath }

/**
 * 文件解析结果缓存（模块级共享，避免重复 IPC）。key = filePath + basePaths；
 * 值为主进程解析到的绝对路径，null 表示按候选目录都找不到。
 */
const fileResolveCache = new Map<string, string | null>()
function existsCacheKey(filePath: string, bases: string[]): string {
  return `${filePath}\0${bases.join('\0')}`
}

interface FilePathChipProps {
  /** 文件路径（绝对或相对，可能带行号后缀） */
  filePath: string
  /** 基础目录路径（向后兼容，单值） */
  basePath?: string
  /** 多个候选基础目录（如主 cwd + 附加目录），点击时由主进程依次解析 */
  basePaths?: string[]
  className?: string
}

/** 文件路径芯片 — 可点击，触发文件预览 */
export function FilePathChip({ filePath, basePath, basePaths, className }: FilePathChipProps): React.ReactElement {
  const trimmedPath = filePath.trim()
  const { path: cleanPath, suffix: lineColSuffix } = stripLineCol(trimmedPath)

  const filename = getFileName(cleanPath)

  const isAbsolute = cleanPath.startsWith('/') || WIN_DRIVE_RE.test(cleanPath)

  const chipRef = React.useRef<HTMLButtonElement>(null)
  const [fileStatus, setFileStatus] = React.useState<'idle' | 'resolved' | 'broken'>('idle')
  const [resolvedPath, setResolvedPath] = React.useState<string | null>(null)
  const store = useStore()
  const openPreview = useOpenPreview()

  // 消息级候选（会话工作目录 + 项目文件根 + 附加目录）兜底：`TurnFileChangesSummary` 只传单个
  // basePath（会话工作台）、`write-result` 干脆什么都不传，Agent 在「项目文件」cwd 模式下写的
  // 相对路径要靠项目文件根才拼得出来——不补这一层，改动摘要里的 chip 点开必报「未找到文件」。
  const contextBasePaths = React.useContext(BasePathsContext)

  // 候选基础目录列表：props 显式给的优先，消息级候选补在后面
  const candidateBases = React.useMemo<string[]>(
    () => mergeCandidateBasePaths(basePath, basePaths, contextBasePaths),
    [basePath, basePaths, contextBasePaths],
  )

  // 用于 title 提示：绝对路径直接展示；相对路径优先匹配首段对应的 base 目录
  const displayPath = React.useMemo(() => {
    if (isAbsolute) return trimmedPath
    if (candidateBases.length > 0) {
      // 同时支持 / 和 \ 路径分隔符（Windows 兼容）
      const segments = cleanPath.split(PATH_SEP_RE)
      const firstSegment = segments[0]
      if (firstSegment) {
        for (const base of candidateBases) {
          // 剥除末尾分隔符后取最后一段作为目录名
          const normalized = base.replace(TRAILING_SEP_RE, '')
          const baseName = normalized.split(PATH_SEP_RE).pop()
          if (baseName === firstSegment) {
            // 剥除最后一段得到父目录
            const lastSep = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
            const parentDir = lastSep >= 0 ? normalized.slice(0, lastSep) : ''
            if (!normalized) return cleanPath
            return parentDir ? `${parentDir}/${cleanPath}` : `/${cleanPath}`
          }
        }
      }
      const base = candidateBases[0]!
      return TRAILING_SEP_RE.test(base) ? `${base}${cleanPath}` : `${base}/${cleanPath}`
    }
    return trimmedPath
  }, [trimmedPath, cleanPath, isAbsolute, candidateBases])

  // IntersectionObserver 懒检查文件是否存在
  React.useEffect(() => {
    const el = chipRef.current
    if (!el) return

    const key = existsCacheKey(cleanPath, candidateBases)
    if (fileResolveCache.has(key)) {
      const cached = fileResolveCache.get(key) ?? null
      setResolvedPath(cached)
      setFileStatus(cached === null ? 'broken' : 'resolved')
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return
        observer.disconnect()
        const bases = candidateBases.length > 0 ? candidateBases : undefined
        const sessionId = store.get(currentAgentSessionIdAtom)
        window.electronAPI.resolveFilePath(cleanPath, { sessionId: sessionId ?? undefined, candidateBasePaths: bases })
          .then((resolved) => {
            // null = 候选目录都没找到；解析成功但主进程未回传 path（旧构建）时记空串，仍视为已解析
            const path = resolved === null ? null : (resolved.path || '')
            fileResolveCache.set(key, path)
            setResolvedPath(path)
            setFileStatus(path === null ? 'broken' : 'resolved')
          })
          .catch(() => { /* IPC 失败不标记 */ })
      },
      { threshold: 0 },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [cleanPath, candidateBases, store])

  // 已解析出绝对路径时直接用它：预览与「在文件管理器中显示」都不必再按候选目录猜一遍
  // （show-item-in-folder 通道不带 sessionId，本就不知道长期记忆目录在哪）
  const effectivePath = resolvedPath || cleanPath

  const handleClick = React.useCallback(() => {
    const sessionId = store.get(currentAgentSessionIdAtom)
    if (!sessionId) return

    openPreview(sessionId, {
      filePath: effectivePath,
      previewOnly: true,
      basePaths: candidateBases.length > 0 ? candidateBases : undefined,
    })
  }, [store, openPreview, effectivePath, candidateBases])

  const handleShowInFolder = React.useCallback(() => {
    const bases = candidateBases.length > 0 ? candidateBases : undefined
    window.electronAPI.showItemInFolder(effectivePath, bases)
      .then((ok) => { if (!ok) toast.error(`未找到文件：${filename}`) })
      .catch(() => toast.error(`未找到文件：${filename}`))
  }, [effectivePath, candidateBases, filename])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          ref={chipRef}
          type="button"
          onClick={handleClick}
          title={buildFilePathChipTitle({ status: fileStatus, isAbsolute, requestedPath: cleanPath, displayPath, resolvedPath })}
          className={cn(
            'inline-flex items-center gap-[0.25em] rounded px-[0.35em] py-[0.15em] text-[0.875em] font-medium leading-none',
            'cursor-pointer transition-colors duration-150',
            'align-baseline not-prose',
            fileStatus === 'broken'
              ? 'opacity-50 border border-dashed border-muted-foreground/30 text-muted-foreground hover:opacity-70 hover:bg-muted/20'
              // 文件 chip 是「引用/次级强调」，走第二色相 accent-2（配色体系），主色留给主动作
              : 'bg-accent-2-soft text-accent-2-soft-foreground hover:bg-accent-2/25',
            className
          )}
        >
          <FileTypeIcon name={filename} isDirectory={false} size={12} />
          <span className="truncate max-w-[240px] leading-none">{filename}{lineColSuffix}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48 z-[9999]">
        <ContextMenuItem onClick={handleClick}>
          打开预览
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleShowInFolder}>
          在文件管理器中显示
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
