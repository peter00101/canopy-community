/**
 * Shared utility functions for canopy
 */

// Placeholder - will be expanded as needed
export function noop(): void {
  // no-op
}

export {
  createAgentRuntimeRequest,
  createAgentRuntimeResponse,
  isAgentRuntimeEnvelope,
  isAgentRuntimeError,
  serializeAgentRuntimeError,
} from './agent-runtime'

export { formatRetiredModelMessage, isRetiredModelId } from './retired-models'

export { diffCapabilities } from './capabilities-diff'
export type { CapabilityChange } from './capabilities-diff'
export {
  DEFAULT_CONTEXT_WINDOW,
  ONE_MILLION_CONTEXT_WINDOW,
  CODEX_GPT_54_55_CONTEXT_WINDOW,
  CODEX_GPT_54_MINI_CONTEXT_WINDOW,
  CODEX_GPT_56_CONTEXT_WINDOW,
  CODEX_GPT_6_ASTRA_CONTEXT_WINDOW,
  inferCodexAlignedGPT5ContextWindow,
  supports1MContext,
  inferContextWindow,
} from './context-window'
export { calculateContextUsageRatio } from './context-usage'
export {
  getGeminiModelCapability,
  normalizeGeminiThinkingLevel,
  type GeminiModelCapability,
  type GeminiThinkingLevel,
} from './gemini-model-capabilities'
export {
  PI_AUTO_COMPACTION_THRESHOLD_RATIO,
  PI_AUTO_COMPACTION_MIN_RATIO,
  PI_AUTO_COMPACTION_MAX_RATIO,
  normalizePiAutoCompactionRatio,
  calculatePiAutoCompactionReserveTokens,
  calculatePiAutoCompactionThresholdTokens,
} from './pi-compaction'
export {
  inferMcpTransportType,
  normalizeMcpTransportType,
} from './mcp-transport'
export { removeMcpServerFromConfig } from './mcp-config'
export {
  THINKING_SIGNATURE_ERROR_CODE,
  THINKING_SIGNATURE_ERROR_TITLE,
  THINKING_SIGNATURE_ERROR_MESSAGE,
  isThinkingSignatureError,
  formatThinkingSignatureError,
  normalizeThinkingSignatureError,
} from './thinking-signature-error'
export { normalizePathForCompare } from './normalize-path'
export {
  UTILITY_PROCESS_START_CANCELLED_CODE,
  UTILITY_PROCESS_START_RETRY_DELAYS_MS,
  isRetryableUtilityProcessStartupError,
  isUtilityProcessStartupCancelledError,
  startUtilityProcessWithRetry,
} from './utility-process-startup'
export {
  MAX_NORMALIZED_SEARCH_QUERY_LENGTH,
  MAX_SEARCH_QUERY_SOURCE_LENGTH,
  findBestSearchMatch,
  findBestSearchMatchInNormalized,
  normalizeSearchText,
  createSearchSnippet,
  insertTopSearchResult,
  type SearchMatch,
  type SearchMatchKind,
  type NormalizedSearchText,
  type SearchResultRank,
  type SearchSnippet,
} from './search-matching'
export {
  AUTOMATION_OCCURRENCE_SAMPLES_PER_DAY,
  getAutomationOccurrencesByDay,
} from './automation-schedule'
export type {
  AutomationOccurrenceDay,
  AutomationScheduleFields,
} from './automation-schedule'
export {
  getSDKCompactStatus,
  isPersistableSDKSystemMessage,
  type SDKCompactStatus,
} from './agent-system-message'
export {
  stripInvisibleCharacters,
  sanitizeChannelModels,
} from './sanitize-model-text'
export {
  getSkillSlugFromEntryPath,
  createSkillActivationFromPath,
  mergeSkillActivations,
  collectSuccessfulSkillReadActivations,
  collectSkillActivations,
} from './skill-usage'
