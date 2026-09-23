import { describe, expect, it } from 'bun:test'
import { getGeminiModelCapability, normalizeGeminiThinkingLevel } from './gemini-model-capabilities'
import { inferContextWindow } from './context-window'

// 上游 778df000 交付时零测试（Test plan 未勾）。这批用例钉住的是「产品级能力表」的
// 三条契约：ID 归一化、档位白名单、以及不在表内的模型必须原样放行不被误改。
describe('Gemini 3 能力表', () => {
  describe('getGeminiModelCapability：模型 ID 归一化', () => {
    it('给定表内模型 ID，当查询能力时，则返回 1M 上下文与 64K 输出', () => {
      const capability = getGeminiModelCapability('gemini-3.5-flash')
      expect(capability?.contextWindow).toBe(1_000_000)
      expect(capability?.maxOutputTokens).toBe(65_536)
    })

    it('给定带 models/ 前缀与大小写空白的 ID，当查询能力时，则归一化后仍能命中', () => {
      expect(getGeminiModelCapability('  models/Gemini-3.5-Flash  ')?.defaultThinkingLevel).toBe('medium')
    })

    it('给定不在表内的模型 ID，当查询能力时，则返回 undefined 交给旧路径', () => {
      expect(getGeminiModelCapability('gemini-2.5-flash')).toBeUndefined()
      expect(getGeminiModelCapability('gpt-6-astra')).toBeUndefined()
      expect(getGeminiModelCapability(undefined)).toBeUndefined()
    })
  })

  describe('档位白名单：哪些模型不支持 minimal', () => {
    it('给定 3.7 / 3.8 flash 与 3.1 pro，当读取档位时，则不含 minimal', () => {
      for (const id of ['gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-3.1-pro']) {
        expect(getGeminiModelCapability(id)?.thinkingLevels).not.toContain('minimal')
      }
    })

    it('给定 flash / flash-lite 系列，当读取档位时，则四档齐全', () => {
      for (const id of ['gemini-3-flash-preview', 'gemini-3.5-flash', 'gemini-3.5-flash-lite']) {
        expect(getGeminiModelCapability(id)?.thinkingLevels).toEqual(['minimal', 'low', 'medium', 'high'])
      }
    })

    it('给定表内每个模型，当校验默认档位时，则默认档位必在自身白名单内', () => {
      for (const id of ['gemini-3-flash-preview', 'gemini-3.1-pro', 'gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash']) {
        const capability = getGeminiModelCapability(id)
        expect(capability).toBeDefined()
        expect(capability!.thinkingLevels).toContain(capability!.defaultThinkingLevel)
      }
    })
  })

  describe('normalizeGeminiThinkingLevel：非法档位回落', () => {
    it('给定模型支持的档位，当归一化时，则原样返回', () => {
      expect(normalizeGeminiThinkingLevel('gemini-3.5-flash', 'low')).toBe('low')
    })

    it('给定该模型不支持的 minimal，当归一化时，则回落到它的默认档位', () => {
      expect(normalizeGeminiThinkingLevel('gemini-3.7-flash', 'minimal')).toBe('medium')
      expect(normalizeGeminiThinkingLevel('gemini-3.1-pro', 'minimal')).toBe('high')
    })

    it('给定表内模型但未指定档位，当归一化时，则补上默认档位', () => {
      expect(normalizeGeminiThinkingLevel('gemini-3.1-flash-lite', undefined)).toBe('minimal')
    })

    it('给定不在表内的模型，当归一化时，则原样透传（含 undefined），不替用户做主', () => {
      expect(normalizeGeminiThinkingLevel('gemini-2.5-flash', 'minimal')).toBe('minimal')
      expect(normalizeGeminiThinkingLevel('gemini-2.5-flash', undefined)).toBeUndefined()
    })
  })

  describe('与上下文窗口推断的一致性', () => {
    it('给定表内 Gemini 3 文本模型，当推断上下文窗口时，则与能力表同为 1M', () => {
      expect(inferContextWindow('gemini-3.5-flash')).toBe(getGeminiModelCapability('gemini-3.5-flash')!.contextWindow)
    })

    it('给定我方 gpt-6-astra，当推断上下文窗口时，则仍是 372,000 不被 Gemini 规则改写', () => {
      expect(inferContextWindow('gpt-6-astra')).toBe(372_000)
    })
  })
})
