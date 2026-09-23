import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage, SkillActivation } from '@canopy/shared'
import {
  applySkillActivationSidecar,
  copySkillActivationSidecar,
  pruneSkillActivationSidecar,
  readSkillActivationSidecar,
  removeSkillActivationSidecar,
  upsertSkillActivations,
} from './agent-session-skill-activations'

let dir: string
let sidecar: string
const skill = (slug: string): SkillActivation => ({ slug, name: slug, sources: ['read'] })
const user = (uuid: string, inline?: SkillActivation[]): SDKMessage => ({ type: 'user', uuid, message: { role: 'user', content: 'x' }, ...(inline ? { skill_activations: inline } : {}) } as unknown as SDKMessage)
const assistant = (uuid: string): SDKMessage => ({ type: 'assistant', uuid, message: { role: 'assistant', content: [] } } as unknown as SDKMessage)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canopy-skill-sidecar-'))
  sidecar = join(dir, 's.skill-activations.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('sidecar 写入 upsertSkillActivations', () => {
  test('Given 空 sidecar When 写入一条 Then 文件生成、可读回、返回 true', () => {
    expect(upsertSkillActivations(sidecar, 'u-1', [skill('pdf')])).toBe(true)
    expect(readSkillActivationSidecar(sidecar)).toEqual({ 'u-1': [skill('pdf')] })
  })

  test('Given 已有同样激活 When 再写同样内容 Then 不落盘（返回 false，mtime 不变）', async () => {
    upsertSkillActivations(sidecar, 'u-1', [skill('pdf')])
    const before = statSync(sidecar).mtimeMs
    await new Promise((r) => setTimeout(r, 15))
    expect(upsertSkillActivations(sidecar, 'u-1', [skill('pdf')])).toBe(false)
    expect(statSync(sidecar).mtimeMs).toBe(before)
  })

  test('Given 同一条消息多次激活不同 Skill When 依次写入 Then 按 slug 合并去重', () => {
    upsertSkillActivations(sidecar, 'u-1', [skill('pdf')])
    upsertSkillActivations(sidecar, 'u-1', [skill('xlsx'), skill('pdf')])
    expect(readSkillActivationSidecar(sidecar)['u-1']!.map((a) => a.slug).sort()).toEqual(['pdf', 'xlsx'])
  })

  test('Given 空激活列表 When 写入 Then 什么都不做', () => {
    expect(upsertSkillActivations(sidecar, 'u-1', [])).toBe(false)
    expect(existsSync(sidecar)).toBe(false)
  })

  test('Given 损坏的 sidecar 文件 When 读取 Then 得到空表而不是抛错', () => {
    require('node:fs').writeFileSync(sidecar, '{ 坏掉了', 'utf-8')
    expect(readSkillActivationSidecar(sidecar)).toEqual({})
  })
})

describe('读取时合并 applySkillActivationSidecar（纯函数）', () => {
  test('Given sidecar 命中 user 消息 When 合并 Then 该消息带上 skill_activations，其余消息原引用不变', () => {
    const a = assistant('a-1')
    const messages = [user('u-1'), a, user('u-2')]
    const out = applySkillActivationSidecar(messages, { 'u-1': [skill('pdf')] })
    expect((out[0] as { skill_activations?: SkillActivation[] }).skill_activations).toEqual([skill('pdf')])
    expect(out[1]).toBe(a)
    expect(out[2]).toBe(messages[2])
  })

  test('Given 旧会话 user 消息已内联 skill_activations When 与 sidecar 合并 Then 两边合并去重', () => {
    const out = applySkillActivationSidecar([user('u-1', [skill('pdf')])], { 'u-1': [skill('pdf'), skill('docx')] })
    expect((out[0] as { skill_activations: SkillActivation[] }).skill_activations.map((a) => a.slug).sort()).toEqual(['docx', 'pdf'])
  })

  test('Given sidecar 为空或没有命中 When 合并 Then 返回原数组同一引用（零开销）', () => {
    const messages = [user('u-1'), assistant('a-1')]
    expect(applySkillActivationSidecar(messages, {})).toBe(messages)
    expect(applySkillActivationSidecar(messages, { 'u-nope': [skill('pdf')] })).toBe(messages)
  })

  test('Given sidecar 里有 JSONL 中不存在的 uuid（未落盘 / 被回退 / fork 未带） When 合并 Then 静默忽略', () => {
    const out = applySkillActivationSidecar([user('u-1')], { 'ghost': [skill('pdf')] })
    expect((out[0] as { skill_activations?: unknown }).skill_activations).toBeUndefined()
  })
})

describe('修剪 / 复制 / 删除', () => {
  test('Given 回退后只保留部分 user 消息 When 修剪 Then 只留下保留 uuid 的条目', () => {
    upsertSkillActivations(sidecar, 'u-1', [skill('pdf')])
    upsertSkillActivations(sidecar, 'u-2', [skill('xlsx')])
    pruneSkillActivationSidecar(sidecar, new Set(['u-1']))
    expect(readSkillActivationSidecar(sidecar)).toEqual({ 'u-1': [skill('pdf')] })
  })

  test('Given 修剪后一条不剩 When 修剪 Then 连文件一起删掉', () => {
    upsertSkillActivations(sidecar, 'u-1', [skill('pdf')])
    pruneSkillActivationSidecar(sidecar, new Set())
    expect(existsSync(sidecar)).toBe(false)
  })

  test('Given fork 复制了部分 user 消息 When 复制 sidecar Then 目标只含被复制消息的条目', () => {
    upsertSkillActivations(sidecar, 'u-1', [skill('pdf')])
    upsertSkillActivations(sidecar, 'u-2', [skill('xlsx')])
    const dest = join(dir, 'fork.skill-activations.json')
    expect(copySkillActivationSidecar(sidecar, dest, new Set(['u-1']))).toBe(1)
    expect(readSkillActivationSidecar(dest)).toEqual({ 'u-1': [skill('pdf')] })
  })

  test('Given 删除会话 When 删 sidecar Then 主文件与 .bak 一并消失', () => {
    upsertSkillActivations(sidecar, 'u-1', [skill('pdf')])
    upsertSkillActivations(sidecar, 'u-2', [skill('xlsx')]) // 第二次写产生 .bak
    expect(existsSync(`${sidecar}.bak`)).toBe(true)
    removeSkillActivationSidecar(sidecar)
    expect(existsSync(sidecar)).toBe(false)
    expect(existsSync(`${sidecar}.bak`)).toBe(false)
  })

  test('Given sidecar 是紧凑 JSON When 看文件 Then 单行且带 version 字段', () => {
    upsertSkillActivations(sidecar, 'u-1', [skill('pdf')])
    const raw = readFileSync(sidecar, 'utf-8')
    expect(raw).not.toContain('\n')
    expect(JSON.parse(raw).version).toBe(1)
  })
})
