import type {
  AgentExternalRunSource,
  AgentMessage,
  AgentSendInput,
  AgentStreamPayload,
  AgentWorkspace,
  Channel,
  FeishuSessionMirrorSettings,
  WorkspaceCapabilities,
} from '@canopy/shared'
import type { KernelToolDefinition } from '@canopy/kernel'

/** config-paths.ts 里贯穿飞书/钉钉/微信配置与附件保存的 10 个路径函数。 */
export interface ImBridgePathResolver {
  getFeishuConfigPath(): string
  getFeishuBotBindingsPath(botId: string): string
  getFeishuBotMetadataPath(botId: string): string
  getDingTalkConfigPath(): string
  getDingTalkBotBindingsPath(botId: string): string
  getWeChatConfigPath(): string
  getWeChatBindingsPath(): string
  getWeChatSyncPath(): string
  getAgentSessionWorkspacePath(workspaceSlug: string, sessionId: string): string
  resolveAgentSessionWorkspacePath(workspaceSlug: string, sessionId: string): string
}

/** settings-service.ts 的 getSettings() 里被 IM 桥接读取的窄字段切片。 */
export interface ImBridgeAppSettings {
  agentChannelId?: string
  agentWorkspaceId?: string
  agentModelId?: string
  feishuSessionMirror?: FeishuSessionMirrorSettings
}

/** agent-workspace-manager.ts 里被 IM 桥接使用的 4 个函数。 */
export interface ImBridgeWorkspaceLookup {
  getAgentWorkspace(id: string): AgentWorkspace | undefined
  getProjectFilesPath(workspaceSlug: string): string
  getWorkspaceCapabilities(workspaceSlug: string): WorkspaceCapabilities
  listAgentWorkspacesByUpdatedAt(): AgentWorkspace[]
}

/** channel-manager.ts 里经 bridge-model-utils.ts 这一窄口被使用的 2 个函数。 */
export interface ImBridgeChannelRegistry {
  listChannels(): Channel[]
  getChannelById(id: string): Channel | undefined
}

/**
 * agent-service.ts 的 Agent 运行能力——真正实现（`AgentOrchestrator`）留在
 * apps/electron，本包只依赖这个窄接口。`onAgentEvent` 对应原来的
 * `agentEventBus.on(handler): unsubscribe`。
 */
export interface ImBridgeAgentRunnerDeps {
  runAgentHeadless(
    input: AgentSendInput,
    callbacks: {
      onError: (error: string) => void
      onComplete: (messages?: AgentMessage[]) => void
      onTitleUpdated: (title: string) => void
      source?: AgentExternalRunSource
      originSessionId?: string
    },
    extensions?: { customTools?: KernelToolDefinition[] },
  ): Promise<void>
  stopAgent(sessionId: string): boolean
  isAgentSessionActive(sessionId: string): boolean
  onAgentEvent(handler: (sessionId: string, payload: AgentStreamPayload) => void): () => void
}

/**
 * 统一飞书原来的 `getMainWindow().webContents.send`（只发主窗口）与
 * 钉钉/微信原来的 `BrowserWindow.getAllWindows()`（广播全部窗口）——
 * 两种语义不同，保留两个方法，行为各自不变。
 */
export interface ImBridgeWindowBroadcast {
  sendToMainWindow(channel: string, payload?: unknown): void
  broadcastToAllWindows(channel: string, payload?: unknown): void
}

/** 与 `electron.safeStorage` 同形状，供飞书/钉钉/微信各自的 encrypt/decrypt 包装函数使用。 */
export interface ImBridgeSafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** bridge-registry.ts 的自愈守护依赖的 `electron.powerMonitor` 窄切片。 */
export interface ImBridgePowerMonitor {
  on(event: 'resume' | 'unlock-screen', handler: () => void): void
  off(event: 'resume' | 'unlock-screen', handler: () => void): void
}

export interface ImBridgeBusinessDeps {
  paths: ImBridgePathResolver
  getSettings(): ImBridgeAppSettings
  workspaces: ImBridgeWorkspaceLookup
  channels: ImBridgeChannelRegistry
  agentRunner: ImBridgeAgentRunnerDeps
  window: ImBridgeWindowBroadcast
  safeStorage: ImBridgeSafeStorage
  powerMonitor: ImBridgePowerMonitor
}

let deps: ImBridgeBusinessDeps | null = null

/** 由调用方（electron 侧装配点）在应用启动时调用一次；未调用前使用任何导出函数都会抛错。 */
export function configureImBridgeBusiness(nextDeps: ImBridgeBusinessDeps): void {
  deps = nextDeps
}

export function requireImBridgeBusinessDeps(): ImBridgeBusinessDeps {
  if (!deps) {
    throw new Error('[IM 桥接] configureImBridgeBusiness 尚未调用')
  }
  return deps
}
