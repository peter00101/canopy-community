/**
 * Agent 会话管理器（Electron 侧薄封装）
 *
 * 索引 / 分页 / CRUD 已下沉到 @canopy/kernel 的 agent-session-store.ts（Runtime 无关），
 * fork / rewind 已下沉到 @canopy/runtime-pi 的 agent-session-fork.ts（Pi SessionManager
 * 专属）。本文件只负责：
 * 1. 模块加载时用真实的 config-paths / agent-workspace-manager / settings-service
 *    装配依赖，调用一次 configureAgentSessionStore / configureAgentSessionFork；
 * 2. 重导出两个包的全部公开 API，保持全仓库现有 `from './agent-session-manager'`
 *    的 16 个引用点零改动；
 * 3. 实现两个跨越 kernel/runtime-pi 边界之外的业务组合：
 *    - `deleteAgentSession`：包一层 `deleteAgentSessionCore` + Nano Banana 生图历史清理
 *    - `migrateChatToAgentSession`：Chat 对话 → Agent 会话的一次性迁移工具函数
 */

import { randomUUID } from 'node:crypto'
import {
  configureAgentSessionStore,
  deleteAgentSessionCore,
  appendAgentMessage,
} from '@canopy/kernel'
import { configureAgentSessionFork } from '@canopy/runtime-pi'
import type { AgentMessage } from '@canopy/shared'
import {
  getAgentSessionsIndexPath,
  getAgentSessionSkillActivationsPath,
  getAgentSessionsDir,
  getAgentSessionMessagesPath,
  getAgentSessionWorkspacePath,
  getAgentWorkspacePath,
  getSdkConfigDir,
} from './config-paths'
import {
  getAgentWorkspace,
  getProjectFilesPath,
  listAgentWorkspaces,
} from './agent-workspace-manager'
import { getSettings } from './settings-service'
import { getConversationMessages } from './conversation-manager'
import { clearNanoBananaAgentHistory } from './chat-tools/nano-banana-mcp'
import { assertEnabledModelForChannel } from './agent-model-selection'

configureAgentSessionStore({
  paths: {
    getAgentSessionsIndexPath,
    getAgentSessionsDir,
    getAgentSessionMessagesPath,
    getAgentSessionSkillActivationsPath,
    getAgentWorkspacePath,
    getAgentSessionWorkspacePath,
    getSdkConfigDir,
  },
  workspaces: {
    getAgentWorkspace,
    getProjectFilesPath,
    listAgentWorkspaces,
  },
  getThinkingSettings: () => {
    const settings = getSettings()
    return {
      agentThinking: settings.agentThinking,
      agentEffort: settings.agentEffort,
      defaultOpenAIThinkingLevel: settings.defaultOpenAIThinkingLevel,
    }
  },
})

configureAgentSessionFork({
  paths: {
    getAgentSessionMessagesPath,
    getAgentSessionSkillActivationsPath,
    getSdkConfigDir,
  },
  workspaces: {
    getAgentWorkspace,
  },
  assertEnabledModelForChannel,
})

export * from '@canopy/kernel'
export { forkAgentSession, rewindPiAgentSession } from '@canopy/runtime-pi'

/**
 * 删除会话：核心 CRUD 交给 kernel，本文件只补上业务侧的 Nano Banana 生图历史清理副作用。
 */
export function deleteAgentSession(id: string): void {
  deleteAgentSessionCore(id)
  clearNanoBananaAgentHistory(id)
}

/**
 * 迁移 Chat 对话记录到 Agent 会话
 *
 * 读取 Chat 对话的消息，转换为 AgentMessage 格式，
 * 追加到目标 Agent 会话的 JSONL 文件中。
 *
 * 仅迁移 user 和 assistant 角色的消息文本内容，
 * 工具活动、推理、附件等 Chat 特有字段不迁移。
 */
export function migrateChatToAgentSession(conversationId: string, agentSessionId: string): void {
  const chatMessages = getConversationMessages(conversationId)

  if (chatMessages.length === 0) {
    console.log(`[Agent 会话] Chat 对话无消息，跳过迁移 (${conversationId})`)
    return
  }

  let count = 0
  for (const cm of chatMessages) {
    // 仅迁移 user 和 assistant 消息
    if (cm.role !== 'user' && cm.role !== 'assistant') continue
    if (!cm.content.trim()) continue

    const agentMsg: AgentMessage = {
      id: randomUUID(),
      role: cm.role,
      content: cm.content,
      createdAt: cm.createdAt,
      model: cm.role === 'assistant' ? cm.model : undefined,
    }

    appendAgentMessage(agentSessionId, agentMsg)
    count++
  }

  console.log(`[Agent 会话] 已迁移 ${count} 条消息到 Agent 会话 (${conversationId} → ${agentSessionId})`)
}
