/**
 * 上下文窗口（进度环分母）的取值口径。
 *
 * 修的是维护者 2026-09-09 报的问题：会话先用 deepseek-v4-flash（窗口 1,000,000）跑过，
 * 在输入框把模型切成 gpt-5.6-sol（窗口 372,000）之后，徽标仍然按 1.0M 算——占用率、
 * 自动压缩阈值（80% · 800.0k）跟着一起错。
 *
 * 两层原因叠加：
 * 1. `sessionStreamState.contextWindow` 是**上一轮 run 实测**的值，属于上一个模型；
 * 2. `agent-atoms.ts` 里它按 `Math.max(prev, next)` 累积——那是为了防同一轮内子 Agent
 *    的小窗口把主模型的值拉低，但跨模型就成了「只增不减」，换成小窗口模型永远降不下来。
 *
 * 口径：**分母跟着"下一轮将要使用的模型"走**。用户切了模型，下一条消息就用新模型，
 * 占用率与压缩阈值都该立刻按新窗口重算；上一轮的实测窗口对新模型不再成立。
 * 只有在当前模型未知时（极少数早期状态），才回落到实测值与历史消息推断。
 */

import { inferContextWindow } from '@canopy/shared'

export interface ResolveContextWindowInput {
  /** 会话下一轮将使用的模型（用户在输入框选中的那个） */
  currentModelId?: string | null
  /** 上一轮 run 上报的实测窗口 */
  reportedWindow?: number
  /** 历史消息里回推出的模型，仅在当前模型未知时兜底 */
  fallbackModelId?: string
}

/**
 * 算出该显示的上下文窗口；三路都取不到时返回 undefined（调用方据此隐藏进度环）。
 */
export function resolveDisplayContextWindow({
  currentModelId,
  reportedWindow,
  fallbackModelId,
}: ResolveContextWindowInput): number | undefined {
  // 当前模型已知 → 分母由它决定，不采信上一轮的实测值
  if (currentModelId) {
    const inferred = inferContextWindow(currentModelId)
    if (inferred !== undefined) return inferred
  }
  if (reportedWindow !== undefined) return reportedWindow
  return inferContextWindow(fallbackModelId)
}
