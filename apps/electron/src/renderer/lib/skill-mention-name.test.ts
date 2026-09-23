import { describe, expect, test } from 'bun:test'
import { EMPTY_SKILL_MENTION_NAMES, resolveSkillMentionName } from './skill-mention-name'

describe('resolveSkillMentionName 展示当前 Skill 名称', () => {
  test('Given 名称表里有该 slug When 解析 Then 显示当前名称而非目录名', () => {
    const names = new Map([['pdf-tools', 'PDF 工具箱']])
    expect(resolveSkillMentionName('pdf-tools', names)).toBe('PDF 工具箱')
  })

  test('Given Skill 已改名 When 用新的名称表解析 Then 历史消息标签跟着变', () => {
    expect(resolveSkillMentionName('pdf-tools', new Map([['pdf-tools', 'PDF 工具箱']]))).toBe('PDF 工具箱')
    expect(resolveSkillMentionName('pdf-tools', new Map([['pdf-tools', 'PDF 助手']]))).toBe('PDF 助手')
  })

  test('Given 名称表里没有该 slug（Skill 已删除）When 解析 Then 回退目录名', () => {
    const names = new Map([['other-skill', '别的技能']])
    expect(resolveSkillMentionName('pdf-tools', names)).toBe('pdf-tools')
  })

  test('Given 空名称表（尚未读取或读取失败）When 解析 Then 回退目录名', () => {
    expect(resolveSkillMentionName('pdf-tools', EMPTY_SKILL_MENTION_NAMES)).toBe('pdf-tools')
  })

  test('Given 不传名称表 When 解析 Then 默认参数同样回退目录名', () => {
    expect(resolveSkillMentionName('pdf-tools')).toBe('pdf-tools')
  })

  test('Given 名称被写成空字符串 When 解析 Then 回退目录名而不是渲染空标签', () => {
    expect(resolveSkillMentionName('pdf-tools', new Map([['pdf-tools', '']]))).toBe('pdf-tools')
  })
})
