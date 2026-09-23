/**
 * 计划模式的 plan/ 目录写入与计划文档策略（收上游 #2018，维护者 2026-09-08 拍板）
 *
 * 曾把「plan 模式 Write/Edit 任意 .md」豁免整个删掉：模型会在用户没批准任何计划时
 * 把 test.md / 1.md 建到**用户项目里**，造成「已正常执行」的错觉。这里按上游方案以受限形式
 * 加回——仍允许写，但只能写进会话私有的 plan/ 目录（应用数据目录下，不在用户项目里），
 * 并用 realpath + 拒符号链接钉死；用户项目依旧零写入。
 *
 * 同时把三类拒绝文案并进行动指引体系：模型一被拒就知道「先把计划写进 plan/ 再重提」，
 * 而不是反复空转撞墙。
 *
 * Windows 实测结论（本机 Win11，2026-09-08，上游作者是 macOS 开发、这些都没测过）：
 * - `realpathSync` **不做大小写规范化**：传什么大小写就返回什么大小写（盘符也一样）；
 *   因此哈希复核只能拿「同一次输入解析出来的串」比对，不能跨输入比字符串。
 * - `path.relative` 对目录名与盘符**大小写不敏感**，所以模型传全大写路径照样判定为目录内。
 * - 跨盘符 `path.relative` 返回**绝对路径**，靠 `isAbsolute(relativePath)` 这一条挡住。
 * - Windows junction（`mklink /J`，普通用户即可建）：`lstat().isSymbolicLink()` 为 true、
 *   `isDirectory()` 为 false；**穿过 junction 的文件本身不是符号链接**，只有 realpath 比对
 *   才能识破逃逸——这就是 realpath 那一步不能省的原因。
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ExitPlanDocument } from '@canopy/shared'
import { PLAN_MODE_DENY_GUIDANCE, PLAN_MODE_WRITE_DENY_MESSAGE } from './agent-plan-mode-guidance'

/** 计划文档大小上限：审批预览要整文件读入并做哈希，限制在 1 MB 内 */
export const MAX_PLAN_DOCUMENT_BYTES = 1024 * 1024

function isPathInside(root: string, candidate: string, allowRoot = false): boolean {
  // Windows 的 path.relative 对盘符与目录名大小写不敏感（本机实测），跨盘符会返回绝对路径。
  const relativePath = relative(root, candidate)
  return (allowRoot && relativePath.length === 0)
    || (relativePath.length > 0
      && relativePath !== '..'
      && !relativePath.startsWith(`..${sep}`)
      && !isAbsolute(relativePath))
}

/**
 * Plan 模式的 Markdown 写入必须明确指向当前会话的 plan/ 目录。
 *
 * 相对路径由底层工具按 Agent cwd 解析，不能可靠地映射到计划目录，因此一律拒绝。
 * 已存在文件及其父目录同时以 realpath 复核，并拒绝任何符号链接（Windows 上 junction 也算），
 * 避免写入逃逸到项目或用户文件。
 */
export function isSessionPlanMarkdownPath(filePath: string, planDirectory: string | undefined): boolean {
  if (!planDirectory || typeof filePath !== 'string') return false
  if (!isAbsolute(filePath) || extname(filePath).toLowerCase() !== '.md') return false

  try {
    if (!existsSync(planDirectory) || lstatSync(planDirectory).isSymbolicLink()) return false
    const declaredPlanDirectory = resolve(planDirectory)
    const resolvedPlanDirectory = realpathSync(declaredPlanDirectory)
    const resolvedFilePath = resolve(filePath)
    if (!isPathInside(declaredPlanDirectory, resolvedFilePath)) return false

    if (existsSync(resolvedFilePath)) {
      const fileStat = lstatSync(resolvedFilePath)
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) return false
      return isPathInside(resolvedPlanDirectory, realpathSync(resolvedFilePath))
    }

    // 新文件只能创建在既有、非符号链接的 plan/ 子目录中；不允许隐式穿过符号链接父目录。
    const parentDirectory = dirname(resolvedFilePath)
    if (!existsSync(parentDirectory) || lstatSync(parentDirectory).isSymbolicLink()) return false
    return isPathInside(resolvedPlanDirectory, realpathSync(parentDirectory), true)
  } catch {
    return false
  }
}

/**
 * 把模型传来的 planFile 解析成经校验的计划文档（不存在 / 越界 / 非常规文件 / 超限 → undefined）。
 *
 * 与 `isSessionPlanMarkdownPath` 复用同一套地址判定，额外要求「文件真实存在、是常规文件、
 * 不超过 1 MB」，并算出内容哈希供批准前复核。放在策略模块而不是审批服务里，是因为
 * 口头批准路径绕过审批服务、同样需要这份校验（两条批准路径同强度）。
 */
export function resolvePlanDocument(value: unknown, planDirectory: string | undefined): ExitPlanDocument | undefined {
  if (typeof value !== 'string' || !planDirectory) return undefined
  const candidate = value.trim()
  if (!candidate || !isSessionPlanMarkdownPath(candidate, planDirectory)) return undefined

  try {
    // 写入策略允许「尚不存在」的新文件；审批要的是已落盘的文档，这里必须补一道存在性判定，
    // 否则模型传一个还没写出来的路径会走到 realpath 的 ENOENT，白刷一条错误日志。
    const declaredPath = resolve(candidate)
    if (!existsSync(declaredPath)) return undefined
    // 地址判定已保证不穿符号链接；这里的 realpath 只用于拿到规范化串。
    const resolvedFilePath = realpathSync(declaredPath)
    const fileStat = statSync(resolvedFilePath)
    if (!fileStat.isFile() || fileStat.size > MAX_PLAN_DOCUMENT_BYTES) return undefined

    return {
      filePath: resolvedFilePath,
      displayName: basename(resolvedFilePath),
      contentHash: createHash('sha256').update(readFileSync(resolvedFilePath)).digest('hex'),
    }
  } catch (error) {
    console.warn('[计划文档] 忽略无效计划文件:', error)
    return undefined
  }
}

/**
 * 批准前复核：文档必须仍在 plan/ 目录内，且内容与提交审批那一刻一致。
 *
 * 字符串比对成立的前提是 Windows 的 realpath 不改大小写（实测），所以拿同一个
 * `document.filePath` 再解析一次会得到同一个串；内容变了则哈希不同。
 *
 * `document.filePath` 是提交时 realpath 过的串，而 `planDirectory` 由调用方 `join()` 拼出、从不规范化。
 * 数据目录任一层祖先是目录链接时（用户把 `~/.canopy` 软链 / junction 到别的盘；macOS 的
 * `/var → /private/var` 同理），两者不同根，地址判定里的「声明路径包含」会把一字未改的文档判成越界，
 * 复核恒 false、用户永远批不出去。所以复核前先把 plan 目录规范化到与 `filePath` 同一口径；
 * 安全判定仍由 `isSessionPlanMarkdownPath` 的 realpath 包含把关。
 */
export function isPlanDocumentCurrent(document: ExitPlanDocument, planDirectory: string | undefined): boolean {
  const current = resolvePlanDocument(document.filePath, canonicalizePlanDirectory(planDirectory))
  return current?.filePath === document.filePath && current.contentHash === document.contentHash
}

/**
 * 复核用：把声明的 plan 目录换成 realpath。plan 目录**自身**是链接照旧拒绝（与提交阶段同口径）——
 * 否则审批期间把 plan 目录换成指向别处的链接，realpath 之后就看不出它被换过。
 */
function canonicalizePlanDirectory(planDirectory: string | undefined): string | undefined {
  if (!planDirectory) return undefined
  try {
    const declaredPlanDirectory = resolve(planDirectory)
    if (lstatSync(declaredPlanDirectory).isSymbolicLink()) return undefined
    return realpathSync(declaredPlanDirectory)
  } catch {
    return undefined
  }
}

/**
 * ExitPlanMode 缺少可用 planFile 时的拒绝文案。
 *
 * 弱模型撞墙防线：文案带上真实的 plan/ 目录绝对路径与示例文件名，并把「先写文件、再传 planFile
 * 重提」的两步说死——模型看到这条就知道唯一正道，不会反复空提 ExitPlanMode 或往项目里写。
 *
 * 注意这里**刻意不拼 `PLAN_MODE_DENY_GUIDANCE` 原文**：那句让模型「立即调用 ExitPlanMode
 * 重新提交计划」，在本场景下会诱导它跳过第 1 步继续空提，正好制造要防的死循环。
 * 结尾自带同一体系的收束句（仍在计划模式 + 唯一正道是上面两步）。
 */
export function buildPlanFileRequiredDenyMessage(planDirectory: string, reason: string): string {
  const example = join(planDirectory, 'my-plan.md')
  return [
    `${reason}。`,
    '提交计划审批的正确步骤（只有两步，请按顺序照做）：',
    `1. 用 Write 工具把完整计划写成 Markdown 文件，保存到当前会话的 plan/ 目录 \`${planDirectory}\`（例如 \`${example}\`，必须是绝对路径、以 .md 结尾、不超过 1 MB）。这是计划模式下唯一允许写入的位置，写这一个文件不需要任何批准。`,
    '2. 写完之后再次调用 ExitPlanMode，把该文件的绝对路径传入 planFile 参数，等用户在审批横幅上点击批准后再执行。',
    '你仍处于计划模式：不要跳过第 1 步直接重复调用 ExitPlanMode（没有 planFile 会被再次拒绝），也不要把计划写到项目目录或其他任何位置，更不要在获批前尝试别的写操作。',
  ].join('\n')
}

/**
 * 计划模式下 Write/Edit 落在 plan/ 目录之外时的拒绝文案。
 *
 * 区分两种意图给两条出路：写的是计划正文 → 改写到 plan/ 后传 planFile 提交；
 * 写的是执行步骤 → 沿用行动指引（重提 ExitPlanMode 等批准）。
 * 没有 plan 目录（无工作区会话）时退回原文案。
 */
export function buildPlanModeWriteDenyMessage(planDirectory: string | undefined): string {
  if (!planDirectory) return PLAN_MODE_WRITE_DENY_MESSAGE
  return `计划模式下只能把 Markdown 计划文档写入当前会话的 plan/ 目录 \`${planDirectory}\`（必须是绝对路径、以 .md 结尾，且不能经由符号链接），其他任何位置的写入都会被拒绝。如果你写的是计划正文，请改写到该目录后调用 ExitPlanMode 并传入 planFile 提交审批；如果你写的是执行步骤，${PLAN_MODE_DENY_GUIDANCE}`
}

/** 用户点击批准时发现计划文件已被改动（哈希不符）的拒绝文案 */
export function buildPlanDocumentChangedDenyMessage(displayName: string): string {
  return `计划文档 ${displayName} 在审批期间被修改或移走，用户批准的已不是当前版本，本次批准作废。请再次调用 ExitPlanMode（传入同一 planFile）重新提交审批，等用户批准后再执行；审批挂起期间不要改动该文件。`
}
