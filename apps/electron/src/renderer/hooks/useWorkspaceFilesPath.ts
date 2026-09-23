import * as React from 'react'

/**
 * 当前工作区共享文件目录（workspace-files）的绝对路径。
 * AgentView 用它做 @ 引用搜索与路径解析，mac 标题行（MacTitleRow）里的 AgentHeader
 * 用它标注 Agent 工作目录；两处共用一份取值逻辑，避免各自请求、各自过期。
 */
export function useWorkspaceFilesPath(workspaceSlug: string | null, projectRootPath: string | null): string | null {
  const [workspaceFilesPath, setWorkspaceFilesPath] = React.useState<string | null>(null)

  React.useEffect(() => {
    let disposed = false

    // 同一项目重新关联本地根时 slug 保持不变，必须立即废弃旧路径与旧请求结果。
    setWorkspaceFilesPath(null)
    if (!workspaceSlug) return

    window.electronAPI
      .getWorkspaceFilesPath(workspaceSlug)
      .then((path) => {
        if (!disposed) setWorkspaceFilesPath(path)
      })
      .catch(() => {
        if (!disposed) setWorkspaceFilesPath(null)
      })

    return () => {
      disposed = true
    }
  }, [workspaceSlug, projectRootPath])

  return workspaceFilesPath
}
