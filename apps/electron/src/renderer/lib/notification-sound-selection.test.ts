/**
 * 通知音效包解析的 BDD 测试（上游 #1775 换声音库，0.17.34 合入时上游未带测试）。
 *
 * 关键点：旧的 8 个单音效（ding / discord / done …）已从仓库删除，存量用户的
 * settings.json 里存的还是旧 ID。解析必须把旧 ID 映射到新音效包，否则老用户的
 * 通知音会静默失效。
 */

import { describe, expect, it } from 'bun:test'
import { getEffectiveSoundPackId, NOTIFICATION_SOUND_PACK_IDS } from './notification-sound-selection'

describe('通知音效包解析', () => {
  it('给定用户选的是新音效包 ID，当解析时，则原样返回', () => {
    for (const packId of NOTIFICATION_SOUND_PACK_IDS) {
      expect(getEffectiveSoundPackId(packId)).toBe(packId)
    }
  })

  it('给定存量用户设置里是已删除的旧音效 ID，当解析时，则映射到对应的新包（不能静默失声）', () => {
    const legacyMapping: Array<[string, string]> = [
      ['ding', 'minimal'],
      ['ding-dong', 'soft'],
      ['discord', 'arcade'],
      ['done', 'studio'],
      ['down-power', 'mechanical'],
      ['food', 'organic'],
      ['lite', 'glass'],
      ['quiet', 'zen'],
    ]

    for (const [legacy, expected] of legacyMapping) {
      expect(getEffectiveSoundPackId(legacy as never)).toBe(expected as never)
    }
  })

  it('给定设置里没写或写了不认识的值，当解析时，则回落 minimal 而不是抛错', () => {
    expect(getEffectiveSoundPackId(undefined)).toBe('minimal')
    expect(getEffectiveSoundPackId('nonexistent-pack' as never)).toBe('minimal')
  })

  it('给定音效包清单，当检查时，则 12 套主题齐全且无重复', () => {
    expect(NOTIFICATION_SOUND_PACK_IDS).toHaveLength(12)
    expect(new Set(NOTIFICATION_SOUND_PACK_IDS).size).toBe(12)
  })
})
