import { describe, expect, test } from 'bun:test'
import {
  buildRoutingIdentity,
  buildRoutingUserId,
  CONSECUTIVE_FAILURES_BEFORE_REROUTE,
  createRoutingEpochStore,
  injectRoutingIdentity,
  isCountableFailure,
} from './channel-routing-identity'

/** CCH（claude-code-hub）解析 metadata.user_id 的 legacy 正则，复制自其 src/lib/claude-code/metadata-user-id.ts。 */
const CCH_LEGACY_PATTERN = /^user_(.+?)_account__session_(.+)$/

describe('渠道路由身份（CCH 会话粘滞解绑）', () => {
  test('Given epoch 0 When 构造 user_id Then 无代数后缀且能被 CCH legacy 正则解析出原会话 ID', () => {
    const id = buildRoutingUserId('3f2c9a10-7d4e-4b8a-9c61-5e0f1a2b3c4d', 0)
    const match = CCH_LEGACY_PATTERN.exec(id)
    expect(match).not.toBeNull()
    expect(match![2]).toBe('3f2c9a10-7d4e-4b8a-9c61-5e0f1a2b3c4d')
  })

  test('Given epoch 2 When 构造 user_id Then 会话段带 .r2 后缀，CCH 视角是一个全新会话', () => {
    const id = buildRoutingUserId('abc-123', 2)
    const match = CCH_LEGACY_PATTERN.exec(id)
    expect(match).not.toBeNull()
    expect(match![2]).toBe('abc-123.r2')
    expect(match![2]).not.toBe('abc-123')
  })

  test('Given 不同 epoch When 构造 user_id Then 身份互不相同（保证换绑生效）', () => {
    const ids = [0, 1, 2, 3].map((epoch) => buildRoutingUserId('s', epoch))
    expect(new Set(ids).size).toBe(4)
  })

  describe('isCountableFailure：判定不依赖错误分类文案，只排除用户停止（双保险）', () => {
    test('Given 各类失败（503 死绑原文/529/429/400/无文案未知） Then 一律计入连续失败', () => {
      expect(isCountableFailure('status_code=503, 所有供应商暂时不可用，请稍后重试 (cch_session_id: 01a00cab)')).toBe(true)
      expect(isCountableFailure('Error 529 {"type":"overloaded_error"}')).toBe(true)
      expect(isCountableFailure('429 rate_limit_error: Too Many Requests')).toBe(true)
      expect(isCountableFailure('400 invalid_request_error')).toBe(true)
      expect(isCountableFailure('read ECONNRESET')).toBe(true)
      expect(isCountableFailure(undefined)).toBe(true)
      expect(isCountableFailure('')).toBe(true)
    })

    test('Given 用户主动停止的文案 Then 不算失败（主判定在 stopReason=aborted，这里是双保险）', () => {
      expect(isCountableFailure('Request was aborted')).toBe(false)
      expect(isCountableFailure('The operation was aborted')).toBe(false)
    })
  })

  describe('createRoutingEpochStore：统一连续阈值（前 2 次保缓存，第 3 次换路由）', () => {
    test('Given 阈值常量 Then 为 3（前 2 次原地重试保 prompt cache）', () => {
      expect(CONSECUTIVE_FAILURES_BEFORE_REROUTE).toBe(3)
    })

    test('Given 连续失败 When 第 1、2 次 Then 不换身份；第 3 次 Then 推进并清零计数', () => {
      const store = createRoutingEpochStore()
      expect(store.recordFailure('a')).toEqual({ advanced: false, epoch: 0, consecutiveFailures: 1 })
      expect(store.recordFailure('a')).toEqual({ advanced: false, epoch: 0, consecutiveFailures: 2 })
      expect(store.recordFailure('a')).toEqual({ advanced: true, epoch: 1, consecutiveFailures: 0 })
    })

    test('Given 失败 2 次后成功（偶发抖动救回来了） Then 计数清零、epoch 保持 0、缓存身份不变', () => {
      const store = createRoutingEpochStore()
      store.recordFailure('a')
      store.recordFailure('a')
      store.recordSuccess('a')
      expect(store.get('a')).toBe(0)
      const next = store.recordFailure('a')
      expect(next.advanced).toBe(false)
      expect(next.consecutiveFailures).toBe(1)
    })

    test('Given 推进后再失败 Then 从 1 重新数起，需再连续 3 次才二次推进（Pi 预算 8 次内可完成两轮）', () => {
      const store = createRoutingEpochStore()
      store.recordFailure('a')
      store.recordFailure('a')
      store.recordFailure('a')                    // epoch 1
      expect(store.recordFailure('a').advanced).toBe(false)
      expect(store.recordFailure('a').advanced).toBe(false)
      const second = store.recordFailure('a')     // epoch 2
      expect(second.advanced).toBe(true)
      expect(second.epoch).toBe(2)
    })

    test('Given 多个会话 Then 计数与 epoch 互相隔离；clear 归零', () => {
      const store = createRoutingEpochStore()
      store.recordFailure('a')
      store.recordFailure('a')
      expect(store.recordFailure('b').consecutiveFailures).toBe(1)
      expect(store.recordFailure('a').advanced).toBe(true)
      expect(store.get('a')).toBe(1)
      expect(store.get('b')).toBe(0)
      store.clear('a')
      expect(store.get('a')).toBe(0)
    })
  })

  describe('injectRoutingIdentity', () => {
    const legacyIdentity = {
      metadataUserId: 'user_canopy_account__session_s1',
      sessionHeaderId: 'user_canopy_account__session_s1',
    }

    test('Given 空 options When 注入 Then metadata.user_id 与 x-session-id header 同时就位', () => {
      const result = injectRoutingIdentity(undefined, legacyIdentity)
      expect((result.metadata as Record<string, unknown>).user_id).toBe('user_canopy_account__session_s1')
      expect((result.headers as Record<string, string>)['x-session-id']).toBe('user_canopy_account__session_s1')
    })

    test('Given 既有 headers/metadata When 注入 Then 原有键保留、同名键以既有值优先（尊重上游未来自带的身份）', () => {
      const result = injectRoutingIdentity(
        {
          apiKey: 'k',
          headers: { authorization: 'Bearer x', 'x-session-id': 'upstream-id' },
          metadata: { user_id: 'upstream-user' },
        } as never,
        legacyIdentity,
      )
      expect((result.headers as Record<string, string>).authorization).toBe('Bearer x')
      expect((result.headers as Record<string, string>)['x-session-id']).toBe('upstream-id')
      expect((result.metadata as Record<string, unknown>).user_id).toBe('upstream-user')
      expect((result as { apiKey?: string }).apiKey).toBe('k')
    })

  })

  describe('buildRoutingIdentity：header 恒走 legacy 形态（两个发行版共有）', () => {
    test('Given 任意渠道 When 构造身份 Then header 是可被 CCH 解析的 legacy 串', () => {
      const identity = buildRoutingIdentity('s1', 0)
      expect(identity.sessionHeaderId).toBe('user_canopy_account__session_s1')
      expect(CCH_LEGACY_PATTERN.exec(identity.sessionHeaderId)).not.toBeNull()
    })

    test('Given 连续换代 When 构造身份 Then 每一代的两条通道都各自互不相同（换绑在两侧都生效）', () => {
      const identities = [0, 1, 2].map((epoch) => buildRoutingIdentity('s', epoch))
      expect(new Set(identities.map((i) => i.metadataUserId)).size).toBe(3)
      expect(new Set(identities.map((i) => i.sessionHeaderId)).size).toBe(3)
    })
  })

})
