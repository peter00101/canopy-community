import type { AgentExternalRunSource, AgentMessage, AgentSendInput } from '@canopy/shared'

/**
 * 自动化调度依赖的 Agent 运行能力——真正实现（`AgentOrchestrator`）留在
 * apps/electron 的 agent-service.ts（840 行，直接 import electron 的
 * BrowserWindow），本包只依赖这个窄接口。
 */
export interface AutomationAgentRunnerDeps {
  runAgentHeadless(
    input: AgentSendInput,
    callbacks: {
      onError: (error: string) => void
      onComplete: (messages?: AgentMessage[]) => void
      onTitleUpdated: (title: string) => void
      source?: AgentExternalRunSource
      originSessionId?: string
    },
  ): Promise<void>
  isAgentSessionActive(sessionId: string): boolean
}

/** 定时任务完成通知投递——当前唯一实现是飞书卡片发送，接口注入避免直接依赖 IM 桥接实现。 */
export interface AutomationNotificationSenderDeps {
  sendCardToChat(botId: string, chatId: string, card: Record<string, unknown>): Promise<void>
}

export interface AutomationBusinessDeps {
  getAutomationsPath(): string
  agentRunner: AutomationAgentRunnerDeps
  notificationSender: AutomationNotificationSenderDeps
  broadcastAutomationChanged(): void
}

let deps: AutomationBusinessDeps | null = null

/** 由调用方（electron 侧装配点）在应用启动时调用一次；未调用前使用任何导出函数都会抛错。 */
export function configureAutomationBusiness(nextDeps: AutomationBusinessDeps): void {
  deps = nextDeps
}

export function requireAutomationBusinessDeps(): AutomationBusinessDeps {
  if (!deps) {
    throw new Error('[定时任务] configureAutomationBusiness 尚未调用')
  }
  return deps
}
