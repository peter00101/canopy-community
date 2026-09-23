import { inferReasoningTransport, normalizeReasoningCapabilityLevel, normalizeReasoningLevel, resolveReasoningProfile, type AgentEffort, type AgentSessionMeta, type AgentThinkingLevel, type ProviderType, type ReasoningCapability, type ThinkingConfig } from '@canopy/shared'

/** 与 apps/electron 的 `AppSettings.agentThinking`/`agentEffort` 字段形状一致的窄接口；
 * kernel 不依赖 electron 的 AppSettings 类型本身，调用方（agent-session-store.ts）
 * 传入其真实 settings 对象即可结构兼容。 */
interface ThinkingSettings {
  agentThinking?: ThinkingConfig
  agentEffort?: AgentEffort
}
type ThinkingSessionMeta = Pick<AgentSessionMeta, 'reasoningLevel' | 'openAIThinkingLevel'>

export function resolvePiThinkingLevel(
  settings: ThinkingSettings,
  sessionMeta: ThinkingSessionMeta | undefined,
  provider: ProviderType | undefined,
  modelId?: string,
  capability?: ReasoningCapability,
): AgentThinkingLevel {
  const reasoningProfile = resolveReasoningProfile({
    modelId,
    transport: inferReasoningTransport(provider),
  })
  if (reasoningProfile) {
    const persistedLevel = sessionMeta?.reasoningLevel ?? sessionMeta?.openAIThinkingLevel
    const configuredLevel = settings.agentThinking?.type === 'disabled' ? 'off' : settings.agentEffort
    return normalizeReasoningLevel(reasoningProfile, persistedLevel ?? configuredLevel)!
  }
  const configuredLevel = settings.agentThinking?.type === 'disabled' ? 'off' : settings.agentEffort
  if (capability) {
    const persistedLevel = sessionMeta?.reasoningLevel ?? sessionMeta?.openAIThinkingLevel
    return normalizeReasoningCapabilityLevel(capability, persistedLevel ?? configuredLevel)!
  }
  if (settings.agentThinking?.type === 'disabled') return 'off'
  if (settings.agentEffort === 'max') return 'xhigh'
  // 无持久化配置的旧用户也采用新的默认值；显式 disabled 仍优先关闭。
  return settings.agentEffort ?? 'high'
}
