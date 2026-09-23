/**
 * 文件访问授权链的纯逻辑部分（防路径穿越的唯一防线）。
 *
 * 0.17.24 前这几个函数埋在 5400 行的 ipc.ts 里、未 export、零测试（审查报告 A-3）。
 * 这里只做「路径 + 授权根集合 → 允不允许」的判定，**不知道**会话/工作区/附加目录怎么来——
 * 根集合由 ipc.ts 的 getAuthorizedRoots() 收集后注入，本模块因此不依赖任何 manager，可直接
 * 用普通 Bun 测试覆盖穿越 / 符号链接 / 大小写 / 跨盘 / UNC 等形态。
 *
 * 判定口径（与抽出前逐字一致，行为零变化）：
 * 1. 目标路径必须**真实存在**——realpathSync 失败即拒绝（穿透符号链接，拿到真实落点）；
 * 2. unrestricted 时到此为止（保留「必须存在」的校验，不再按根收窄）；
 * 3. 否则真实落点必须位于任一授权根之下（根同样先 realpath；`relative()` 结果不能是 `..`、
 *    不能以 `..` + 分隔符开头、不能是绝对路径——最后一条挡住跨盘符与 UNC）。
 *
 * Agent 工具那边（pi-builtin-tools.ts）走的是同一思路的另一份实现（realpath + allowedRoots +
 * O_NOFOLLOW + TOCTOU），改这里的口径时两边要一起看。
 */

import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** 解析真实路径（穿透符号链接）；目标不存在时退化为 resolve()，供根目录归一化使用。 */
export function realpathOrResolve(path: string): string {
  try {
    return realpathSync(resolve(path))
  } catch {
    return resolve(path)
  }
}

/** 目标真实路径；不存在（或不可解析）返回 null。这是「必须存在」校验的唯一入口。 */
export function resolveExistingRealPath(filePath: string): string | null {
  try {
    return realpathSync(resolve(filePath))
  } catch {
    return null
  }
}

/**
 * `resolvedPath`（已 realpath）是否位于 `root` 之下（含等于 root 本身）。
 * root 可以是目录也可以是单个文件（附加文件即以文件为根）。
 */
export function isUnderRoot(resolvedPath: string, root: string): boolean {
  const resolvedRoot = realpathOrResolve(root)
  const relativePath = relative(resolvedRoot, resolvedPath)
  return relativePath === '' || (
    relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
  )
}

/**
 * 完整判定：路径存在 → unrestricted 直接放行 → 否则须在任一授权根之下。
 * `getRoots` 是惰性的：只有真正需要比对时才收集根集合（收集要读会话索引，别白读）。
 */
export function isPathWithinRoots(
  filePath: string,
  getRoots: () => readonly string[],
  unrestricted = false,
): boolean {
  const resolved = resolveExistingRealPath(filePath)
  if (!resolved) return false
  // 文件面板应反映 Agent 实际可访问的路径。调用方已明确开启 unrestricted 时，
  // 保留 realpath 校验以拒绝不存在的目标，但不再按会话附件重复收窄范围。
  if (unrestricted) return true
  return getRoots().some((root) => isUnderRoot(resolved, root))
}
