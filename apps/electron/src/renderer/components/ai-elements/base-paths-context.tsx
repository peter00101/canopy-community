/**
 * 消息级 basePaths 上下文 —— 把会话工作目录、项目文件根与附加目录穿透给各类文件 chip。
 *
 * 单独成文件是为了打断循环依赖：`message.tsx` 要 import `FilePathChip`，而 `FilePathChip`
 * 又要读这份上下文当候选兜底（0.18.16 修「改动摘要 chip 点开报未找到」），两者不能互相 import。
 */

import * as React from 'react'

export const BasePathsContext = React.createContext<string[] | undefined>(undefined)

/** 提供候选基准目录给所有内嵌的消息内容与文件 chip。 */
export function BasePathsProvider({
  basePaths,
  children,
}: {
  basePaths?: string[]
  children: React.ReactNode
}): React.ReactElement {
  return <BasePathsContext.Provider value={basePaths}>{children}</BasePathsContext.Provider>
}
