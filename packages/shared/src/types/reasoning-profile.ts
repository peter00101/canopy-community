import type { ProviderType } from './channel'
import type { AgentThinkingLevel } from './agent'

/** Canopy 可识别的 reasoning 请求协议族。 */
export type ReasoningTransport =
  | 'anthropic-messages'
  | 'openai-completions'
  | 'openai-responses'
  | 'other'

/**
 * 将渠道归类到其实际的 reasoning 请求协议。
 *
 * 渠道名不能直接决定请求字段；profile 必须同时匹配模型 ID 和 transport，
 * 才能避免把 OpenAI 的 reasoning_effort 发送到 Anthropic endpoint。
 */
export function inferReasoningTransport(provider: ProviderType | undefined): ReasoningTransport {
  switch (provider) {
    case 'openai':
    case 'opencode-go-openai':
    case 'zhipu':
    case 'doubao':
    case 'qwen':
    case 'custom':
      return 'openai-completions'
    case 'openai-codex':
    case 'openai-responses':
    case 'xai':
      return 'openai-responses'
    case 'google':
      return 'other'
    default:
      return 'anthropic-messages'
  }
}

/** 编译器据此生成 runtime 专属请求参数。 */
export type ReasoningEncodingKind =
  | 'adaptive-effort'
  | 'deepseek-output-effort'
  | 'openai-reasoning-effort'
  | 'zai-thinking-effort'

/** 每个产品等级映射为目标协议可接受的 effort 值。 */
export type ReasoningEffortMap = Partial<Record<AgentThinkingLevel, string | null>>

export interface ReasoningEncoding {
  kind: ReasoningEncodingKind
  effortMap: ReasoningEffortMap
}

export interface ReasoningProfile {
  id: 'deepseek-v4-flash' | 'deepseek-flash' | 'deepseek-v4-pro' | 'kimi-k3' | 'glm-5.2' | 'glm-5.3' | 'openai-reasoning-standard' | 'openai-reasoning-max' | 'openai-reasoning-astra'
  levels: readonly AgentThinkingLevel[]
  defaultLevel: AgentThinkingLevel
  normalize(level: AgentThinkingLevel | undefined): AgentThinkingLevel
  encodings: Partial<Record<ReasoningTransport, ReasoningEncoding>>
}

/** Pi model catalog 中与会话级 reasoning 选择有关的最小元数据。 */
export interface PiCatalogReasoningMetadata {
  reasoning?: boolean
  thinkingLevelMap?: Partial<Record<AgentThinkingLevel, string | null>>
}

/**
 * 可跨主进程和渲染进程传输的 reasoning capability。
 *
 * 不携带 protocol encoding；Pi catalog 继续负责把所选 level 编码为实际请求字段。
 */
export interface ReasoningCapability {
  source: 'profile' | 'pi-catalog'
  levels: readonly AgentThinkingLevel[]
  defaultLevel: AgentThinkingLevel
}

export interface ResolveReasoningCapabilityInput {
  profile?: ReasoningProfile
  catalog?: PiCatalogReasoningMetadata
}

export interface ResolveReasoningProfileInput {
  modelId: string | undefined
  transport: ReasoningTransport
}

const DEEPSEEK_V4_LEVELS = ['off', 'low', 'high', 'xhigh', 'max'] as const satisfies readonly AgentThinkingLevel[]
const K3_LEVELS = ['off', 'low', 'high', 'max'] as const satisfies readonly AgentThinkingLevel[]
/** 智谱自 GLM-5.2 起支持 reasoning_effort（high / max）且仍可关闭思考；GLM-5.1 及更早只有思考开关，不在此列。 */
const GLM_52_LEVELS = ['off', 'high', 'max'] as const satisfies readonly AgentThinkingLevel[]
/**
 * GLM-5.3（智谱官方文档，2026-08）：始终思考、**不支持关闭**，`reasoning_effort` 仅接受 low / high / max。
 * 端点实测：`thinking:{type:'disabled'}`、`reasoning_effort:'medium'`、Anthropic 协议下不带思考参数，
 * 三种请求都被 1210「该模型始终思考，不支持关闭思考；请使用 low、high 或 max」拒绝，故档位表里不能有 off。
 */
const GLM_53_LEVELS = ['low', 'high', 'max'] as const satisfies readonly AgentThinkingLevel[]
const OPENAI_STANDARD_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh'] as const satisfies readonly AgentThinkingLevel[]
const OPENAI_MAX_LEVELS = [...OPENAI_STANDARD_LEVELS, 'max'] as const satisfies readonly AgentThinkingLevel[]

// DeepSeek Anthropic compatibility only honors output_config.effort. The official
// V4 Flash and Pro mappings differ at low and xhigh; off is handled by emitting
// `thinking: { type: 'disabled' }` rather than an effort value.
const DEEPSEEK_V4_FLASH_EFFORT_MAP: ReasoningEffortMap = {
  minimal: null,
  low: 'low',
  medium: null,
  high: 'high',
  xhigh: 'high',
  max: 'max',
}
const DEEPSEEK_V4_PRO_EFFORT_MAP: ReasoningEffortMap = {
  minimal: null,
  low: 'high',
  medium: null,
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

const K3_EFFORT_MAP: ReasoningEffortMap = {
  minimal: 'low',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

const GLM_52_OPENAI_EFFORT_MAP: ReasoningEffortMap = {
  minimal: null,
  low: 'high',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

const GLM_52_ANTHROPIC_EFFORT_MAP: ReasoningEffortMap = {
  minimal: 'high',
  low: 'high',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

/**
 * GLM-5.3 两种协议共用一张表：每个档位都映射成端点认的 low / high / max，绝不让 medium 之类原样透传。
 * `off: null` 是第二道保险——Pi 的 `clampThinkingLevel` 会把标 null 的档位从可选集里剔除，
 * 即使有残留的 off 传到运行时，也会被就近抬成最低档而不是编码成 `thinking:{type:'disabled'}`
 *（openai-completions 的 zai 格式遇到 off 必发 disabled；anthropic 格式在 off 为 null 时则干脆不发 thinking 字段）。
 * 第一道保险是下方 normalizeGlm53Level：应用层已把 off 归到 low（智谱迁移指引：disabled → enabled + low）。
 */
const GLM_53_EFFORT_MAP: ReasoningEffortMap = {
  off: null,
  minimal: 'low',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

// Pi uses this sparse map as an override for its native level mapping. In particular,
// off must become none because OpenAI reasoning models otherwise default to medium.
const OPENAI_STANDARD_EFFORT_MAP: ReasoningEffortMap = {
  off: 'none',
  minimal: 'low',
  xhigh: 'xhigh',
}
const OPENAI_MAX_EFFORT_MAP: ReasoningEffortMap = {
  ...OPENAI_STANDARD_EFFORT_MAP,
  max: 'max',
}

function normalizeDeepSeekV4Level(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  switch (level) {
    case 'off':
      return 'off'
    case 'minimal':
    case 'low':
      return 'low'
    case 'medium':
    case 'high':
      return 'high'
    case 'xhigh':
      return 'xhigh'
    case 'max':
      return 'max'
    default:
      return 'high'
  }
}

function normalizeK3Level(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  switch (level) {
    case 'off':
      return 'off'
    case 'minimal':
    case 'low':
      return 'low'
    case 'medium':
    case 'high':
      return 'high'
    case 'xhigh':
    case 'max':
      return 'max'
    default:
      return 'high'
  }
}

function normalizeGlm52Level(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  if (level === 'off') return 'off'
  return level === 'xhigh' || level === 'max' ? 'max' : 'high'
}

/**
 * GLM-5.3 不能关思考：off（含全局「关闭思考」设置、以及 5.2 会话残留的 off）落到最轻的 low；
 * 未设置时取 high，与 5.2 及应用内其它模型的默认档一致（官方 API 侧默认是 max，如需可只改此处与 defaultLevel）。
 */
function normalizeGlm53Level(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  switch (level) {
    case 'off':
    case 'minimal':
    case 'low':
      return 'low'
    case 'xhigh':
    case 'max':
      return 'max'
    default:
      return 'high'
  }
}

function normalizeOpenAIStandardLevel(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  if (level === 'off') return 'off'
  if (level === 'minimal') return 'low'
  if (level === 'max') return 'xhigh'
  return level ?? 'high'
}

function normalizeOpenAIMaxLevel(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  if (level === 'minimal') return 'low'
  return level ?? 'high'
}

const DEEPSEEK_V4_FLASH_PROFILE: ReasoningProfile = {
  id: 'deepseek-v4-flash',
  levels: DEEPSEEK_V4_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeDeepSeekV4Level,
  encodings: {
    'anthropic-messages': { kind: 'deepseek-output-effort', effortMap: DEEPSEEK_V4_FLASH_EFFORT_MAP },
  },
}

const DEEPSEEK_FLASH_PROFILE: ReasoningProfile = {
  id: 'deepseek-flash',
  levels: DEEPSEEK_V4_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeDeepSeekV4Level,
  encodings: {
    'anthropic-messages': { kind: 'deepseek-output-effort', effortMap: DEEPSEEK_V4_FLASH_EFFORT_MAP },
  },
}

const DEEPSEEK_V4_PRO_PROFILE: ReasoningProfile = {
  id: 'deepseek-v4-pro',
  levels: DEEPSEEK_V4_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeDeepSeekV4Level,
  encodings: {
    'anthropic-messages': { kind: 'deepseek-output-effort', effortMap: DEEPSEEK_V4_PRO_EFFORT_MAP },
  },
}

const K3_PROFILE: ReasoningProfile = {
  id: 'kimi-k3',
  levels: K3_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeK3Level,
  encodings: {
    'anthropic-messages': { kind: 'adaptive-effort', effortMap: K3_EFFORT_MAP },
    'openai-completions': { kind: 'openai-reasoning-effort', effortMap: K3_EFFORT_MAP },
  },
}

const GLM_52_PROFILE: ReasoningProfile = {
  id: 'glm-5.2',
  levels: GLM_52_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeGlm52Level,
  encodings: {
    'anthropic-messages': { kind: 'adaptive-effort', effortMap: GLM_52_ANTHROPIC_EFFORT_MAP },
    'openai-completions': { kind: 'zai-thinking-effort', effortMap: GLM_52_OPENAI_EFFORT_MAP },
  },
}

/**
 * 编码复用 5.2 已验证的两条路径（端点实测这两种请求形态对 glm-5.3 都通过参数校验）：
 * - anthropic-messages（智谱 Coding Plan / 团队版端点）：adaptive + `output_config.effort`
 * - openai-completions（智谱 API 端点）：`thinking:{type:'enabled'}` + `reasoning_effort`
 */
const GLM_53_PROFILE: ReasoningProfile = {
  id: 'glm-5.3',
  levels: GLM_53_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeGlm53Level,
  encodings: {
    'anthropic-messages': { kind: 'adaptive-effort', effortMap: GLM_53_EFFORT_MAP },
    'openai-completions': { kind: 'zai-thinking-effort', effortMap: GLM_53_EFFORT_MAP },
  },
}

const OPENAI_STANDARD_PROFILE: ReasoningProfile = {
  id: 'openai-reasoning-standard',
  levels: OPENAI_STANDARD_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeOpenAIStandardLevel,
  encodings: {
    'openai-completions': { kind: 'openai-reasoning-effort', effortMap: OPENAI_STANDARD_EFFORT_MAP },
    'openai-responses': { kind: 'openai-reasoning-effort', effortMap: OPENAI_STANDARD_EFFORT_MAP },
  },
}

const OPENAI_MAX_PROFILE: ReasoningProfile = {
  id: 'openai-reasoning-max',
  levels: OPENAI_MAX_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeOpenAIMaxLevel,
  encodings: {
    'openai-completions': { kind: 'openai-reasoning-effort', effortMap: OPENAI_MAX_EFFORT_MAP },
    'openai-responses': { kind: 'openai-reasoning-effort', effortMap: OPENAI_MAX_EFFORT_MAP },
  },
}

/**
 * GPT-6 Astra（OpenAI 模型页 + 迁移指南，2026-09-05 核对）：档位 low / medium / high / xhigh / max，
 * **不支持 `none`**，`minimal` 亦未列出——官方迁移指引「原用 none / minimal 的从 low 起步」，
 * 故 off / minimal 一律归到 low；默认档取 low（上游 #1999 同，也符合指引的起步建议）。
 * 编码沿用 OpenAI reasoning effort：xhigh / max 需显式映射（Pi 原生只认到 high），
 * off 不再映射成 `none`（Astra 会拒绝），而是与 minimal 一样落到 low。
 */
const OPENAI_ASTRA_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly AgentThinkingLevel[]
const OPENAI_ASTRA_EFFORT_MAP: ReasoningEffortMap = {
  off: 'low',
  minimal: 'low',
  xhigh: 'xhigh',
  max: 'max',
}

function normalizeOpenAIAstraLevel(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  if (level === 'off' || level === 'minimal') return 'low'
  return level ?? 'low'
}

const OPENAI_ASTRA_PROFILE: ReasoningProfile = {
  id: 'openai-reasoning-astra',
  levels: OPENAI_ASTRA_LEVELS,
  defaultLevel: 'low',
  normalize: normalizeOpenAIAstraLevel,
  encodings: {
    'openai-completions': { kind: 'openai-reasoning-effort', effortMap: OPENAI_ASTRA_EFFORT_MAP },
    'openai-responses': { kind: 'openai-reasoning-effort', effortMap: OPENAI_ASTRA_EFFORT_MAP },
  },
}

export const REASONING_PROFILES: readonly ReasoningProfile[] = [
  DEEPSEEK_V4_FLASH_PROFILE,
  DEEPSEEK_FLASH_PROFILE,
  DEEPSEEK_V4_PRO_PROFILE,
  K3_PROFILE,
  GLM_52_PROFILE,
  GLM_53_PROFILE,
  OPENAI_STANDARD_PROFILE,
  OPENAI_MAX_PROFILE,
  OPENAI_ASTRA_PROFILE,
]

/** 仅按模型 ID 匹配，再以实际 transport 确认该模型是否有已验证的协议 encoding。 */
export function resolveReasoningProfile(input: ResolveReasoningProfileInput): ReasoningProfile | undefined {
  const modelId = input.modelId?.toLowerCase()
  if (!modelId) return undefined

  // GPT-6 Astra 不带 gpt-5 前缀、档位表也与 5.x 不同（无 off），按 ID 前缀单独命中；
  // 带日期后缀的快照（gpt-6-astra-2026-xx-xx）同档位表。transport 不匹配时同样交给 Pi 目录。
  if (/^gpt-6-astra(?:-|$)/.test(modelId)) {
    return OPENAI_ASTRA_PROFILE.encodings[input.transport] ? OPENAI_ASTRA_PROFILE : undefined
  }

  const isOpenAITransport = input.transport === 'openai-completions' || input.transport === 'openai-responses'
  const isOpenAIReasoningModel = !modelId.endsWith('-chat-latest')
    && (modelId.startsWith('gpt-5') || /^(o1|o3|o4)(?:-|$)/.test(modelId))
  // deepseek-flash 是 DeepSeek 2026-09 起 V4.1 Flash 的现行 ID（上游 #2042 随官方改名）；旧名 deepseek-v4-flash
  // 仍被 API 接受（底层已退役、请求转到 V4.1 Flash），两条档位表相同但各自成条，便于日后分别调整。
  // （上游此处还有一个 `modelId === 'gpt-6-astra'` 判断，我方已在函数开头用
  //   前缀正则提前命中并覆盖带日期后缀的快照，故不重复引入。）
  const profile = /^deepseek-flash(?:-|$)/.test(modelId)
    ? DEEPSEEK_FLASH_PROFILE
    : /^deepseek-v4-flash(?:-|$)/.test(modelId)
      ? DEEPSEEK_V4_FLASH_PROFILE
      : /^deepseek-v4-pro(?:-|$)/.test(modelId)
        ? DEEPSEEK_V4_PRO_PROFILE
      : /^(?:k3(?:-256k)?|kimi-k3)$/.test(modelId)
        ? K3_PROFILE
        : modelId === 'glm-5.3' || modelId === 'glm-5.3-flash' || modelId === 'glm-5.3-flashx'
          ? GLM_53_PROFILE
          : modelId === 'glm-5.2'
            ? GLM_52_PROFILE
            : isOpenAITransport && isOpenAIReasoningModel
              ? /^gpt-5\.6(?:-|$)/.test(modelId) ? OPENAI_MAX_PROFILE : OPENAI_STANDARD_PROFILE
              : undefined

  return profile?.encodings[input.transport] ? profile : undefined
}

const PI_EXTENDED_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly AgentThinkingLevel[]

function getPiCatalogThinkingLevels(catalog: PiCatalogReasoningMetadata): AgentThinkingLevel[] {
  if (!catalog.reasoning) return []

  return PI_EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = catalog.thinkingLevelMap?.[level]
    if (mapped === null) return false
    // Pi only exposes these extended levels when the catalog maps them explicitly.
    return level !== 'xhigh' && level !== 'max' || mapped !== undefined
  })
}

/**
 * 解析最终会话 capability。显式 profile 优先于 Pi catalog，保留经过验证的模型专属编码。
 */
export function resolveReasoningCapability(input: ResolveReasoningCapabilityInput): ReasoningCapability | undefined {
  if (input.profile) {
    return {
      source: 'profile',
      levels: input.profile.levels,
      defaultLevel: input.profile.defaultLevel,
    }
  }

  if (!input.catalog) return undefined
  const levels = getPiCatalogThinkingLevels(input.catalog)
  if (levels.length === 0 || levels.every((level) => level === 'off')) return undefined
  const defaultLevel = normalizeReasoningCapabilityLevel(
    { source: 'pi-catalog', levels, defaultLevel: 'high' },
    'high',
  ) ?? levels[0]!
  return {
    source: 'pi-catalog',
    levels,
    defaultLevel,
  }
}

/**
 * 与 Pi `clampThinkingLevel` 保持一致：请求档位不可用时优先向更高档位靠拢，再向低档位回退。
 */
export function normalizeReasoningCapabilityLevel(
  capability: ReasoningCapability | undefined,
  level: AgentThinkingLevel | undefined,
): AgentThinkingLevel | undefined {
  if (!capability) return level
  const requested = level ?? capability.defaultLevel
  if (capability.levels.includes(requested)) return requested

  // Some models (for example Fable 5.1) always reason and do not expose an off
  // mode. Preserve the product's "disabled" legacy setting as a safe, explicit
  // high-effort request instead of silently downgrading it to minimal.
  if (requested === 'off') {
    return capability.levels.includes('high') ? 'high' : capability.defaultLevel
  }

  const requestedIndex = PI_EXTENDED_THINKING_LEVELS.indexOf(requested)
  if (requestedIndex === -1) return capability.levels[0]
  for (let index = requestedIndex; index < PI_EXTENDED_THINKING_LEVELS.length; index += 1) {
    const candidate = PI_EXTENDED_THINKING_LEVELS[index]
    if (candidate && capability.levels.includes(candidate)) return candidate
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = PI_EXTENDED_THINKING_LEVELS[index]
    if (candidate && capability.levels.includes(candidate)) return candidate
  }
  return capability.levels[0]
}

export function normalizeReasoningLevel(
  profile: ReasoningProfile | undefined,
  level: AgentThinkingLevel | undefined,
): AgentThinkingLevel | undefined {
  return profile ? profile.normalize(level) : level
}
