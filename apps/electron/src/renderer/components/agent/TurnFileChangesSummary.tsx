/**
 * TurnFileChangesSummary — Turn 底部文件改动汇总
 *
 * 在 AssistantTurnRenderer 的 MessageActions 之上，以 chip 横排展示本轮所有
 * 修改类工具调用（Edit / Write / MultiEdit / NotebookEdit / Office 工具族）所触及的文件。
 *
 * 子代理（Agent/Task）的修改也会冒泡到此处——因为 SDK 的子代理 assistant
 * 消息同样存在于 turn.turnMessages 中（通过 parent_tool_use_id 关联）。
 *
 * 文件 chip 直接复用 FilePathChip（与 Agent 消息中的渲染完全一致）。
 */

import * as React from 'react'
import type { SDKMessage } from '@canopy/shared'
import { FilePathChip } from '@/components/ai-elements/file-path-chip'
import { buildTurnFileNameMap, collectTurnFilePaths } from './turn-file-paths'

// 路径提取是纯逻辑，住在 turn-file-paths.ts（可单测）；这里保留原有导出，调用方不用改。
export { buildTurnFileNameMap }

export interface TurnFileChangesSummaryProps {
  turnMessages: SDKMessage[]
  basePath?: string
}

export function TurnFileChangesSummary({
  turnMessages,
  basePath,
}: TurnFileChangesSummaryProps): React.ReactElement | null {
  const paths = React.useMemo(() => collectTurnFilePaths(turnMessages), [turnMessages])

  if (paths.length === 0) return null

  return (
    <div className="pl-[46px] mt-3">
      <div className="pt-3 border-t-2 border-dashed border-border/60">
        <div className="flex flex-wrap gap-1.5">
          {paths.map((filePath) => (
            <FilePathChip key={filePath} filePath={filePath} basePath={basePath} />
          ))}
        </div>
      </div>
    </div>
  )
}
