import * as React from 'react'
import type { FileEntry } from '@canopy/shared'
import { REFRESH_FAILED_KEEP_PREVIOUS_MESSAGE, reconcileFileBrowserEntries, shouldKeepPreviousListingOnRefreshFailure } from './file-browser-load-state'

interface AttachedDirectoryChildrenOptions {
  stateKey: string
  path: string
  sessionId: string
  allowedPaths?: string[]
  expanded: boolean
  isDirectory: boolean
  refreshVersion: number
}

interface DirectorySnapshot {
  identity: string
  children: FileEntry[]
}

const EMPTY_CHILDREN: FileEntry[] = []

/**
 * 展开、恢复与刷新共用一条加载路径。折叠/卸载/切换上下文时丢弃旧响应，
 * IPC 完成只更新子项，不反向打开用户已收起的目录。
 *
 * watcher 后台刷新期间保留旧子项；内容未变时沿用原快照（不触发重渲染）；
 * 已成功列出过的目录偶发失败时保留旧子项，不插入错误行造成下方内容上下跳动。
 */
export function useAttachedDirectoryChildren({ stateKey, path, sessionId, allowedPaths, expanded, isDirectory, refreshVersion }: AttachedDirectoryChildrenOptions) {
  const allowedPathsKey = JSON.stringify(allowedPaths ?? [])
  const identity = JSON.stringify([stateKey, path, sessionId, allowedPathsKey])
  const [snapshot, setSnapshot] = React.useState<DirectorySnapshot | null>(null)
  const [errorState, setErrorState] = React.useState<{ identity: string; message: string } | null>(null)
  // 异步失败回调需要读「当时已成功列出的目录」，不能把 snapshot 放进 effect 依赖（否则每次成功都会重拉）。
  const loadedIdentityRef = React.useRef<string | null>(null)
  loadedIdentityRef.current = snapshot?.identity ?? null

  React.useEffect(() => {
    if (!expanded || !isDirectory) return
    let cancelled = false
    // 不在请求开始时清错误：持续失败的目录若每次刷新都先清再置，错误行会反复闪现。
    void window.electronAPI.listAttachedDirectory(path, {
      sessionId,
      candidateBasePaths: JSON.parse(allowedPathsKey) as string[],
    }).then((children) => {
      if (cancelled) return
      setErrorState(null)
      setSnapshot((previous) => {
        if (previous?.identity !== identity) return { identity, children }
        const reconciled = reconcileFileBrowserEntries(previous.children, children)
        return reconciled === previous.children ? previous : { identity, children: reconciled }
      })
    }).catch((error: unknown) => {
      if (cancelled) return
      if (shouldKeepPreviousListingOnRefreshFailure({ requestKey: identity, loadedKey: loadedIdentityRef.current })) {
        // 保留旧子项，但如实提示：持续失败（权限被撤销、网络盘断开）不能变成一棵无声过期的树。
        console.warn('[AttachedDirectory] 刷新子目录失败，保留上次成功的子项:', error)
        setErrorState({ identity, message: REFRESH_FAILED_KEEP_PREVIOUS_MESSAGE })
        return
      }
      console.error('[AttachedDirectory] 加载子目录失败:', error)
      setErrorState({ identity, message: '加载失败，请收起后重新展开重试' })
    })
    return () => { cancelled = true }
  }, [identity, path, sessionId, allowedPathsKey, expanded, isDirectory, refreshVersion])

  // 物理路径或授权上下文切换的第一帧也不能显示上一目录的内容。
  return {
    children: snapshot?.identity === identity ? snapshot.children : EMPTY_CHILDREN,
    loaded: snapshot?.identity === identity,
    error: errorState?.identity === identity ? errorState.message : null,
  }
}
