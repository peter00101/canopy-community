/**
 * Agent 会话的 Skill 激活元信息 sidecar（0.17.24，审查报告 N-1）
 *
 * 背景：Pi 每激活一次 Skill，编排层就要把「这条 user 消息用了哪些 Skill」记下来。此前的做法是
 * 把 `skill_activations` 内联写进 JSONL 的那条 user 消息里——为了改一个字段，得把整个会话正文
 * 读出来、逐行 parse、全量重写（实测 560 轮会话 4ms、1500 轮 8ms，同步阻塞主进程），而 Skill 激活
 * 是日常每轮都在发生的事。
 *
 * 现在：写一个小的 sidecar JSON（`{id}.skill-activations.json`，按 user 消息 uuid 索引），会话正文
 * 回到真正的只追加。读取时（全量 / 分页）把 sidecar 合并回对应 user 消息，**旧会话里内联的
 * `skill_activations` 仍然认**（两边 mergeSkillActivations 合并，按 slug 去重）。
 *
 * 一致性：sidecar 里出现 JSONL 里没有的 uuid（消息尚未落盘、被回退截掉、fork 未带过去）是**允许**的，
 * 读取时找不到对应消息就静默忽略；回退 / fork / 删除会顺手修剪或复制，只是为了整洁。
 */

import type { SDKMessage, SDKUserMessage, SkillActivation } from '@canopy/shared'
import { mergeSkillActivations } from '@canopy/shared'
import { readJsonFileSafe, removeFileWithCompanions, writeJsonFileAtomic } from './safe-file'

export const SKILL_ACTIVATION_SIDECAR_VERSION = 1

export interface SkillActivationSidecar {
  version: number
  /** user 消息 uuid → 该消息触发的 Skill 激活列表 */
  byUserMessageUuid: Record<string, SkillActivation[]>
}

/** 读取 sidecar；不存在或损坏返回空表（损坏时 readJsonFileSafe 会先尝试 .tmp/.bak）。 */
export function readSkillActivationSidecar(sidecarPath: string): Record<string, SkillActivation[]> {
  const data = readJsonFileSafe<SkillActivationSidecar>(sidecarPath)
  if (!data || typeof data !== 'object' || !data.byUserMessageUuid || typeof data.byUserMessageUuid !== 'object') return {}
  return data.byUserMessageUuid
}

function writeSkillActivationSidecar(sidecarPath: string, byUserMessageUuid: Record<string, SkillActivation[]>): void {
  writeJsonFileAtomic(sidecarPath, { version: SKILL_ACTIVATION_SIDECAR_VERSION, byUserMessageUuid } satisfies SkillActivationSidecar)
}

/**
 * 合并写入某条 user 消息的激活记录。
 * @returns 是否真的写了盘（内容没变化时不写，避免无谓 IO）
 */
export function upsertSkillActivations(sidecarPath: string, userMessageUuid: string, activations: SkillActivation[]): boolean {
  if (activations.length === 0) return false
  const current = readSkillActivationSidecar(sidecarPath)
  const existing = current[userMessageUuid] ?? []
  const merged = mergeSkillActivations(existing, activations)
  if (JSON.stringify(merged) === JSON.stringify(existing)) return false
  writeSkillActivationSidecar(sidecarPath, { ...current, [userMessageUuid]: merged })
  return true
}

/**
 * 把 sidecar 合并回消息列表（纯函数）：只碰 type === 'user' 且 uuid 命中的消息，
 * 内联的旧 `skill_activations` 与 sidecar 合并去重；其余消息原样返回（保持引用）。
 */
export function applySkillActivationSidecar(messages: SDKMessage[], byUserMessageUuid: Record<string, SkillActivation[]>): SDKMessage[] {
  const uuids = Object.keys(byUserMessageUuid)
  if (uuids.length === 0) return messages
  let touched = false
  const result = messages.map((message) => {
    if (message.type !== 'user') return message
    const uuid = (message as SDKUserMessage).uuid
    if (typeof uuid !== 'string') return message
    const extra = byUserMessageUuid[uuid]
    if (!extra || extra.length === 0) return message
    const inline = (message as SDKUserMessage).skill_activations ?? []
    const merged = mergeSkillActivations(inline, extra)
    if (JSON.stringify(merged) === JSON.stringify(inline)) return message
    touched = true
    return { ...(message as SDKUserMessage), skill_activations: merged } as SDKMessage
  })
  return touched ? result : messages
}

/** 只保留给定 uuid 的条目（回退截断后修剪）；没有变化不写。 */
export function pruneSkillActivationSidecar(sidecarPath: string, keepUserMessageUuids: ReadonlySet<string>): void {
  const current = readSkillActivationSidecar(sidecarPath)
  const keys = Object.keys(current)
  if (keys.length === 0) return
  const kept = Object.fromEntries(keys.filter((uuid) => keepUserMessageUuids.has(uuid)).map((uuid) => [uuid, current[uuid]!]))
  if (Object.keys(kept).length === keys.length) return
  if (Object.keys(kept).length === 0) {
    removeFileWithCompanions(sidecarPath)
    return
  }
  writeSkillActivationSidecar(sidecarPath, kept)
}

/** fork 时把源会话里被复制过去的 user 消息对应的条目带到新会话。 */
export function copySkillActivationSidecar(sourcePath: string, destPath: string, copiedUserMessageUuids: ReadonlySet<string>): number {
  const source = readSkillActivationSidecar(sourcePath)
  const entries = Object.entries(source).filter(([uuid]) => copiedUserMessageUuids.has(uuid))
  if (entries.length === 0) return 0
  const dest = readSkillActivationSidecar(destPath)
  writeSkillActivationSidecar(destPath, { ...dest, ...Object.fromEntries(entries) })
  return entries.length
}

/** 删会话时连 sidecar（及其 .bak/.tmp）一起清。 */
export function removeSkillActivationSidecar(sidecarPath: string): void {
  removeFileWithCompanions(sidecarPath)
}
