/**
 * 「在文件管理器中显示 / 打开文件所在位置」的落点判定（纯逻辑）。
 *
 * 项目记忆面板里 AGENTS.md 那一行永远渲染，哪怕文件还没创建；
 * 旧实现遇到不存在的路径只返回 false，界面上就是「点了没反应」。
 * 调用方显式要求回退时，目标不在就改为打开它**所在的那一层**文件夹——
 * 只看直接父目录，不往更上层找，免得把用户带到不相干的地方。
 * 不要求回退的调用方（消息里的文件 chip）照旧判缺失，由它自己提示「未找到文件」。
 */
import { existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export interface RevealTargetOptions {
  /** 目标不存在时，改为打开它所在的文件夹 */
  fallbackToParentFolder?: boolean
}

export type RevealTarget =
  /** 目标存在：在文件管理器里选中它 */
  | { kind: 'item'; path: string }
  /** 目标不存在但所在文件夹在：直接打开该文件夹 */
  | { kind: 'folder'; path: string }
  | { kind: 'missing' }

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function decideRevealTarget(targetPath: string, options?: RevealTargetOptions): RevealTarget {
  if (!targetPath) return { kind: 'missing' }
  if (existsSync(targetPath)) return { kind: 'item', path: targetPath }
  if (!options?.fallbackToParentFolder) return { kind: 'missing' }

  const parent = dirname(targetPath)
  if (parent !== targetPath && isDirectory(parent)) return { kind: 'folder', path: parent }
  return { kind: 'missing' }
}
