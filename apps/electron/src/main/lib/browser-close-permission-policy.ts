import type { AgentSendInput } from '@canopy/shared'

export type BrowserClosePermissionDecision = 'allow' | 'require-single-approval' | 'deny-unattended'

/**
 * 受管浏览器里两个会反复要求确认的操作的放行判定。
 *
 * 25 个 Browser* 工具中其余 23 个本来就直接放行；只有关闭浏览器与网页上传曾要求逐次确认。
 * 维护者 2026-09-09 决策：两者默认免确认（设置项 `browserAutoApproveEnabled`，默认开），
 * 理由是确认框出现得太频繁、打断使用。**这推翻了 08-17 那次「BrowserClose 保留需批准」的决定**
 * （当时不采上游 #1722 的免批准；#1720 首版则是需批准）。
 *
 * 关掉开关即回到逐次确认。两条边界不受开关影响：
 * - 计划模式的只读限制由 orchestrator 另行处理（plan 语义，不是"用户同不同意"的问题）
 * - 自动任务 / 委派子 Agent 仍不得关闭浏览器：那种场景下根本没有用户在场可确认，
 *   免确认等于放任无人值守的模型关掉用户正在看的页面
 */
export function resolveBrowserClosePermission(
  toolName: string,
  triggeredBy: AgentSendInput['triggeredBy'],
  autoApprove = false,
): BrowserClosePermissionDecision {
  if (toolName !== 'BrowserClose') return 'allow'
  if (triggeredBy === 'automation' || triggeredBy === 'delegation') return 'deny-unattended'
  return autoApprove ? 'allow' : 'require-single-approval'
}

/**
 * 网页上传（把本机文件选进 file input）的放行判定。
 *
 * ⚠️ 这是**外发动作且不可撤回**：站点可能立刻把文件传到第三方，模型选错文件就是数据泄露。
 * 免确认由维护者 2026-09-09 明确要求并知悉该风险；关掉开关即恢复逐次确认。
 * 与关闭浏览器不同，上传在无人值守场景下同样放行——它不像关浏览器那样会破坏用户正在看的东西，
 * 且自动任务里的上传通常正是任务本身要做的事。
 */
export function resolveBrowserUploadPermission(autoApprove = false): 'allow' | 'require-single-approval' {
  return autoApprove ? 'allow' : 'require-single-approval'
}
