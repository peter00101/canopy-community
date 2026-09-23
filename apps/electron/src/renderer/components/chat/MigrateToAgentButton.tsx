/**
 * MigrateToAgentButton — 切换到 Agent 模式按钮
 *
 * 常驻在助手消息 Action Bar 中（紧挨「复制」，易误触），点击先弹二次确认，确认「切换」后：
 * 1. 创建 Agent 会话（绑定默认工作区）
 * 2. 复制当前 Chat 对话的文字记录到新 Agent 会话（原 Chat 对话保留）
 * 3. 打开 Agent 会话 Tab 并自动激活
 * 4. 通过 Sonner 通知用户已完成切换
 *
 * AgentRecommendBanner 的横幅按钮是明确意图，不加确认。
 */

import * as React from 'react'
import { useStore } from 'jotai'
import { toast } from 'sonner'
import { Bot, Loader2 } from 'lucide-react'
import { MessageAction } from '@/components/ai-elements/message'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { MIGRATE_TO_AGENT_CONFIRM_COPY, resolveMigrateToAgentClick } from './migrate-to-agent-confirm'
import {
  agentChannelIdAtom,
  agentModelIdAtom,
  agentWorkspacesAtom,
  agentSessionsAtom,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom,
} from '@/atoms/agent-atoms'
import { tabsAtom, activeTabIdAtom, openTab } from '@/atoms/tab-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { appModeAtom } from '@/atoms/app-mode'

interface MigrateToAgentButtonProps {
  /** 当前对话 ID */
  conversationId: string
}

export function MigrateToAgentButton({ conversationId }: MigrateToAgentButtonProps): React.ReactElement {
  const store = useStore()
  const [migrating, setMigrating] = React.useState(false)
  const [confirmOpen, setConfirmOpen] = React.useState(false)

  /** 点击图标：只弹确认，不产生任何副作用 */
  const handleRequestMigrate = (): void => {
    const decision = resolveMigrateToAgentClick({
      migrating,
      hasAgentChannel: Boolean(store.get(agentChannelIdAtom)),
    })
    if (decision === 'ignore') return
    if (decision === 'need-agent-channel') {
      toast.error('请先在设置中配置 Agent 渠道')
      return
    }
    setConfirmOpen(true)
  }

  const handleMigrate = async (): Promise<void> => {
    if (migrating) return

    const agentChannelId = store.get(agentChannelIdAtom)
    if (!agentChannelId) {
      toast.error('请先在设置中配置 Agent 渠道')
      return
    }

    setMigrating(true)
    try {
      const workspaces = store.get(agentWorkspacesAtom)
      const defaultWorkspaceId = workspaces[0]?.id ?? null

      // 1. 创建 Agent 会话
      const session = await window.electronAPI.createAgentSession(
        undefined,
        agentChannelId,
        defaultWorkspaceId ?? undefined,
        store.get(agentModelIdAtom) || undefined,
      )

      // 2. 迁移 Chat 对话记录到新 Agent 会话
      await window.electronAPI.migrateChatToAgent(conversationId, session.id)

      // 3. 刷新会话列表
      const sessions = await window.electronAPI.listActiveAgentSessions()
      store.set(agentSessionsAtom, sessions)

      // 4. 切换到默认工作区
      if (defaultWorkspaceId) {
        store.set(currentAgentWorkspaceIdAtom, defaultWorkspaceId)
        window.electronAPI.updateSettings({
          agentWorkspaceId: defaultWorkspaceId,
        }).catch(console.error)
      }

      // 5. 切换到 Agent 模式
      store.set(appModeAtom, 'agent')
      store.set(activeViewAtom, 'conversations')

      // 6. 打开 Agent 会话 Tab 并激活
      const sessionTitle = session.title ?? '新 Agent 会话'
      const tabs = store.get(tabsAtom)
      const result = openTab(tabs, {
        type: 'agent',
        sessionId: session.id,
        title: sessionTitle,
      })
      store.set(tabsAtom, result.tabs)
      store.set(activeTabIdAtom, result.activeTabId)
      store.set(currentAgentSessionIdAtom, session.id)

      // 7. 通知用户
      toast.success('已切换到 Agent 模式', {
        description: '对话历史已迁移到新的 Agent 会话',
      })
    } catch (error) {
      console.error('[MigrateToAgentButton] 迁移失败:', error)
      toast.error('切换到 Agent 模式失败')
    } finally {
      setMigrating(false)
    }
  }

  return (
    <>
      <MessageAction
        tooltip={migrating ? '切换中...' : '切换到 Agent 模式'}
        onClick={handleRequestMigrate}
        disabled={migrating}
      >
        {migrating ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Bot className="size-3.5" />
        )}
      </MessageAction>

      {/* 复用 alert-dialog 原语：开着内置浏览器时自动避让原生视图 */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{MIGRATE_TO_AGENT_CONFIRM_COPY.title}</AlertDialogTitle>
            <AlertDialogDescription>{MIGRATE_TO_AGENT_CONFIRM_COPY.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{MIGRATE_TO_AGENT_CONFIRM_COPY.cancelLabel}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { void handleMigrate() }}>
              {MIGRATE_TO_AGENT_CONFIRM_COPY.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
