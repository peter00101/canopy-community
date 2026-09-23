import * as React from 'react'
import { useAtomValue } from 'jotai'
import { activeTabAtom } from '@/atoms/tab-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { AgentHeader } from '@/components/agent/AgentHeader'
import { TabBar } from '@/components/tabs/TabBar'
import { useProjectActions } from '@/hooks/useProjectActions'
import { useWorkspaceFilesPath } from '@/hooks/useWorkspaceFilesPath'
import { MAC_TITLEBAR_HEIGHT_PX, MAC_TRAFFIC_LIGHTS_INSET_PX, getMacTitleRowContent } from '@/lib/window-titlebar-layout'
import { cn } from '@/lib/utils'

/**
 * macOS 标题行（Chrome 式）：横贯窗口的 40px 一行——左侧 96px 留给原生红绿灯，
 * 其余放标签栏（对话视图）或 AgentHeader（Agent 会话）。侧栏 / 中列 / 右面板全部从
 * 这一行下面开始，红绿灯与侧栏互不影响；侧栏不再为红绿灯留白，折叠 rail 也回到 60。
 *
 * 只在 mac 渲染（AppShell 按 getTabStripHost 决定）；Windows 走 WindowControls 的
 * 32px 系统标题栏 + 中列内标签栏那套。底色 / 底线见 globals.css 的 .mac-title-row。
 */
export function MacTitleRow({ hidden = false }: { hidden?: boolean }): React.ReactElement {
  const activeTab = useAtomValue(activeTabAtom)
  const activeView = useAtomValue(activeViewAtom)
  const { workspaces, currentWorkspaceId } = useProjectActions()
  const currentWorkspace = workspaces.find((workspace) => workspace.id === currentWorkspaceId)
  const workspaceFilesPath = useWorkspaceFilesPath(
    currentWorkspace?.slug ?? null,
    currentWorkspace?.projectRootPath ?? null,
  )
  const content = getMacTitleRowContent({ activeView, activeTabType: activeTab?.type })

  return (
    <div
      className={cn(
        // z-[61]：压过 z-60 的三列，标签悬停预览 / 撕出提示线才不会被下方内容盖住
        'mac-title-row relative z-[61] flex w-full flex-shrink-0 items-stretch titlebar-drag-region',
        hidden && 'hidden',
      )}
      style={{ height: MAC_TITLEBAR_HEIGHT_PX }}
    >
      {/* 原生红绿灯占位：trafficLightPosition x=18 起、跨度 60、右留 18；本身只是拖拽区 */}
      <div aria-hidden="true" className="flex-shrink-0" style={{ width: MAC_TRAFFIC_LIGHTS_INSET_PX }} />
      <div className="flex min-w-0 flex-1 flex-col justify-end">
        {content === 'tabs' && <TabBar />}
        {content === 'agent-header' && activeTab?.type === 'agent' && (
          <AgentHeader sessionId={activeTab.sessionId} projectFilesPath={workspaceFilesPath} />
        )}
      </div>
    </div>
  )
}
