import type { AgentProviderAdapter } from '@canopy/shared'

/**
 * Agent Runtime 插件契约
 *
 * 内核层通过这个接口获取一个 `AgentProviderAdapter` 实例，不知道、也不关心
 * 具体是哪个 Runtime（当前唯一实现是 `@canopy/runtime-pi` 的 Pi Agent Runtime）。
 * 只在此刻只有一个插件在用，不引入按 id 查找的注册表——等真的出现第二个
 * Runtime 插件时再加，避免为假设的未来需求设计。
 */
export interface AgentRuntimePlugin {
  readonly id: string
  createAdapter(): AgentProviderAdapter
}
