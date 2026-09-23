/**
 * 主入口——不含 Electron 耦合。
 *
 * `PiUtilityAdapter`/`createPiRuntimePlugin` 故意不放在这里：它们的依赖链
 * （经 `agent-runtime-client.ts`）静态 import 了 `electron` 的
 * `MessageChannelMain`/`utilityProcess`。ESM 的具名重导出会让整个来源模块
 * 参与模块图求值——哪怕消费方只解构一个不相关的符号，`electron` 的顶层
 * import 也会被执行。这在纯 Node/Bun 环境（如 bun test）里会直接抛出
 * "Export named 'MessageChannelMain' not found"。electron 耦合的部分单独放在
 * `@canopy/runtime-pi/utility-runtime` 子路径，只由真正跑在 Electron 主进程里
 * 的 `agent-service.ts` 引用。
 */
export { PiAgentAdapter, type PiAgentQueryOptions } from './pi-agent-adapter'

export {
  isValidImageBytes,
  isValidImageContent,
  sanitizeToolResultImageContent,
  sanitizePiMessageImageContent,
} from './image-content-validation'

export {
  resolvePiReasoningCapability,
  resolvePiImageInputCapability,
  resolvePiVisionRelayRoute,
  listCodexModels,
  listXaiModels,
  buildCodexModel,
} from './pi-model-registry'

export { DEFAULT_BASH_TIMEOUT_SECONDS } from './pi-bash-timeout'

export {
  closePiRequestProxyDispatcher,
  createPiRequestProxyDispatcher,
  installPiRequestProxyFetch,
  runWithPiRequestProxy,
  runWithPiRequestProxyScope,
  getPiRequestProxyDispatcher,
} from './pi-request-proxy'

export { refreshXaiOAuthCredentialsSerial, rememberXaiOAuthCredentials } from './xai-oauth-credentials'

export {
  runWithOAuthProxyScope,
  buildOAuthNoProxy,
  readNoProxyEnvironment,
  type PiOAuthNetworkDeps,
} from './oauth-proxy-scope'

export {
  loginCodexOAuth,
  cancelCodexOAuthLogin,
  refreshCodexOAuth,
  type CodexLoginOptions,
  type CodexLoginCallbacks,
} from './codex-oauth-service'

export {
  loginXaiOAuth,
  cancelXaiOAuthLogin,
  refreshXaiOAuth,
  type XaiLoginCallbacks,
} from './xai-oauth-service'

export {
  generateCodexTitle,
  resolveCodexTitleConnectionSettings,
  extractCodexResponseText,
  completeCodexTitleRequest,
  type CodexTitleGenerationInput,
  type CodexTitleRuntime,
  type CodexTitleRequestEnvironment,
  type CodexTitleConnectionSettings,
} from './pi-codex-title-generator'

export { combineAppInstructionFiles } from './pi-resource-loader-overrides'

export {
  getPiAssistantErrorDetails,
  hasPiAssistantTextContent,
  stripPiAssistantError,
} from './pi-message-adapter'

export { adaptToolsForPi } from './tool-adapter'
export { warmupPiRuntimeModule } from './warmup'

export {
  configureAgentSessionFork,
  forkAgentSession,
  rewindPiAgentSession,
  type AgentSessionForkDeps,
  type AgentSessionForkPathResolver,
  type AgentSessionForkWorkspaceLookup,
} from './agent-session-fork'

export { copyForkWorkspaceFiles, shouldCopyForkWorkspacePath, type ForkWorkspaceCopyResult } from './agent-fork-workspace-copy'
