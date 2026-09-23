/**
 * Pi 模型注册与渠道兼容层。
 *
 * Pi SDK 需要把 Canopy 渠道临时注册成 runtime provider；这里集中处理
 * ProviderType 到 Pi API 协议、baseUrl、认证头和模型 catalog 默认值的映射。
 */

import {
  CODEX_GPT_54_55_CONTEXT_WINDOW,
  CODEX_GPT_54_MINI_CONTEXT_WINDOW,
  CODEX_GPT_56_CONTEXT_WINDOW,
  CODEX_GPT_6_ASTRA_CONTEXT_WINDOW,
  extractZhipuCodingTeamApiToken,
  formatRetiredModelMessage,
  inferContextWindow,
  isRetiredModelId,
  inferCodexAlignedGPT5ContextWindow,
  getGeminiModelCapability,
  resolveReasoningCapability,
  resolveReasoningProfile,
  type CodexOAuthCredentials,
  type XaiOAuthCredentials,
  type ReasoningCapability,
  type ReasoningTransport,
  type ProviderType,
} from '@canopy/shared'
import {
  getAppUserAgent,
  normalizeAnthropicBaseUrlForSdk,
  normalizeOpenAIBaseUrlForSdk,
  normalizeVersionedAnthropicBaseUrl,
  resolveAnthropicMessagesUrl,
} from '@canopy/core'
import type { Api, KnownProvider, Model } from '@earendil-works/pi-ai/compat'
import type { PiAgentQueryOptions } from './pi-agent-adapter'
import { rememberXaiOAuthCredentials, refreshXaiOAuthCredentialsSerial } from './xai-oauth-credentials'
import { supportsPiDeveloperRole } from './pi-provider-compat'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')
type PiAiCompat = typeof import('@earendil-works/pi-ai/compat')
type PiCatalogModel = Model<Api>
type PiModelCost = PiCatalogModel['cost']
type PiRequestHeaders = Record<string, string>
type PiCatalogModelPatch = Pick<PiCatalogModel, 'id'> & Partial<PiCatalogModel>

export interface PiModelDefaults {
  api: Api
  reasoning: boolean
  thinkingLevelMap?: PiCatalogModel['thinkingLevelMap']
  compat?: PiCatalogModel['compat']
  input: PiCatalogModel['input']
  cost: PiModelCost
  contextWindow: number
  maxTokens: number
}

const ZERO_MODEL_COST: PiModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
export const DEFAULT_CONTEXT_WINDOW = 200_000
const DEFAULT_MAX_TOKENS = 64_000
const VOLCENGINE_GLM_MAX_TOKENS = 128_000
/** GLM-5.3 系列（含 Flash / FlashX）均支持 128K 最大输出。 */
const GLM_53_FAMILY_MAX_TOKENS = 131_072
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api'
const CODEX_MAX_TOKENS = 128_000
/**
 * 官方已下线的模型（名单真源在 @canopy/shared 的 retired-models，所有渠道共用；上游 #2061 只处理了 Codex）。
 * pi-ai 0.85.1 的 openai-codex 目录仍带着 gpt-5.3-codex-spark（且排第一），所以 Codex 目录、运行时目录都要过滤；
 * 其他渠道在 buildModel 入口统一拦截，用户渠道配置里的存量条目由 channel-manager 读取时清掉。
 */
function isSupportedCodexModel(model: Pick<PiCatalogModel, 'id'>): boolean {
  return !isRetiredModelId(model.id)
}

/**
 * 将 Codex 已标记的 GPT-5.x 上下文窗口外推到同名第三方模型。
 *
 * reasoning 档位由 shared reasoning profile 管理；未被 Codex 标记的 Pro/Nano SKU
 * 仍保留 catalog 的上下文窗口。
 */
export function getCodexAlignedGPT5Capabilities(modelId: string | undefined): Pick<PiModelDefaults, 'contextWindow'> | undefined {
  const contextWindow = inferCodexAlignedGPT5ContextWindow(modelId)
  if (contextWindow === undefined) return undefined
  return { contextWindow }
}

function toReasoningTransport(api: Api): ReasoningTransport {
  switch (api) {
    case 'anthropic-messages':
      return 'anthropic-messages'
    case 'openai-completions':
      return 'openai-completions'
    case 'openai-responses':
      return 'openai-responses'
    default:
      return 'other'
  }
}

/** 将共享 reasoning profile 编译为 Pi SDK 的 model compatibility patch。 */
function compilePiReasoningCapabilities(
  api: Api,
  modelId: string | undefined,
): Pick<PiModelDefaults, 'compat' | 'thinkingLevelMap'> | undefined {
  const transport = toReasoningTransport(api)
  const profile = resolveReasoningProfile({ modelId, transport })
  const encoding = profile?.encodings[transport]
  if (!encoding) return undefined

  const thinkingLevelMap = encoding.effortMap as PiCatalogModel['thinkingLevelMap']
  switch (encoding.kind) {
    case 'adaptive-effort':
      return {
        compat: { forceAdaptiveThinking: true },
        thinkingLevelMap,
      }
    // DeepSeek V4's Anthropic-compatible protocol is not adaptive thinking.
    // Pi's generic stream emits a legacy budget; the runtime request extension
    // replaces it with `thinking: enabled` + `output_config.effort`.
    case 'deepseek-output-effort':
      return { thinkingLevelMap }
    case 'openai-reasoning-effort':
      return {
        compat: { supportsReasoningEffort: true },
        thinkingLevelMap,
      }
    case 'zai-thinking-effort':
      return {
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          thinkingFormat: 'zai',
          zaiToolStream: true,
        },
        thinkingLevelMap,
      }
  }
}

/**
 * Canopy re-registers every non-OAuth channel as an ephemeral Pi provider. Preserve
 * only this protocol-safe catalog flag: current Claude models require adaptive
 * thinking, while copying the complete catalog compat object could leak unrelated
 * tool/sampling behaviour across provider protocols.
 *
 * Fable 5.1 is newer than the bundled Pi catalog entry (`claude-fable-5`), so its
 * exact ID lookup can legitimately miss. Its official Anthropic Messages endpoint
 * nevertheless rejects legacy `thinking: { type: 'enabled' }`; recognize the whole
 * Fable 5 family here to keep the request on Pi's adaptive + effort path.
 */
export function shouldForcePiAdaptiveThinking(
  api: Api,
  catalogModel: { api: Api, compat?: unknown } | undefined,
  modelId?: string,
): boolean {
  if (api !== 'anthropic-messages') return false
  // 我方 #1755 分叉：目录条目本身也必须是 anthropic 协议，避免把 anthropic 的
  // adaptive thinking 行为泄漏到别的协议。上游 v0.19.26（#1957/#1973 接 Fable 5.1）
  // 去掉了这层检查，本轮不采——Fable 5.1 的目录条目本就是 anthropic，双侧检查不影响它。
  if (catalogModel && catalogModel.api !== 'anthropic-messages') return false
  if ((catalogModel?.compat as { forceAdaptiveThinking?: unknown } | undefined)?.forceAdaptiveThinking === true) {
    return true
  }
  const claudeFamilyKey = modelId ? getClaudeFamilyKey(modelId, true) : undefined
  return claudeFamilyKey === 'fable-5' || claudeFamilyKey?.startsWith('fable-5-') === true
}

const CODEX_56_THINKING_LEVEL_MAP = compilePiReasoningCapabilities('openai-responses', 'gpt-5.6')?.thinkingLevelMap
/** GPT-6 Astra 档位表来自 shared 的 astra profile（无 off / none，见 reasoning-profile.ts）。 */
const CODEX_6_ASTRA_THINKING_LEVEL_MAP = compilePiReasoningCapabilities('openai-responses', 'gpt-6-astra')?.thinkingLevelMap

type CodexRuntimeCredential = CodexOAuthCredentials & {
  type: 'oauth'
  [key: string]: unknown
}

/** Pi 内置 Codex provider 所需的最小模型与 OAuth 输入。 */
export interface CodexModelInput {
  model?: string
  codexOAuthCredentials?: CodexOAuthCredentials
  onCodexOAuthCredentialsRefreshed?: (credentials: CodexOAuthCredentials) => void | Promise<void>
}

/** Pi 内置 xAI provider 所需的最小模型与 OAuth 输入。 */
export interface XaiModelInput {
  channelId?: string
  model?: string
  xaiOAuthCredentials?: XaiOAuthCredentials
  onXaiOAuthCredentialsRefreshed?: (credentials: XaiOAuthCredentials) => void | Promise<void>
}

function createCodexRuntimeCredentialStore(
  initial: CodexOAuthCredentials,
  onRefreshed?: PiAgentQueryOptions['onCodexOAuthCredentialsRefreshed'],
) {
  let credential: CodexRuntimeCredential | undefined = { type: 'oauth', ...initial }

  return {
    async read(providerId: string): Promise<CodexRuntimeCredential | undefined> {
      return providerId === 'openai-codex' ? credential : undefined
    },
    async list(): Promise<readonly { providerId: string; type: 'oauth' }[]> {
      return credential ? [{ providerId: 'openai-codex', type: 'oauth' }] : []
    },
    async modify(
      providerId: string,
      fn: (current: CodexRuntimeCredential | undefined) => Promise<CodexRuntimeCredential | undefined>,
    ): Promise<CodexRuntimeCredential | undefined> {
      if (providerId !== 'openai-codex') return undefined
      const previous = credential
      credential = await fn(credential)

      if (credential && (
        previous?.access !== credential.access
        || previous?.refresh !== credential.refresh
        || previous?.expires !== credential.expires
        || previous?.accountId !== credential.accountId
      )) {
        try {
          await onRefreshed?.(credential)
        } catch (error) {
          console.warn('[Pi Codex OAuth] 刷新后的凭据回写失败，将在下次执行前重试:', error)
        }
      }
      return credential
    },
    async delete(providerId: string): Promise<void> {
      if (providerId === 'openai-codex') credential = undefined
    },
  }
}

type XaiRuntimeCredential = XaiOAuthCredentials & {
  type: 'oauth'
  [key: string]: unknown
}

function createXaiRuntimeCredentialStore(
  channelId: string,
  initial: XaiOAuthCredentials,
  onRefreshed?: PiAgentQueryOptions['onXaiOAuthCredentialsRefreshed'],
) {
  let credential: XaiRuntimeCredential | undefined = { type: 'oauth', ...rememberXaiOAuthCredentials(channelId, initial) }

  return {
    async read(providerId: string): Promise<XaiRuntimeCredential | undefined> {
      return providerId === 'xai' ? credential : undefined
    },
    async list(): Promise<readonly { providerId: string; type: 'oauth' }[]> {
      return credential ? [{ providerId: 'xai', type: 'oauth' }] : []
    },
    async modify(
      providerId: string,
      fn: (current: XaiRuntimeCredential | undefined) => Promise<XaiRuntimeCredential | undefined>,
    ): Promise<XaiRuntimeCredential | undefined> {
      if (providerId !== 'xai' || !credential) return undefined
      const previous = credential
      const refreshed = await refreshXaiOAuthCredentialsSerial(
        channelId,
        credential,
        async (latest) => {
          const next = await fn({ type: 'oauth', ...latest })
          if (!next) throw new Error('Pi xAI OAuth 刷新未返回凭据')
          return { access: next.access, refresh: next.refresh, expires: next.expires }
        },
      )
      credential = { type: 'oauth', ...refreshed }
      if (
        previous.access !== credential.access
        || previous.refresh !== credential.refresh
        || previous.expires !== credential.expires
      ) {
        try {
          await onRefreshed?.(credential)
        } catch (error) {
          console.warn('[Pi xAI OAuth] 刷新后的凭据回写失败，将在下次执行前重试:', error)
        }
      }
      return credential
    },
    async delete(providerId: string): Promise<void> {
      if (providerId === 'xai') credential = undefined
    },
  }
}

/**
 * 官方明示支持原生图片输入、但 Pi 目录可能缺失的模型（目录里标了 image 的直接按目录走，不必登记）。
 *
 * ⚠️ 只能放**服务商官方文档写明支持**的模型。DeepSeek 官方文档（2026-09-21 复核
 * api-docs.deepseek.com/zh-cn/guides/vision 与 quick_start/pricing）：「仅 `deepseek-flash` 模型支持图片输入」，
 * OpenAI 兼容与 Anthropic 兼容端点都支持；旧名 `deepseek-v4-flash-vision-exp` 已下线、请求转由 V4.1 Flash 处理
 * （因此仍可收图）。Pi 0.86.1 目录与之一致：`deepseek-flash` 标 `["text","image"]`，vision-exp 条目已删。
 *
 * `deepseek-v4-flash` 同样转由 V4.1 Flash 处理，但官方只写了 `deepseek-flash` 支持图片，仍按不支持处理、走视觉助手兜底：
 * 上游 #1777 当年把它标成 supported 属误收（标错会让视觉助手不再兜底，发图直接 400），0.17.35 已剔除，别再加回来
 * （上游 v0.19.5 以「自家后端契约兜底」为由再收，那是上游自家后端的转换，我方用户直连 DeepSeek API 不适用，仍不采）。
 */
const NATIVE_IMAGE_INPUT_MODEL_IDS = new Set([
  'deepseek-v4-flash-vision-exp',
])

/** 判断模型是否已确认支持原生图片输入。 */
export function supportsPiNativeImageInput(modelId: string | undefined): boolean {
  const normalized = stripLegacyAgentSdkContextSuffix(modelId)?.trim().toLowerCase()
  return normalized !== undefined && NATIVE_IMAGE_INPUT_MODEL_IDS.has(normalized)
}

interface DerivedCatalogModel {
  /** 派生来源：同端点、同协议、同价的兄弟模型，必须真实存在于 Pi catalog */
  sourceModelId: string
  /** 相对来源条目的差异；其余字段（contextWindow / maxTokens / cost / compat / thinkingLevelMap）原样继承 */
  patch: Pick<PiCatalogModel, 'id' | 'name' | 'input'>
}

/**
 * 本渠道目录里缺失、需要从同厂商兄弟条目派生的模型。
 *
 * Pi 0.86.1 的 DeepSeek 目录只剩 `deepseek-flash`（V4.1 Flash）与 `deepseek-v4-pro`，旧名 `deepseek-v4-flash` /
 * `deepseek-v4-flash-vision-exp` 被删（Pi changelog #9423）。DeepSeek 官方定价页（2026-09-21 复核）：两个旧名仍可调用，
 * 请求由 V4.1 Flash 提供服务、按 Flash 价格计费——所以从 `deepseek-flash` 条目派生最贴近事实：同 1M 上下文、同 384K 输出、
 * 同价、同一套 DeepSeek 专属 compat；差别只在图片输入（口径见 NATIVE_IMAGE_INPUT_MODEL_IDS 注释）。
 *
 * 不派生会掉进「本渠道目录查不到」之后的跨厂商兜底：旧名在 opencode / qwen-token-plan / radius 等第三方目录里还有，
 * 会借用别家的价格与兼容设置；再查不到就落到 64K 输出、全 0 价格、默认「能看图」的兜底值。
 */
const DERIVED_CATALOG_MODELS: Record<string, DerivedCatalogModel> = {
  'deepseek-v4-flash-vision-exp': {
    sourceModelId: 'deepseek-flash',
    patch: {
      id: 'deepseek-v4-flash-vision-exp',
      name: 'DeepSeek V4 Flash Vision Exp',
      input: ['text', 'image'],
    },
  },
  'deepseek-v4-flash': {
    sourceModelId: 'deepseek-flash',
    patch: {
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      input: ['text'],
    },
  },
}

/** 取模型的派生来源；返回 undefined 表示该模型不走派生。 */
export function getDerivedCatalogSourceModelId(modelId: string | undefined): string | undefined {
  const normalized = stripLegacyAgentSdkContextSuffix(modelId)?.trim().toLowerCase()
  return normalized === undefined ? undefined : DERIVED_CATALOG_MODELS[normalized]?.sourceModelId
}

/** 用来源条目派生出目标模型的 catalog 条目；来源缺失时返回 undefined。 */
export function derivePiCatalogModel(
  modelId: string | undefined,
  sourceModel: PiCatalogModel | undefined,
): PiCatalogModel | undefined {
  const normalized = stripLegacyAgentSdkContextSuffix(modelId)?.trim().toLowerCase()
  const derived = normalized === undefined ? undefined : DERIVED_CATALOG_MODELS[normalized]
  if (!derived || !sourceModel) return undefined
  return { ...sourceModel, ...derived.patch, input: [...derived.patch.input] }
}

function applyPiModelCapabilityOverrides(model: PiCatalogModel | undefined): PiCatalogModel | undefined {
  if (!model) return model

  const normalizedId = model.id.trim().toLowerCase()
  // Pi 目录也会经 OpenCode Go 暴露走 Google 协议的 Gemini。判据是 API 协议契约，
  // 不是目录里的 provider 名——后者认不出这类转发渠道。
  const geminiCapability = model.api === 'google-generative-ai' ? getGeminiModelCapability(normalizedId) : undefined
  const requiresMinimalThinkingExclusion = geminiCapability && !geminiCapability.thinkingLevels.includes('minimal')
  const input: PiCatalogModel['input'] = supportsPiNativeImageInput(model.id) && !model.input.includes('image')
    ? [...model.input, 'image']
    : model.input
  const thinkingLevelMap = requiresMinimalThinkingExclusion
    ? { ...model.thinkingLevelMap, minimal: null }
    : model.thinkingLevelMap

  if (input === model.input && thinkingLevelMap === model.thinkingLevelMap) return model
  return { ...model, input, ...(thinkingLevelMap ? { thinkingLevelMap } : {}) }
}

const CODEX_MODEL_PATCHES: PiCatalogModelPatch[] = [
  {
    // Pi 0.84.4 / 0.85.0 目录均无 gpt-6，本条最初是整条自建（与 5.6 三款同法）。
    // Pi 0.85.1 起 openai-codex 目录原生带 gpt-6-astra（272K 窗口、cacheWrite 12.5 + 超 272K 分层价、
    // grammar tools / additional tools / tool search 三个 compat 能力位）：mergeCodexModels 对已有条目按字段
    // 覆盖，本条列出的字段仍以我方为准，未列出的 compat 沿用原生；整条保留是为了目录缺失时仍能自建。
    // 数值来源 OpenAI 模型页（2026-09-05）：最大输出 128K、$10 / $50 / 缓存 $1 每百万 token；
    // 费用按 5.6 三款的惯例填官方列表价（Codex OAuth 订阅制下仅作用量展示口径）。
    // 上下文窗口是例外：官方页标 1,050,000，但维护者 2026-09-08 定按 5.6 的 372K 走，
    // 理由见 CODEX_GPT_6_ASTRA_CONTEXT_WINDOW 注释（长文效果 + Codex 渠道速度）。
    id: 'gpt-6-astra',
    name: 'GPT-6 Astra',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: CODEX_BASE_URL,
    reasoning: true,
    thinkingLevelMap: CODEX_6_ASTRA_THINKING_LEVEL_MAP,
    input: ['text', 'image'],
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 0 },
    contextWindow: CODEX_GPT_6_ASTRA_CONTEXT_WINDOW,
    maxTokens: CODEX_MAX_TOKENS,
  },
  {
    id: 'gpt-5.4',
    contextWindow: CODEX_GPT_54_55_CONTEXT_WINDOW,
  },
  {
    id: 'gpt-5.4-mini',
    contextWindow: CODEX_GPT_54_MINI_CONTEXT_WINDOW,
  },
  {
    id: 'gpt-5.5',
    contextWindow: CODEX_GPT_54_55_CONTEXT_WINDOW,
  },
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: CODEX_BASE_URL,
    reasoning: true,
    thinkingLevelMap: CODEX_56_THINKING_LEVEL_MAP,
    input: ['text', 'image'],
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: CODEX_GPT_56_CONTEXT_WINDOW,
    maxTokens: CODEX_MAX_TOKENS,
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: CODEX_BASE_URL,
    reasoning: true,
    thinkingLevelMap: CODEX_56_THINKING_LEVEL_MAP,
    input: ['text', 'image'],
    cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
    contextWindow: CODEX_GPT_56_CONTEXT_WINDOW,
    maxTokens: CODEX_MAX_TOKENS,
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: CODEX_BASE_URL,
    reasoning: true,
    thinkingLevelMap: CODEX_56_THINKING_LEVEL_MAP,
    input: ['text', 'image'],
    cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: CODEX_GPT_56_CONTEXT_WINDOW,
    maxTokens: CODEX_MAX_TOKENS,
  },
]

let piAiCompatPromise: Promise<PiAiCompat> | undefined

function loadPiAiCompat(): Promise<PiAiCompat> {
  piAiCompatPromise ??= import('@earendil-works/pi-ai/compat')
  return piAiCompatPromise
}

function normalizePiApi(provider: ProviderType): Api {
  switch (provider) {
    case 'openai':
    case 'xai':
    case 'opencode-go-openai':
    case 'zhipu':
    case 'doubao':
    case 'qwen':
    case 'custom':
      return 'openai-completions'
    case 'openai-responses':
      return 'openai-responses'
    case 'google':
      return 'google-generative-ai'
    default:
      return 'anthropic-messages'
  }
}

/**
 * OpenCode Go 在同一渠道提供多种协议，必须以模型目录声明为准。
 * 未命中目录时保留历史 OpenAI Chat Completions 默认值。
 */
export function resolvePiApi(provider: ProviderType, catalogApi?: Api): Api {
  if (provider === 'opencode-go-openai' && catalogApi) return catalogApi
  return normalizePiApi(provider)
}

function candidatePiProviders(provider: ProviderType): KnownProvider[] {
  switch (provider) {
    case 'anthropic':
      return ['anthropic']
    case 'openai':
    case 'openai-responses':
      return ['openai']
    case 'xai':
      return ['xai']
    case 'deepseek':
      return ['deepseek']
    case 'google':
      return ['google']
    case 'kimi-api':
      return ['moonshotai-cn', 'moonshotai']
    case 'kimi-coding':
      return ['kimi-coding', 'moonshotai-cn', 'moonshotai']
    case 'opencode-go-openai':
      return ['opencode-go']
    case 'zhipu':
      return ['zai']
    case 'zhipu-coding':
    // 团队版与个人版走同一套 Coding Plan 目录（此前落到 default 空表，拿不到目录里的上下文窗口 / 费用元数据）。
    case 'zhipu-coding-team':
      return ['zai-coding-cn', 'zai']
    case 'minimax':
      return ['minimax', 'minimax-cn']
    case 'xiaomi':
      return ['xiaomi']
    case 'xiaomi-token-plan':
      return ['xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp', 'xiaomi-token-plan-ams', 'xiaomi']
    default:
      return []
  }
}

function findCatalogModelById(models: readonly PiCatalogModel[], modelId: string): PiCatalogModel | undefined {
  const normalized = modelId.toLowerCase()
  // ID 是渠道实际发送到上游的稳定标识；同名展示名称只能在没有 ID 命中时兜底。
  return applyPiModelCapabilityOverrides(
    models.find((model) => model.id.toLowerCase() === normalized)
      ?? models.find((model) => model.name.toLowerCase() === normalized),
  )
}

/**
 * Extract an unambiguous Claude family/version key from common provider aliases.
 *
 * Catalogs vary between `claude-opus-4-6`, `Claude Opus 4.6`, and provider-scoped
 * forms such as `anthropic.claude-opus-4-6-v1`. The fallback intentionally requires
 * a family plus full major/minor version. Major-only matching is only allowed for
 * Fable, catalog entries, or an explicit `-promo` alias.
 */
function getClaudeFamilyKey(modelRef: string, allowMajorOnly = false): string | undefined {
  const normalized = modelRef.toLowerCase()
  const familyFirst = normalized.match(/claude[\s._:/-]+(opus|sonnet|haiku|fable)[\s._:/-]+(\d+)(?:[\s._:/-]+(\d+))?/)
  const versionFirst = normalized.match(/claude[\s._:/-]+(\d+)(?:[\s._:/-]+(\d+))?[\s._:/-]+(opus|sonnet|haiku)/)
  const family = familyFirst?.[1] ?? versionFirst?.[3]
  const major = familyFirst?.[2] ?? versionFirst?.[1]
  const minor = familyFirst?.[3] ?? versionFirst?.[2]
  const isPromoAlias = /[\s._:/-]promo$/.test(normalized)
  if (!family || !major || (!minor && family !== 'fable' && !allowMajorOnly && !isPromoAlias)) return undefined
  return `${family}-${major}${minor ? `-${minor}` : ''}`
}

function findClaudeCatalogModel(models: readonly PiCatalogModel[], modelId: string): PiCatalogModel | undefined {
  const familyKey = getClaudeFamilyKey(modelId)
  if (!familyKey) return undefined
  const catalogModel = models.find((model) =>
    getClaudeFamilyKey(model.id, true) === familyKey || getClaudeFamilyKey(model.name, true) === familyKey)
  if (catalogModel) return catalogModel

  // Fable 5.x models can precede the catalog's major-version entry. Reuse only
  // the matching Fable major family; other Claude families require an exact
  // major/minor match to avoid inheriting the wrong thinking or protocol flags.
  const fableMajorKey = familyKey.match(/^fable-(\d+)-\d+$/)?.[0].replace(/-\d+$/, '')
  if (!fableMajorKey) return undefined
  return models.find((model) =>
    getClaudeFamilyKey(model.id, true) === fableMajorKey || getClaudeFamilyKey(model.name, true) === fableMajorKey)
}

async function getCatalogModels(provider: KnownProvider): Promise<readonly PiCatalogModel[]> {
  try {
    const { getModels } = await loadPiAiCompat()
    return getModels(provider as Parameters<typeof getModels>[0])
  } catch {
    return []
  }
}

async function findPiCatalogModel(provider: ProviderType, modelId: string): Promise<PiCatalogModel | undefined> {
  if (provider === 'openai-codex') {
    return findCatalogModelById(await getCodexCatalogModels(), modelId)
  }
  if (provider === 'xai') {
    return findCatalogModelById(await getXaiCatalogModels(), modelId)
  }

  const preferredProviders = candidatePiProviders(provider)
  const { getProviders } = await loadPiAiCompat()
  const checked = new Set(preferredProviders)
  const fallbackProviders = getProviders().filter((candidate) => !checked.has(candidate))

  // The configured provider owns both exact and safe Claude-family matching.
  for (const candidate of preferredProviders) {
    const model = findCatalogModelById(await getCatalogModels(candidate), modelId)
    if (model) return model
  }

  // 本渠道目录里没有、但在派生表里（如 Pi 0.86 删掉的 DeepSeek 旧名）：从同厂商来源条目派生，
  // 优先于下面的跨厂商兜底——别家目录的价格与兼容设置不属于本渠道。本渠道目录若原生带该条目，上面已直接返回。
  // 来源本身不在派生表里，递归至多一层。
  const derivedSourceId = getDerivedCatalogSourceModelId(modelId)
  if (derivedSourceId) {
    const derived = derivePiCatalogModel(modelId, await findPiCatalogModel(provider, derivedSourceId))
    if (derived) return derived
  }

  const claudeFamilyKey = getClaudeFamilyKey(modelId)
  if (claudeFamilyKey) {
    for (const candidate of preferredProviders) {
      const model = findClaudeCatalogModel(await getCatalogModels(candidate), modelId)
      if (model) return model
    }
  }

  // Generic/custom channels can still match a provider-scoped catalog ID exactly.
  for (const candidate of fallbackProviders) {
    const model = findCatalogModelById(await getCatalogModels(candidate), modelId)
    if (model) return model
  }

  // Only relax aliases after every exact lookup has failed.
  if (claudeFamilyKey) {
    for (const candidate of fallbackProviders) {
      const model = findClaudeCatalogModel(await getCatalogModels(candidate), modelId)
      if (model) return model
    }
  }
  return undefined
}

/**
 * 解析模型图片输入能力。未知模型保持 unknown，由调用方决定是否保守拒绝。
 * 视觉助手等会产生数据外发的功能必须仅接受 confirmed supported。
 */
export async function resolvePiImageInputCapability(
  provider: ProviderType,
  modelId: string | undefined,
): Promise<'supported' | 'unsupported' | 'unknown'> {
  const resolvedModelId = stripLegacyAgentSdkContextSuffix(modelId)
  if (!resolvedModelId) return 'unknown'
  // 实验变体尚未进入 Pi catalog，不能因目录缺失退回 unknown。
  if (supportsPiNativeImageInput(resolvedModelId)) return 'supported'
  const catalogModel = await findPiCatalogModel(provider, resolvedModelId)
  if (!catalogModel) return 'unknown'
  return catalogModel.input.includes('image') ? 'supported' : 'unsupported'
}

/**
 * Vision Relay 的实际请求路由。
 *
 * OpenCode Go 的同一渠道同时提供 OpenAI 和 Anthropic Messages 模型；因此必须以
 * Pi catalog 中该模型声明的 API 与 Base URL 为准，不能只按渠道类型固定走 OpenAI。
 */
export interface PiVisionRelayRoute {
  adapterProvider: ProviderType
  baseUrl?: string
}

export async function resolvePiVisionRelayRoute(
  provider: ProviderType,
  modelId: string | undefined,
): Promise<PiVisionRelayRoute | undefined> {
  const resolvedModelId = stripLegacyAgentSdkContextSuffix(modelId)
  if (!resolvedModelId) return undefined
  // DeepSeek Flash 的实验视觉模型尚未进入 Pi catalog；其渠道协议无需 catalog 分流。
  if (provider !== 'opencode-go-openai' && supportsPiNativeImageInput(resolvedModelId)) {
    return { adapterProvider: provider }
  }

  const catalogModel = await findPiCatalogModel(provider, resolvedModelId)
  if (!catalogModel?.input.includes('image')) return undefined

  if (provider !== 'opencode-go-openai') {
    return { adapterProvider: provider }
  }

  switch (catalogModel.api) {
    case 'anthropic-messages':
      return {
        // Anthropic-compatible adapter 接收完整 messages 端点，避免误套 OpenAI 协议。
        adapterProvider: 'anthropic-compatible',
        baseUrl: `${normalizeVersionedAnthropicBaseUrl(catalogModel.baseUrl)}/messages`,
      }
    case 'openai-completions':
      return {
        adapterProvider: 'opencode-go-openai',
        baseUrl: catalogModel.baseUrl,
      }
    case 'openai-responses':
      return {
        adapterProvider: 'openai-responses',
        baseUrl: catalogModel.baseUrl,
      }
    default:
      return undefined
  }
}

/**
 * 解析 Pi runtime 的会话级 reasoning capability。
 *
 * 专属 profile 先匹配，保证 K3 / GLM / GPT-o 的协议映射不被 catalog 覆盖；
 * 其他模型直接采用 Pi catalog 声明的可用档位。
 */
export async function resolvePiReasoningCapability(
  provider: ProviderType,
  modelId: string | undefined,
): Promise<ReasoningCapability | undefined> {
  const resolvedModelId = stripLegacyAgentSdkContextSuffix(modelId)
  const catalogModel = resolvedModelId
    ? await findPiCatalogModel(provider, resolvedModelId)
    : undefined
  const profile = resolveReasoningProfile({
    modelId: resolvedModelId,
    transport: provider === 'openai-codex' || provider === 'xai'
      ? 'openai-responses'
      : toReasoningTransport(resolvePiApi(provider, catalogModel?.api)),
  })
  return resolveReasoningCapability({
    profile,
    catalog: catalogModel && {
      reasoning: catalogModel.reasoning,
      thinkingLevelMap: catalogModel.thinkingLevelMap,
    },
  })
}

async function resolvePiModelDefaults(input: PiAgentQueryOptions): Promise<PiModelDefaults> {
  const catalogModel = input.model ? await findPiCatalogModel(input.provider, input.model) : undefined
  const codexAlignedCapabilities = getCodexAlignedGPT5Capabilities(input.model)
  const api = resolvePiApi(input.provider, catalogModel?.api)
  const providerSpecificCapabilities = compilePiReasoningCapabilities(api, input.model)
  const glmModelId = input.model?.toLowerCase()
  const isVolcengineGlm5x = (input.provider === 'doubao' || input.provider === 'ark-coding-plan')
    && (glmModelId === 'glm-5.2' || glmModelId === 'glm-5.3')
  const isCatalogMissingGlm53Family = !catalogModel
    && (glmModelId === 'glm-5.3' || glmModelId === 'glm-5.3-flash' || glmModelId === 'glm-5.3-flashx')
  const catalogContextWindow = catalogModel?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  const inferredContextWindow = inferContextWindow(input.model) ?? DEFAULT_CONTEXT_WINDOW
  const shouldForceAdaptiveThinking = shouldForcePiAdaptiveThinking(api, catalogModel, input.model)
  return {
    api,
    reasoning: catalogModel?.reasoning ?? true,
    thinkingLevelMap: providerSpecificCapabilities?.thinkingLevelMap
      ?? catalogModel?.thinkingLevelMap,
    compat: shouldForceAdaptiveThinking
      ? { ...providerSpecificCapabilities?.compat, forceAdaptiveThinking: true }
      : providerSpecificCapabilities?.compat,
    input: catalogModel ? [...catalogModel.input] : ['text', 'image'],
    cost: catalogModel ? { ...catalogModel.cost } : { ...ZERO_MODEL_COST },
    // Codex 对齐策略优先；其他模型仍保留 catalog 与 shared inference 中更大的已验证能力。
    contextWindow: codexAlignedCapabilities?.contextWindow ?? Math.max(catalogContextWindow, inferredContextWindow),
    // Pi catalog 缺少时，GLM-5.3 系列仍按官方 128K 输出上限注册。
    maxTokens: isVolcengineGlm5x
      ? VOLCENGINE_GLM_MAX_TOKENS
      : (catalogModel?.maxTokens ?? (isCatalogMissingGlm53Family ? GLM_53_FAMILY_MAX_TOKENS : DEFAULT_MAX_TOKENS)),
  }
}

export function normalizePiBaseUrl(baseUrl: string | undefined, provider: ProviderType, api = normalizePiApi(provider)): string | undefined {
  if (!baseUrl) return undefined
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, '')
  if (api === 'anthropic-messages') {
    return normalizeAnthropicBaseUrlForSdk(resolveAnthropicMessagesUrl(normalizedBaseUrl, provider))
  }
  if (api === 'openai-responses' || provider === 'custom') {
    return normalizeOpenAIBaseUrlForSdk(normalizedBaseUrl)
  }
  // Pi 的 Google adapter 把 `model.baseUrl` 视为已包含 API 版本的完整根路径，
  // 并明确禁用 Google SDK 自行追加 apiVersion。渠道配置仍以协议根
  // `https://generativelanguage.googleapis.com` 保存；若这里直接传入，Agent 会请求
  // `/models/...` 而不是 `/v1beta/models/...`，导致 404。Chat adapter 自己拼 v1beta，
  // 因此只在 Pi runtime 注册时补齐，且保留用户已填写的 v1/v1beta（含代理路径）。
  if (api === 'google-generative-ai' && !/\/v1(?:beta)?$/i.test(normalizedBaseUrl)) {
    return `${normalizedBaseUrl}/v1beta`
  }
  return normalizedBaseUrl
}

export function requiresAppUserAgent(provider: ProviderType): boolean {
  return provider === 'kimi-coding'
    || provider === 'xiaomi-token-plan'
    || provider === 'qwen-token-plan'
    || provider === 'zhipu-coding'
    || provider === 'zhipu-coding-team'
}

function usesBearerOnlyAnthropicAuth(provider: ProviderType): boolean {
  return requiresAppUserAgent(provider) || provider === 'minimax' || provider === 'qwen-anthropic'
}

export function buildPiRequestHeaders(provider: ProviderType, apiKey: string): PiRequestHeaders | undefined {
  if (normalizePiApi(provider) !== 'anthropic-messages') return undefined

  const headers: PiRequestHeaders = {
    Authorization: `Bearer ${apiKey}`,
  }

  if (requiresAppUserAgent(provider)) {
    headers['User-Agent'] = getAppUserAgent()
  }

  return headers
}

function shouldUseRuntimeApiKey(provider: ProviderType): boolean {
  return !usesBearerOnlyAnthropicAuth(provider)
}

/**
 * 解析出用于 Pi runtime 认证的真实 API token。
 *
 * 智谱团队版（zhipu-coding-team）的凭据是复合串（形如
 * `apiKey=xxx; bigmodel_organization=yyy; bigmodel_project=zzz`），
 * 必须先提取其中的 apiKey，否则整串会被塞进 `Authorization: Bearer` 头导致 401。
 * 与渠道认证解析保持一致。
 */
export function resolvePiApiKey(provider: ProviderType, apiKey: string): string {
  return provider === 'zhipu-coding-team' ? extractZhipuCodingTeamApiToken(apiKey) : apiKey
}

/**
 * 剥离模型 ID 上的 `[1m]` 扩展上下文后缀。
 *
 * `[1m]` 是 Claude Agent SDK 专用的扩展上下文变体，pi runtime 及其对接的
 * 端点（智谱等）并不识别，带后缀会被判为「模型不存在」（智谱 1211）。
 * pi 模式统一剥离该后缀，保证注册与请求使用干净的模型 ID。
 */
export function stripLegacyAgentSdkContextSuffix(modelId: string | undefined): string | undefined {
  return modelId?.replace(/\[1m\]$/i, '')
}

function mergeCodexModels(models: readonly PiCatalogModel[]): PiCatalogModel[] {
  const merged = models.map((model) => ({ ...model }))
  const indexById = new Map(merged.map((model, index) => [model.id, index]))
  for (const patch of CODEX_MODEL_PATCHES) {
    const existingIndex = indexById.get(patch.id)
    const existing = existingIndex !== undefined ? merged[existingIndex] : undefined
    if (existingIndex !== undefined && existing) {
      merged[existingIndex] = { ...existing, ...patch }
    } else if (isCompleteCatalogModel(patch)) {
      indexById.set(patch.id, merged.length)
      merged.push(patch)
    }
  }
  return merged
}

function isCompleteCatalogModel(model: PiCatalogModelPatch): model is PiCatalogModel {
  return Boolean(
    model.name
      && model.api
      && model.provider
      && model.baseUrl
      && model.input
      && model.cost
      && model.contextWindow
      && model.maxTokens,
  )
}

export async function getCodexCatalogModels(): Promise<PiCatalogModel[]> {
  const { getModels } = await loadPiAiCompat()
  return mergeCodexModels(getModels('openai-codex')).filter(isSupportedCodexModel)
}

/**
 * 为 ChatGPT (Codex) OAuth 渠道构建模型。
 *
 * openai-codex 是 Pi SDK 的内置 KnownProvider：模型目录、baseUrl 和
 * `openai-codex-responses` 协议全部内置，无需（也不能）手工构造 models 或 baseUrl。
 * Pi 0.80.10 将它声明为 OAuth-only provider；runtime API key 不会参与其认证解析。
 * 因此将 Canopy 已刷新过的完整凭据放入一次性内存 OAuth credential store，
 * 按真实 expires 刷新并回写 Canopy，避免读写全局 ~/.pi 认证文件。
 */
export async function buildCodexModel(sdk: PiSdk, input: CodexModelInput) {
  if (!input.codexOAuthCredentials) {
    throw new Error('ChatGPT (Codex) OAuth 凭据缺失，请重新登录')
  }

  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: createCodexRuntimeCredentialStore(
      input.codexOAuthCredentials,
      input.onCodexOAuthCredentialsRefreshed,
    ),
    allowModelNetwork: false,
  })

  const resolvedModelId = stripLegacyAgentSdkContextSuffix(input.model)
  // 已下线模型从运行时目录里剔掉：既不能被显式命中，也不能在未指定模型时被当成首个内置模型
  // （pi-ai 0.85.1 目录里 gpt-5.3-codex-spark 恰好排第一）。
  const runtimeModels = modelRuntime.getModels('openai-codex').filter(isSupportedCodexModel)
  const codexModels = await getCodexCatalogModels()
  // 上游 #1999：显式指定的模型 ID 查不到时直接报错，不再静默回退到首个内置模型——
  // 回退会让会话悄悄换成另一个模型跑完（用户看不出来），比一条明确的错误更糟。
  // 未指定模型（resolvedModelId 为空）时仍取首个内置模型。
  const model = resolvedModelId
    ? runtimeModels.find((candidate) => candidate.id === resolvedModelId)
      ?? findCatalogModelById(codexModels, resolvedModelId)
    : runtimeModels[0]

  if (!model) {
    if (resolvedModelId && isRetiredModelId(resolvedModelId)) {
      // 会话 / 默认模型 / 定时任务 / IM 绑定里还存着已下线模型时走这里：同样不静默换模型，但说人话。
      throw new Error(formatRetiredModelMessage(resolvedModelId))
    }
    if (resolvedModelId) {
      throw new Error(`未找到指定的 ChatGPT (Codex) 模型: ${resolvedModelId}`)
    }
    throw new Error('未找到可用的 ChatGPT (Codex) 模型，请确认已登录并升级 Pi 运行时')
  }
  return { modelRuntime, model }
}

/** 列出 Pi SDK 内置的 ChatGPT (Codex) 模型 ID，供渲染层"模型拉取"使用。 */
export async function listCodexModels(): Promise<{ id: string; name: string }[]> {
  return (await getCodexCatalogModels()).map((m) => ({ id: m.id, name: m.name }))
}

export async function getXaiCatalogModels(): Promise<PiCatalogModel[]> {
  const { getModels } = await loadPiAiCompat()
  return [...getModels('xai')]
}

/**
 * 为 xAI（Grok/X 订阅）OAuth 渠道构建 Pi 内置模型。
 *
 * xAI 的 device-code token 不等同于 xAI API key，必须注入内存 CredentialStore
 * 并使用内置 `xai` provider，不能退回 registerProvider() 的 API key 路径。
 */
export async function buildXaiModel(sdk: PiSdk, input: XaiModelInput) {
  if (!input.xaiOAuthCredentials || !input.channelId) {
    throw new Error('xAI OAuth 凭据或渠道标识缺失，请重新登录')
  }
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: createXaiRuntimeCredentialStore(
      input.channelId,
      input.xaiOAuthCredentials,
      input.onXaiOAuthCredentialsRefreshed,
    ),
    allowModelNetwork: false,
  })
  const resolvedModelId = stripLegacyAgentSdkContextSuffix(input.model)
  const xaiModels = await getXaiCatalogModels()
  const model = (resolvedModelId ? modelRuntime.getModel('xai', resolvedModelId) : undefined)
    ?? (resolvedModelId ? findCatalogModelById(xaiModels, resolvedModelId) : undefined)
    ?? modelRuntime.getModels('xai')[0]
  if (!model) {
    throw new Error('未找到可用的 xAI（Grok）模型，请确认订阅已授权并升级 Pi 运行时')
  }
  return { modelRuntime, model }
}

/** 列出 Pi SDK 内置的 xAI（Grok）模型 ID，供订阅登录后拉取模型使用。 */
export async function listXaiModels(): Promise<{ id: string; name: string }[]> {
  return (await getXaiCatalogModels()).map((m) => ({ id: m.id, name: m.name }))
}

export async function buildModel(sdk: PiSdk, input: PiAgentQueryOptions) {
  // 官方已下线的模型：任何渠道（官方 API、中转网关）都不会再有，发请求前直接给出人话提示，
  // 不把网关的 404 / 模型不存在原文甩给用户，也不静默换成别的模型。
  const requestedModelId = stripLegacyAgentSdkContextSuffix(input.model)
  if (requestedModelId && isRetiredModelId(requestedModelId)) {
    throw new Error(formatRetiredModelMessage(requestedModelId))
  }
  if (input.provider === 'openai-codex') {
    return buildCodexModel(sdk, input)
  }
  if (input.provider === 'xai') {
    return buildXaiModel(sdk, input)
  }
  const providerName = `canopy-${input.provider}-${input.sessionId}`
  const resolvedApiKey = resolvePiApiKey(input.provider, input.apiKey)
  // pi runtime 统一剥离历史 `[1m]` 后缀：无论上游从哪条路径传入，注册与查找都用干净 ID。
  const resolvedModelId = stripLegacyAgentSdkContextSuffix(input.model)
  const modelRuntime = await sdk.ModelRuntime.create({ allowModelNetwork: false })
  const modelDefaults = await resolvePiModelDefaults({ ...input, model: resolvedModelId })
  const api = modelDefaults.api
  const baseUrl = normalizePiBaseUrl(input.baseUrl, input.provider, api)
  if (!baseUrl) {
    throw new Error(`渠道 ${input.channelName ?? input.provider} 缺少 Base URL`)
  }
  const headers = buildPiRequestHeaders(input.provider, resolvedApiKey)
  const compat = {
    ...modelDefaults.compat,
    ...(supportsPiDeveloperRole(input.provider) ? {} : { supportsDeveloperRole: false }),
  }
  modelRuntime.registerProvider(providerName, {
    name: input.channelName ?? providerName,
    apiKey: resolvedApiKey,
    ...(headers ? { headers } : {}),
    api,
    baseUrl,
    models: [{
      id: resolvedModelId ?? 'default',
      name: resolvedModelId ?? 'Default',
      api,
      baseUrl,
      reasoning: modelDefaults.reasoning,
      ...(modelDefaults.thinkingLevelMap ? { thinkingLevelMap: modelDefaults.thinkingLevelMap } : {}),
      ...(Object.keys(compat).length > 0 ? { compat } : {}),
      input: modelDefaults.input,
      cost: modelDefaults.cost,
      contextWindow: modelDefaults.contextWindow,
      maxTokens: modelDefaults.maxTokens,
    }],
  })
  const model = modelRuntime.getModel(providerName, resolvedModelId ?? 'default')
  if (!model) throw new Error(`Pi model registration failed: ${resolvedModelId ?? 'default'}`)
  return { modelRuntime, model }
}
