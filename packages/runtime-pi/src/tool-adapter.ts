import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { KernelToolDefinition } from '@canopy/kernel'

/**
 * 把中性工具定义翻译成 Pi 认识的样子。
 *
 * `sdk.defineTool()` 的真实实现是恒等函数（`@earendil-works/pi-coding-agent`
 * 的 `core/extensions/types.ts`：`export function defineTool(tool) { return tool }`，
 * 只是 TypeScript 参数类型推断的人体工学糖，没有任何运行时副作用）。`KernelToolDefinition`
 * 的字段形状本来就与 Pi 的 `ToolDefinition` 一致（`name`/`label`/`description`/
 * `promptSnippet?`/`parameters`/`execute(toolCallId, params, signal?)`），所以这里
 * 如实反映"翻译"的本质——一次按位置透传的结构转换，不做字段级手工映射。既然 `defineTool`
 * 本身不做任何事，调用方无需再持有 Pi SDK 句柄（0.18.47 第四轮审查：曾经的 `sdk` 参数是
 * `agent-orchestrator.ts` 里最后一处目录外 `@earendil-works/pi-*` 动态 import 的唯一理由）。
 */
export function adaptToolsForPi(tools: KernelToolDefinition[]): ToolDefinition[] {
  return tools.map((tool) => tool as unknown as ToolDefinition)
}
