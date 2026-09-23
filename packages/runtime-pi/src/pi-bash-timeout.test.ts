import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_BASH_TIMEOUT_SECONDS,
  applyDefaultBashTimeout,
  describeDefaultBashTimeout,
  withDefaultBashTimeout,
} from './pi-bash-timeout'

describe('bash 工具默认超时兜底', () => {
  test('Given 模型没传 timeout When 补默认 Then 注入 600 秒且其余参数不变', () => {
    const params: { command: string; timeout?: number } = { command: 'sleep 99999' }
    expect(applyDefaultBashTimeout(params)).toEqual({ command: 'sleep 99999', timeout: DEFAULT_BASH_TIMEOUT_SECONDS })
    expect(DEFAULT_BASH_TIMEOUT_SECONDS).toBe(600)
  })

  test('Given 模型显式传了合法 timeout When 补默认 Then 原样保留（更大更小都尊重）', () => {
    expect(applyDefaultBashTimeout({ command: 'x', timeout: 30 })).toEqual({ command: 'x', timeout: 30 })
    expect(applyDefaultBashTimeout({ command: 'x', timeout: 3600 })).toEqual({ command: 'x', timeout: 3600 })
  })

  test('Given 非法 timeout（0 / 负数 / NaN / null） When 补默认 Then 视为未提供并注入默认', () => {
    expect(applyDefaultBashTimeout({ command: 'x', timeout: 0 }).timeout).toBe(600)
    expect(applyDefaultBashTimeout({ command: 'x', timeout: -5 }).timeout).toBe(600)
    expect(applyDefaultBashTimeout({ command: 'x', timeout: Number.NaN }).timeout).toBe(600)
    expect(applyDefaultBashTimeout({ command: 'x', timeout: null as unknown as number }).timeout).toBe(600)
  })

  test('Given bash 工具定义 When 包装 Then execute 收到补齐的 timeout、描述带默认值说明', async () => {
    const captured: { params?: { command: string; timeout?: number } } = {}
    const definition = {
      name: 'bash',
      description: 'Execute a bash command.',
      async execute(_id: string, params: { command: string; timeout?: number }): Promise<{ ok: boolean }> {
        captured.params = params
        return { ok: true }
      },
    }
    const wrapped = withDefaultBashTimeout(definition)
    await wrapped.execute('call-1', { command: 'make' })
    expect(captured.params).toEqual({ command: 'make', timeout: 600 })
    expect(wrapped.description).toContain('600 seconds')
    expect(wrapped.description.startsWith('Execute a bash command.')).toBe(true)
    // 显式 timeout 透传
    await wrapped.execute('call-2', { command: 'make', timeout: 1200 })
    expect(captured.params).toEqual({ command: 'make', timeout: 1200 })
  })

  test('Given 非 bash 工具 When 包装 Then 原样返回同一对象', () => {
    const readTool = { name: 'read', description: 'Read a file', async execute(): Promise<null> { return null } }
    expect(withDefaultBashTimeout(readTool)).toBe(readTool)
  })

  test('描述文案：把秒换算成分钟给模型看', () => {
    expect(describeDefaultBashTimeout('X', 300)).toContain('300 seconds (5 minutes)')
  })
})
