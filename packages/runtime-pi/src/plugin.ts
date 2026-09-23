import type { AgentProviderAdapter } from '@canopy/shared'
import type { AgentRuntimePlugin } from '@canopy/kernel'
import { PiAgentAdapter } from './pi-agent-adapter'
import { PiUtilityAdapter } from './pi-utility-adapter'

/**
 * Pi Agent Runtime 插件。
 *
 * 默认使用跨进程的 `PiUtilityAdapter`（每会话一个独立 utility process，隔离
 * 崩溃与内存占用）；`CANOPY_AGENT_RUNTIME=in-process` 或 `off` 时回退到主进程内
 * 直接跑 SDK 的 `PiAgentAdapter`——这两种拓扑都是 Pi 这一个 Runtime 插件的内部
 * 实现细节，对内核层完全透明。
 */
export function createPiRuntimePlugin(): AgentRuntimePlugin {
  return {
    id: 'pi',
    createAdapter(): AgentProviderAdapter {
      const useUtilityAgentRuntime = process.env.CANOPY_AGENT_RUNTIME !== 'in-process'
        && process.env.CANOPY_AGENT_RUNTIME !== 'off'
      return useUtilityAgentRuntime ? new PiUtilityAdapter() : new PiAgentAdapter()
    },
  }
}
