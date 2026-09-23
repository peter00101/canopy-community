import type { TSchema, Static } from 'typebox'

/**
 * 中性工具定义/结果契约
 *
 * 结构上精确匹配 Canopy 内置工具（`pi-builtin-tools.ts`/`agent-collaboration-tools.ts`/
 * `nano-banana-mcp.ts`）实际用到的 Pi `ToolDefinition`/`AgentToolResult` 字段子集——
 * 不引入 `renderCall`/`renderResult`/`prepareArguments`/`constrainedSampling`/
 * `executionMode`/`usage`/`addedToolNames`/`terminate` 等从未被使用的字段（已用
 * grep 逐个确认零使用）。
 *
 * Pi 的 `sdk.defineTool()` 本身是恒等函数（`return tool`，仅用于 TS 类型推断），
 * 所以这些工具定义天生就是 Runtime 无关的普通对象；`@canopy/runtime-pi` 的
 * `adaptToolsForPi()` 是全项目唯一还需要把它们转成 Pi 认识形状的地方。
 */

/** 工具结果里的内容块：文本或图片，字段与 Pi `TextContent`/`ImageContent` 结构一致 */
export type KernelContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

/** 工具执行结果 */
export interface KernelToolResult<T = unknown> {
  content: KernelContentBlock[]
  details: T
}

/** 中性工具定义 */
export interface KernelToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
  name: string
  label: string
  description: string
  promptSnippet?: string
  parameters: TParams
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal?: AbortSignal,
  ): Promise<KernelToolResult<TDetails>>
}
