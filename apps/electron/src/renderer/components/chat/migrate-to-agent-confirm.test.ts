import { describe, expect, test } from 'bun:test'
import { MIGRATE_TO_AGENT_CONFIRM_COPY, resolveMigrateToAgentClick } from './migrate-to-agent-confirm'

describe('消息操作栏「切换到 Agent 模式」点击判定', () => {
  test('给定已配置 Agent 渠道且未在迁移 当点击图标 则先弹二次确认而不是直接迁移', () => {
    expect(resolveMigrateToAgentClick({ migrating: false, hasAgentChannel: true })).toBe('confirm')
  })

  test('给定正在迁移 当再次点击 则忽略', () => {
    expect(resolveMigrateToAgentClick({ migrating: true, hasAgentChannel: true })).toBe('ignore')
    expect(resolveMigrateToAgentClick({ migrating: true, hasAgentChannel: false })).toBe('ignore')
  })

  test('给定未配置 Agent 渠道 当点击图标 则直接提示配置渠道、不弹确认', () => {
    expect(resolveMigrateToAgentClick({ migrating: false, hasAgentChannel: false })).toBe('need-agent-channel')
  })
})

describe('切换到 Agent 模式确认弹窗文案', () => {
  test('给定确认弹窗 当渲染 则标题为「切换到 Agent 模式？」、按钮为「取消」「切换」', () => {
    expect(MIGRATE_TO_AGENT_CONFIRM_COPY.title).toBe('切换到 Agent 模式？')
    expect(MIGRATE_TO_AGENT_CONFIRM_COPY.cancelLabel).toBe('取消')
    expect(MIGRATE_TO_AGENT_CONFIRM_COPY.confirmLabel).toBe('切换')
  })

  test('给定迁移只复制文字且不删原对话 当阅读说明 则如实说明新建会话、带上记录、原对话保留', () => {
    const { description } = MIGRATE_TO_AGENT_CONFIRM_COPY
    expect(description).toContain('新建一个 Agent 会话')
    expect(description).toContain('文字记录')
    expect(description).toContain('原 Chat 对话会保留')
  })

  test('给定品牌规范 当检查全部文案 则不出现旧品牌名', () => {
    expect(JSON.stringify(MIGRATE_TO_AGENT_CONFIRM_COPY)).not.toMatch(/pr[o]ma/i)
  })
})
