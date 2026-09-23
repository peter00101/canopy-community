import { test, expect, describe } from 'bun:test'
import { stripInvisibleCharacters, sanitizeChannelModels } from './sanitize-model-text'
import type { ChannelModel } from '../types/channel'

// 脏字符全部用码点拼，不写字面量/转义（AI 工具链写入易折坏不可见字符）
const RLO = String.fromCharCode(0x202e) // U+202E RIGHT-TO-LEFT OVERRIDE，维护者报障的元凶
const LRM = String.fromCharCode(0x200e) // U+200E LEFT-TO-RIGHT MARK
const ZWSP = String.fromCharCode(0x200b) // U+200B 零宽空格
const ZWJ = String.fromCharCode(0x200d) // U+200D 零宽连字
const BOM = String.fromCharCode(0xfeff) // U+FEFF BOM
const SHY = String.fromCharCode(0x00ad) // U+00AD 软连字符
const NUL = String.fromCharCode(0x0000) // U+0000 C0 控制符
const C1 = String.fromCharCode(0x0085) // U+0085 C1 控制符（NEL）
const ALM = String.fromCharCode(0x061c) // U+061C 阿拉伯字母标记
const FSI = String.fromCharCode(0x2068) // U+2068 bidi 隔离符
const PDI = String.fromCharCode(0x2069) // U+2069 bidi 隔离符

function makeModel(overrides: Partial<ChannelModel>): ChannelModel {
  return { id: 'clean-model', name: 'Clean Model', enabled: true, ...overrides }
}

describe('stripInvisibleCharacters', () => {
  test('Given 内嵌 U+202E RLO 的模型 id（维护者报障场景），When 清洗，Then 得到无控制符的干净 id', () => {
    // 服务端实测返回形态：claude-fable-5-dd-<RLO>Seek/gemini-3-pro，UI 上括号里呈现为镜像文字
    const dirty = 'claude-fable-5-dd-' + RLO + 'Seek/gemini-3-pro'
    const cleaned = stripInvisibleCharacters(dirty)
    expect(cleaned).toBe('claude-fable-5-dd-Seek/gemini-3-pro')
    // 逐码点确认不再含任何 bidi 控制符
    expect([...cleaned].some((ch) => ch.charCodeAt(0) === 0x202e)).toBe(false)
  })

  test('Given 含零宽系字符（ZWSP/ZWJ/BOM）的 id，When 清洗，Then 零宽字符全部剥除', () => {
    expect(stripInvisibleCharacters(ZWSP + 'gpt-5.6' + ZWJ + '-sol' + BOM)).toBe('gpt-5.6-sol')
  })

  test('Given 含 C0/C1 控制符与软连字符的 id，When 清洗，Then 控制符全部剥除', () => {
    expect(stripInvisibleCharacters(NUL + 'deep' + C1 + 'seek' + SHY + '-v4')).toBe('deepseek-v4')
  })

  test('Given 含 bidi 隔离符与 ALM/LRM 的 id，When 清洗，Then bidi 字符全部剥除', () => {
    expect(stripInvisibleCharacters(FSI + 'kimi' + ALM + '-k3' + PDI + LRM)).toBe('kimi-k3')
  })

  test('Given 首尾带空白的 id，When 清洗，Then 前后空白被 trim', () => {
    expect(stripInvisibleCharacters('  claude-opus-4-6  ')).toBe('claude-opus-4-6')
  })

  test('Given 干净的 id（对照组），When 清洗，Then 原样返回', () => {
    expect(stripInvisibleCharacters('claude-fable-5')).toBe('claude-fable-5')
  })

  test('Given 含中文与 emoji 的显示名，When 清洗，Then 正常多字节字符不受误伤', () => {
    expect(stripInvisibleCharacters('智谱 GLM-5.3 🚀')).toBe('智谱 GLM-5.3 🚀')
  })
})

describe('sanitizeChannelModels', () => {
  test('Given 拉取结果混有脏 id 与干净 id，When 清洗列表，Then 脏 id 变干净、干净条目不变', () => {
    const models = [
      makeModel({ id: 'claude-fable-5-dd-' + RLO + 'Seek/gemini-3-pro', name: 'gemini-3-pro' }),
      makeModel({ id: 'gpt-5.5', name: 'gpt-5.5' }),
    ]
    const result = sanitizeChannelModels(models)
    expect(result).toHaveLength(2)
    expect(result[0]!.id).toBe('claude-fable-5-dd-Seek/gemini-3-pro')
    expect(result[0]!.name).toBe('gemini-3-pro')
    expect(result[1]!.id).toBe('gpt-5.5')
  })

  test('Given 某条目的 id 洗后为空（全是控制符），When 清洗列表，Then 该条目被丢弃', () => {
    const models = [makeModel({ id: RLO + ZWSP + BOM, name: '幽灵模型' }), makeModel({ id: 'real-model' })]
    const result = sanitizeChannelModels(models)
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe('real-model')
  })

  test('Given 某条目的 name 洗后为空，When 清洗列表，Then name 回退为洗后的 id', () => {
    const models = [makeModel({ id: 'gpt-5.6' + ZWSP, name: ZWJ + '  ' })]
    const result = sanitizeChannelModels(models)
    expect(result[0]!.id).toBe('gpt-5.6')
    expect(result[0]!.name).toBe('gpt-5.6')
  })

  test('Given 两个条目洗后 id 相同，When 清洗列表，Then 去重且保留先出现的条目', () => {
    const models = [
      makeModel({ id: 'gpt-5.6' + ZWSP, name: '先出现' }),
      makeModel({ id: ZWJ + 'gpt-5.6', name: '后出现' }),
    ]
    const result = sanitizeChannelModels(models)
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('先出现')
  })

  test('Given 条目带 enabled 与 source 字段，When 清洗列表，Then 这些字段原样保留', () => {
    const models = [makeModel({ id: 'm1' + RLO, enabled: false, source: 'manual' })]
    const result = sanitizeChannelModels(models)
    expect(result[0]).toEqual({ id: 'm1', name: 'Clean Model', enabled: false, source: 'manual' })
  })

  test('Given 全部条目都干净（对照组），When 清洗列表，Then 内容逐项不变', () => {
    const models = [
      makeModel({ id: 'a', name: 'A' }),
      makeModel({ id: 'b', name: 'B', enabled: false, source: 'fetched' }),
    ]
    expect(sanitizeChannelModels(models)).toEqual(models)
  })
})
