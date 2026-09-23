/**
 * AgentHeader — Agent 会话头部
 *
 * 显示会话标题；通过标题下拉菜单进入重命名。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Check, ChevronDown, FolderOpen, PanelRight, Pencil, Split, X } from 'lucide-react'
import { agentSessionsAtom, agentSessionPathMapAtom, agentSideTemporaryAgentMapAtom, agentDiffPanelTabAtom, currentSessionSidePanelOpenAtom, getExplorationSidePanelTab } from '@/atoms/agent-atoms'
import { describeAgentCwd } from '@/lib/agent-cwd-label'
import { tabsAtom, updateTabTitle } from '@/atoms/tab-atoms'
import { replaceAgentSessionInFreshnessOrder } from '@/lib/agent-session-list'
import { cn } from '@/lib/utils'
import { detectIsMac } from '@/lib/platform'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/** AgentHeader 属性接口 */
interface AgentHeaderProps {
  sessionId: string
  projectFilesPath?: string | null
}

export function AgentHeader({ sessionId, projectFilesPath }: AgentHeaderProps): React.ReactElement | null {
  const sessions = useAtomValue(agentSessionsAtom)
  const session = sessions.find((s) => s.id === sessionId) ?? null
  const sessionPathMap = useAtomValue(agentSessionPathMapAtom)
  const sessionPath = sessionPathMap.get(sessionId) ?? null
  // Agent 真实 cwd：规则与主进程 resolveAgentCwd 一致（worktree > agentCwdMode > 存量默认会话工作台）
  const cwd = React.useMemo(() => describeAgentCwd({
    agentCwdMode: session?.agentCwdMode,
    activeWorktreePath: session?.activeWorktree?.path ?? null,
    activeWorktreeBranch: session?.activeWorktree?.branch ?? null,
    projectFilesPath: projectFilesPath ?? null,
    sessionPath,
  }), [session?.agentCwdMode, session?.activeWorktree?.path, session?.activeWorktree?.branch, projectFilesPath, sessionPath])
  const handleRevealCwd = React.useCallback(() => {
    if (!cwd) return
    window.electronAPI.showItemInFolder(cwd.path).catch(console.error)
  }, [cwd])
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setSideTemporaryAgentMap = useSetAtom(agentSideTemporaryAgentMapAtom)
  const setSidePanelTabMap = useSetAtom(agentDiffPanelTabAtom)
  const [isRightPanelOpen, setRightPanelOpen] = useAtom(currentSessionSidePanelOpenAtom)
  const [editing, setEditing] = React.useState(false)
  const [editTitle, setEditTitle] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)

  const explorationBranches = React.useMemo(() => sessions
    .filter((item) => item.explorationParentSessionId === sessionId && item.explorationSourceMessageId)
    .sort((a, b) => b.updatedAt - a.updatedAt), [sessionId, sessions])

  const reopenExploration = React.useCallback((branch: typeof explorationBranches[number]): void => {
    const sourceMessageId = branch.explorationSourceMessageId
    if (!sourceMessageId) return
    setSideTemporaryAgentMap((prev) => {
      const openBranches = prev.get(sessionId) ?? []
      if (openBranches.some((item) => item.sessionId === branch.id)) return prev
      const next = new Map(prev)
      next.set(sessionId, [...openBranches, {
        sessionId: branch.id,
        sourceMessageId,
        sourceLabel: branch.explorationSourceLabel || '主线探索节点',
      }])
      return next
    })
    setRightPanelOpen(true)
    setSidePanelTabMap((prev) => new Map(prev).set(sessionId, getExplorationSidePanelTab(branch.id)))
  }, [sessionId, setRightPanelOpen, setSidePanelTabMap, setSideTemporaryAgentMap])

  if (!session) return null

  /** 进入编辑模式 */
  const startEdit = (): void => {
    setEditTitle(session.title)
    setEditing(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  /** 保存标题 */
  const saveTitle = async (): Promise<void> => {
    const trimmed = editTitle.trim()
    if (!trimmed || trimmed === session.title) {
      setEditing(false)
      return
    }

    try {
      const updated = await window.electronAPI.updateAgentSessionTitle(session.id, trimmed)
      // 同步更新标签页标题
      setTabs((prev) => updateTabTitle(prev, updated.id, updated.title))
      // 同步更新侧边栏会话列表
      setAgentSessions((prev) => replaceAgentSessionInFreshnessOrder(prev, updated))
    } catch (error) {
      console.error('[AgentHeader] 更新标题失败:', error)
    }
    setEditing(false)
  }

  /** 键盘事件 */
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveTitle()
    } else if (e.key === 'Escape') {
      setEditing(false)
    }
  }

  return (
    <div className={cn(
      'agent-header-bar relative z-[51] flex items-center gap-2 px-3',
      // mac 下住在 MacTitleRow（与红绿灯同行）：填满 36px 行高（h-9 = MAC_TITLEBAR_HEIGHT_PX），分隔线由标题行统一画
      // Windows 分支此前既无背景也无底线，整条透出内容区底色，浅色主题下就是一片白
      // （维护者 2026-09-09 指着它说「这不还是白的嘛」）；右侧面板的同层顶栏一直是有底线的。
      detectIsMac() ? 'h-9' : 'h-[48px] border-b border-border/60',
    )}>
      {/* 页面标题栏仍可拖动；系统控制按钮由窗口顶部的统一标题栏承载。 */}
      <div className="absolute inset-0 titlebar-drag-region pointer-events-none" />
      {editing ? (
        <div className="flex items-center gap-1.5 flex-1 min-w-0 titlebar-no-drag">
          <input
            ref={inputRef}
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={saveTitle}
            className={cn('flex-1 bg-transparent font-normal border-b border-primary/50 outline-none px-0 py-0.5 min-w-0', detectIsMac() ? 'text-[13px]' : 'text-[15px]')}
            maxLength={100}
          />
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={saveTitle}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <Check className="size-3.5" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setEditing(false)}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="titlebar-no-drag group flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-left transition-colors hover:bg-muted/60"
              aria-label={`会话菜单：${session.title}`}
            >
              {/* mac 下标题与 12px 的 tab 文字同住一行，15px 显大，收到 13px（维护者 0.18.33 定） */}
              <span className={cn('truncate font-normal text-foreground', detectIsMac() ? 'text-[13px]' : 'text-[15px]')}>{session.title}</span>
              <ChevronDown className="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="z-[100] min-w-40 titlebar-no-drag">
            <DropdownMenuItem onSelect={startEdit}>
              <Pencil className="size-3.5" />
              重命名
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {cwd && (
        <button
          type="button"
          onClick={handleRevealCwd}
          title={cwd.tooltip}
          aria-label={`Agent 工作目录：${cwd.kindLabel} ${cwd.path}`}
          data-agent-cwd-kind={cwd.kind}
          className="titlebar-no-drag ml-1 inline-flex max-w-[260px] shrink items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <FolderOpen className="size-3 shrink-0" />
          <span className="shrink-0 opacity-70">{cwd.kindLabel}</span>
          <span className="opacity-40">·</span>
          <span className="truncate">{cwd.name}</span>
        </button>
      )}
      {explorationBranches.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                'titlebar-no-drag inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground transition-[background-color,color,transform] hover:bg-muted hover:text-foreground active:scale-[0.96]',
                detectIsMac() ? 'h-8' : 'h-10',
              )}
              aria-label={`打开 ${explorationBranches.length} 个探索分支`}
              title={`打开探索分支（${explorationBranches.length}）`}
            >
              <Split className="size-3.5" />
              <span className="hidden sm:inline">探索</span>
              {explorationBranches.length > 1 && <span className="tabular-nums">{explorationBranches.length}</span>}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="z-[100] w-64 titlebar-no-drag"
            // 选择或失焦关闭后不要把焦点回跳到「探索」触发器，避免出现残留 focus 框。
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            {explorationBranches.map((branch) => (
              <DropdownMenuItem key={branch.id} onSelect={() => reopenExploration(branch)} className="flex items-center gap-2 py-2">
                <Split className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">{branch.title}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {!isRightPanelOpen && (
        <button
          type="button"
          onClick={() => setRightPanelOpen(true)}
          className="titlebar-no-drag ml-auto inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-[background-color,color,transform] hover:bg-muted hover:text-foreground active:scale-[0.96]"
          aria-label="展开右侧工作区"
        >
          <PanelRight className="size-4" />
        </button>
      )}
    </div>
  )
}
