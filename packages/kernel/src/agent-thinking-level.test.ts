import { describe, expect, test } from 'bun:test'
import { resolvePiThinkingLevel } from './agent-thinking-level'

describe('Pi thinking level resolver', () => {
  test('Given OpenAI session override When resolving Then uses the per-session level', () => {
    expect(resolvePiThinkingLevel(
      { agentThinking: { type: 'adaptive' }, agentEffort: 'medium' },
      { openAIThinkingLevel: 'off' },
      'openai-codex',
      'gpt-5.5',
    )).toBe('off')
  })

  test.each(['openai', 'openai-responses', 'custom'] as const)(
    'Given third-party %s GPT-5.6 When session has max override Then uses it',
    (provider) => {
      expect(resolvePiThinkingLevel(
        { agentThinking: { type: 'adaptive' }, agentEffort: 'medium' },
        { openAIThinkingLevel: 'max' },
        provider,
        'gpt-5.6-terra',
      )).toBe('max')
    },
  )

  test('Given a persisted max override When switching to GPT-5.5 Then clamps it to xhigh', () => {
    expect(resolvePiThinkingLevel(
      { agentThinking: { type: 'adaptive' }, agentEffort: 'medium' },
      { openAIThinkingLevel: 'max' },
      'custom',
      'gpt-5.5',
    )).toBe('xhigh')
  })

  test('Given non-OpenAI provider When session has OpenAI override Then keeps global Pi thinking level', () => {
    expect(resolvePiThinkingLevel(
      { agentThinking: { type: 'adaptive' }, agentEffort: 'medium' },
      { openAIThinkingLevel: 'xhigh' },
      'anthropic',
    )).toBe('medium')
  })

  test('Given no session override When global max effort is selected Then maps it to xhigh', () => {
    expect(resolvePiThinkingLevel(
      { agentThinking: { type: 'adaptive' }, agentEffort: 'max' },
      undefined,
      'openai-responses',
    )).toBe('xhigh')
  })

  // GLM-5.3 始终思考（智谱官方 + 端点实测：disabled 会被 1210 拒绝），主进程解析出的档位绝不能是 off
  test('Given GLM-5.3 on zhipu When global thinking is disabled Then resolves to low instead of off', () => {
    expect(resolvePiThinkingLevel(
      { agentThinking: { type: 'disabled' }, agentEffort: 'high' },
      undefined,
      'zhipu',
      'glm-5.3',
    )).toBe('low')
  })

  // 上游 #1748 的输入变体：全局 disabled 且会话 override 也是 off，两个「关」叠加仍必须抬到 low
  test('Given GLM-5.3 When both global disabled and session off override are present Then resolves to low', () => {
    expect(resolvePiThinkingLevel(
      { agentThinking: { type: 'disabled' }, agentEffort: 'high' },
      { reasoningLevel: 'off' },
      'zhipu',
      'glm-5.3',
    )).toBe('low')
  })

  // 上游 #1748 的默认档用例，断言按我方产品决策（defaultLevel high，与应用内其它模型一致；上游是 max）
  test('Given GLM-5.3 and no effort nor override When resolving Then falls back to profile default high', () => {
    expect(resolvePiThinkingLevel(
      { agentThinking: { type: 'adaptive' } },
      undefined,
      'zhipu-coding',
      'glm-5.3',
    )).toBe('high')
  })

  test('Given a session that persisted off on GLM-5.2 When it switches to GLM-5.3 on Coding Plan Then resolves to low', () => {
    expect(resolvePiThinkingLevel(
      { agentThinking: { type: 'adaptive' }, agentEffort: 'high' },
      { reasoningLevel: 'off' },
      'zhipu-coding',
      'glm-5.3',
    )).toBe('low')
  })

  test('Given GLM-5.3 When global effort is max Then keeps max; GLM-5.2 with thinking disabled still resolves to off', () => {
    expect(resolvePiThinkingLevel(
      { agentThinking: { type: 'adaptive' }, agentEffort: 'max' },
      undefined,
      'zhipu-coding-team',
      'glm-5.3',
    )).toBe('max')
    expect(resolvePiThinkingLevel(
      { agentThinking: { type: 'disabled' }, agentEffort: 'high' },
      undefined,
      'zhipu',
      'glm-5.2',
    )).toBe('off')
  })
})
