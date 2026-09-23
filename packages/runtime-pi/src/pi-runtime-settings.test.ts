/**
 * Pi 0.86.1 运行时设置的 BDD 测试（收上游 #2081）。
 *
 * 三件事都直接用 Pi 真实实现验，不自己复刻公式：
 * 重试预算（Pi 0.86 起单次退避封顶 60 秒）、缓存预热关闭（不静默多花钱）、
 * 内置工具不带严格 JSON 采样（我方分叉：保持 0.85 的请求形状）。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { retryDelayMs } from '@earendil-works/pi-ai'
import { PI_CACHE_WARMING_MODE, PI_NATIVE_RETRY_SETTINGS, buildBuiltinToolDefinitions } from './pi-agent-adapter'

type PiSdkForTest = Parameters<typeof buildBuiltinToolDefinitions>[0]

/**
 * 按绝对路径加载 Pi 内部模块：agent-session-fork.test.ts 在模块层 mock 了 `@earendil-works/pi-coding-agent`
 * 根入口（bun 的 mock.module 是进程级的），成套连跑时按包名 import 拿到的是那份假实现（同类）。
 * 设置与工具工厂各自在独立模块里，按文件加载就是真实现。
 */
const piDist = join(dirname(require.resolve('@earendil-works/pi-coding-agent/package.json')), 'dist')

async function loadPiModule<T>(relativePath: string): Promise<T> {
  return await import(pathToFileURL(join(piDist, relativePath)).href) as T
}

async function loadRealToolFactories(): Promise<PiSdkForTest> {
  const modules = await Promise.all(['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls']
    .map((name) => loadPiModule<Record<string, unknown>>(`core/tools/${name}.js`)))
  return Object.assign({}, ...modules) as PiSdkForTest
}

describe('Pi 原生重试预算', () => {
  test('Given 14 次、基数 1 秒、单次封顶 60 秒 When 按 Pi 真实退避公式累加 Then 总预算 543 秒，任何一次都不超过 60 秒', () => {
    const delays = Array.from({ length: PI_NATIVE_RETRY_SETTINGS.maxRetries }, (_, index) => retryDelayMs(PI_NATIVE_RETRY_SETTINGS, index + 1))
    expect(delays.reduce((sum, delay) => sum + delay, 0)).toBe(543_000)
    expect(Math.max(...delays)).toBe(60_000)
  })

  test('Given 沿用 0.85 的 8 次 When 套上 0.86 的 60 秒封顶 Then 预算只剩 183 秒——这就是要抬到 14 次的原因', () => {
    const delays = Array.from({ length: 8 }, (_, index) => retryDelayMs({ baseDelayMs: 1_000, maxAgentDelayMs: 60_000 }, index + 1))
    expect(delays.reduce((sum, delay) => sum + delay, 0)).toBe(183_000)
  })
})

describe('Pi 会话设置', () => {
  test('Given 适配层传给 SettingsManager 的配置 When 由 Pi 真实实现读回 Then 缓存预热为 off、重试参数原样生效', async () => {
    const { SettingsManager } = await loadPiModule<typeof import('@earendil-works/pi-coding-agent')>('core/settings-manager.js')
    const settings = SettingsManager.inMemory({ retry: { ...PI_NATIVE_RETRY_SETTINGS }, cacheWarming: PI_CACHE_WARMING_MODE })
    expect(settings.getCacheWarmingMode()).toBe('off')
    expect(settings.getRetrySettings()).toMatchObject({ maxRetries: 14, baseDelayMs: 1_000, maxAgentDelayMs: 60_000 })
  })
})

describe('内置工具不带严格 JSON 采样（我方分叉）', () => {
  test('Given Pi 0.86 原生 read / edit / write 定义 When 查看 Then 默认声明了 strict: prefer（对照组，证明需要去掉）', async () => {
    const sdk = await loadRealToolFactories()
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'canopy-builtin-tools-')))
    try {
      for (const definition of [sdk.createReadToolDefinition(cwd), sdk.createEditToolDefinition(cwd), sdk.createWriteToolDefinition(cwd)]) {
        expect((definition as { constrainedSampling?: unknown }).constrainedSampling).toEqual({ type: 'json_schema', strict: 'prefer' })
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('Given 适配层构建的内置工具 When 逐个查看 Then 都不再带 constrainedSampling，其余字段照旧', async () => {
    const sdk = await loadRealToolFactories()
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'canopy-builtin-tools-')))
    try {
      const tools = buildBuiltinToolDefinitions(sdk, cwd, undefined, undefined)
      const names = tools.map((tool) => tool.name)
      expect(names).toEqual(expect.arrayContaining(['read', 'edit', 'write', 'grep', 'find', 'ls']))
      for (const tool of tools) {
        expect('constrainedSampling' in tool).toBe(false)
        expect(typeof tool.execute).toBe('function')
        expect(tool.parameters).toBeDefined()
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
