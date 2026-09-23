import { describe, expect, test } from 'bun:test'
import {
  normalizeReasoningLevel,
  resolveReasoningCapability,
  resolveReasoningProfile,
} from './reasoning-profile'

/**
 * GLM-5.3 档位契约（智谱官方文档 + 2026-08-17 端点实测）：始终思考、不可关闭，
 * reasoning_effort 仅 low / high / max；发 disabled 或 medium 会被 1210 拒绝。
 * 这里守住的是「应用层永远不会向 5.3 编码出 off / medium」这条线。
 */
describe('resolveReasoningProfile · GLM-5.3', () => {
  test('给定 glm-5.3 走 openai-completions（智谱 API 端点），应命中独立的 5.3 档位表而非 5.2', () => {
    const profile = resolveReasoningProfile({ modelId: 'glm-5.3', transport: 'openai-completions' })
    expect(profile?.id).toBe('glm-5.3')
    expect(profile?.levels).toEqual(['low', 'high', 'max'])
    expect(profile?.defaultLevel).toBe('high')
    expect(profile?.encodings['openai-completions']?.kind).toBe('zai-thinking-effort')
  })

  test('给定 glm-5.3 走 anthropic-messages（Coding Plan 端点），应用 adaptive + effort 编码', () => {
    const profile = resolveReasoningProfile({ modelId: 'GLM-5.3', transport: 'anthropic-messages' })
    expect(profile?.id).toBe('glm-5.3')
    expect(profile?.encodings['anthropic-messages']?.kind).toBe('adaptive-effort')
  })

  test('5.3 的档位表里没有 off，且 off 在两种编码的映射里都标为 null（Pi clamp 会把它剔出可选集）', () => {
    const profile = resolveReasoningProfile({ modelId: 'glm-5.3', transport: 'openai-completions' })!
    expect(profile.levels).not.toContain('off')
    for (const transport of ['openai-completions', 'anthropic-messages'] as const) {
      const map = profile.encodings[transport]!.effortMap
      expect(map.off).toBeNull()
      // 每个非 off 档位都必须映射成端点认的三个值之一，绝不让 medium / xhigh 原样透传
      for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
        expect(['low', 'high', 'max']).toContain(map[level] ?? 'missing')
      }
    }
  })

  test('normalize：off / minimal / low → low（关不掉时落到最轻），medium / high / 未设置 → high，xhigh / max → max', () => {
    const profile = resolveReasoningProfile({ modelId: 'glm-5.3', transport: 'anthropic-messages' })
    expect(normalizeReasoningLevel(profile, 'off')).toBe('low')
    expect(normalizeReasoningLevel(profile, 'minimal')).toBe('low')
    expect(normalizeReasoningLevel(profile, 'low')).toBe('low')
    expect(normalizeReasoningLevel(profile, 'medium')).toBe('high')
    expect(normalizeReasoningLevel(profile, 'high')).toBe('high')
    expect(normalizeReasoningLevel(profile, undefined)).toBe('high')
    expect(normalizeReasoningLevel(profile, 'xhigh')).toBe('max')
    expect(normalizeReasoningLevel(profile, 'max')).toBe('max')
  })

  test('会话 capability 由 profile 派生：只暴露 low / high / max，默认 high', () => {
    const profile = resolveReasoningProfile({ modelId: 'glm-5.3', transport: 'openai-completions' })
    const capability = resolveReasoningCapability({ profile })
    expect(capability).toEqual({ source: 'profile', levels: ['low', 'high', 'max'], defaultLevel: 'high' })
  })

  test('glm-5.2 不受影响：仍可关闭思考、档位 off / high / max', () => {
    const profile = resolveReasoningProfile({ modelId: 'glm-5.2', transport: 'openai-completions' })
    expect(profile?.id).toBe('glm-5.2')
    expect(profile?.levels).toEqual(['off', 'high', 'max'])
    expect(normalizeReasoningLevel(profile, 'off')).toBe('off')
  })

  test('glm-5.3-flash 与 glm-5.3-flashx（上游 #2077）同属 5.3 系列，命中同一张档位表（ID 大小写不敏感）', () => {
    for (const modelId of ['glm-5.3-flash', 'glm-5.3-flashx', 'GLM-5.3-FlashX']) {
      expect(resolveReasoningProfile({ modelId, transport: 'openai-completions' })?.id).toBe('glm-5.3')
      expect(resolveReasoningProfile({ modelId, transport: 'anthropic-messages' })?.id).toBe('glm-5.3')
    }
  })

  test('5.3 的变体 ID（如 glm-5.3-air）与不支持的 transport 不命中 profile，交给 Pi 目录', () => {
    expect(resolveReasoningProfile({ modelId: 'glm-5.3-air', transport: 'openai-completions' })).toBeUndefined()
    expect(resolveReasoningProfile({ modelId: 'glm-5.3', transport: 'openai-responses' })).toBeUndefined()
  })
})

/**
 * GPT-6 Astra 档位契约（OpenAI 模型页 + 迁移指南，2026-09-05 核对）：
 * 只有 low / medium / high / xhigh / max，**不支持 none**，minimal 未列出（指引：原用 none / minimal 的从 low 起步）。
 * 这里守住的是「应用层永远不会向 Astra 编码出 none」这条线——沿用 5.x 的 off→none 映射会被端点拒绝。
 */
describe('resolveReasoningProfile · GPT-6 Astra', () => {
  test('给定 gpt-6-astra 走 openai-responses（Codex OAuth / Responses 网关），应命中独立的 astra 档位表', () => {
    const profile = resolveReasoningProfile({ modelId: 'gpt-6-astra', transport: 'openai-responses' })

    expect(profile?.id).toBe('openai-reasoning-astra')
    expect(profile?.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(profile?.defaultLevel).toBe('low')
    expect(profile?.encodings['openai-responses']?.kind).toBe('openai-reasoning-effort')
  })

  test('档位表里没有 off；off / minimal 在编码与归一两层都落到 low，绝不映射成 none', () => {
    const profile = resolveReasoningProfile({ modelId: 'gpt-6-astra', transport: 'openai-completions' })!

    expect(profile.levels).not.toContain('off')
    expect(profile.levels).not.toContain('minimal')
    for (const transport of ['openai-completions', 'openai-responses'] as const) {
      expect(profile.encodings[transport]?.effortMap.off).toBe('low')
      expect(profile.encodings[transport]?.effortMap.minimal).toBe('low')
      expect(profile.encodings[transport]?.effortMap.xhigh).toBe('xhigh')
      expect(profile.encodings[transport]?.effortMap.max).toBe('max')
    }
    expect(profile.normalize('off')).toBe('low')
    expect(profile.normalize('minimal')).toBe('low')
    expect(profile.normalize(undefined)).toBe('low')
    expect(profile.normalize('medium')).toBe('medium')
    expect(profile.normalize('max')).toBe('max')
  })

  test('带日期后缀的快照与大小写混排同样命中；anthropic 协议不命中，交给 Pi 目录', () => {
    expect(resolveReasoningProfile({ modelId: 'gpt-6-astra-2026-09-01', transport: 'openai-responses' })?.id).toBe('openai-reasoning-astra')
    expect(resolveReasoningProfile({ modelId: 'GPT-6-Astra', transport: 'openai-responses' })?.id).toBe('openai-reasoning-astra')
    expect(resolveReasoningProfile({ modelId: 'gpt-6-astra', transport: 'anthropic-messages' })).toBeUndefined()
  })

  test('其他 gpt-6 变体不冒充 Astra：无 profile、交给 Pi 目录（避免把 off→none 发给同样拒绝 none 的模型）', () => {
    expect(resolveReasoningProfile({ modelId: 'gpt-6-mini', transport: 'openai-responses' })).toBeUndefined()
    expect(resolveReasoningProfile({ modelId: 'gpt-6', transport: 'openai-responses' })).toBeUndefined()
  })

  test('会话 capability 由 profile 派生：只暴露五档、默认 low；来自旧会话的 off 被归一到 low 而非 high', () => {
    const profile = resolveReasoningProfile({ modelId: 'gpt-6-astra', transport: 'openai-responses' })

    expect(resolveReasoningCapability({ profile })).toEqual({
      source: 'profile',
      levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultLevel: 'low',
    })
    expect(normalizeReasoningLevel(profile, 'off')).toBe('low')
  })

  test('GPT-5.6 不受影响：仍是 openai-reasoning-max，off 仍编码为 none', () => {
    const profile = resolveReasoningProfile({ modelId: 'gpt-5.6-terra', transport: 'openai-responses' })

    expect(profile?.id).toBe('openai-reasoning-max')
    expect(profile?.encodings['openai-responses']?.effortMap.off).toBe('none')
  })
})
