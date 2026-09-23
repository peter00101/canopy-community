/**
 * 崩溃安全的 JSON / 文本文件读写工具
 *
 * 解决系统强制关机/崩溃时 JSON 索引文件被截断导致数据丢失的问题。
 * - 写入：write-to-temp → rename（POSIX 原子操作）+ .bak 备份
 * - 读取：主文件 → .tmp 残留 → .bak 回退，多层容错
 *
 * 关于 fsync（刻意没做）：两个写入 API 都在主进程热路径上（会话索引每轮对话都写、
 * 会话正文每次 Skill 激活都重写），Windows 上 FlushFileBuffers 是毫秒级的同步阻塞。
 * .bak 已覆盖「进程被杀 / 应用崩溃」这类现实中最常见的失败；断电级别的落盘保证是另一个
 * 需要单独权衡的决策，见 docs/architecture/00-代码审查报告.md B-1。
 */

import { closeSync, copyFileSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/**
 * 原子写入 JSON 文件：write-to-temp → rename
 * 写入前自动保留 .bak 备份
 *
 * 序列化不带缩进：这些文件全部由程序读写，缩进只会让体积虚增约 25~35%
 * （实测 agent-sessions.json 虚增 26.6%），而它每轮对话都要全量落盘。
 * 需要人眼看时用编辑器/jq 格式化即可，JSON.parse 不在乎空白。
 */
export function writeJsonFileAtomic(filePath: string, data: object, skipBackup = false): void {
  const tmpPath = filePath + '.tmp'
  const bakPath = filePath + '.bak'

  // 备份当前文件（如果存在且可读）
  if (!skipBackup && existsSync(filePath)) {
    try {
      copyFileSync(filePath, bakPath)
    } catch {
      // 备份失败不阻塞写入
    }
  }

  // 写入临时文件
  writeFileSync(tmpPath, JSON.stringify(data), 'utf-8')

  // 原子重命名（POSIX rename 是原子操作）
  renameSync(tmpPath, filePath)
}

/**
 * 原子重写文本文件（用于 JSONL 会话等非单个 JSON 文档）。
 *
/**
 * 原子重写文本文件（用于 JSONL 会话等非单个 JSON 文档）。
 *
 * 默认同样保留 .bak：它的主要用途是会话正文 JSONL 的全量重写（回退 / 删错误消息 /
 * 补写 Skill 元信息），写入后进程被杀就再也找不回旧内容——.bak 是唯一的人工回退手段
 * （JSONL 没有像 readJsonFileSafe 那样的自动回退读取，恢复靠人把 .bak 改回原名）。
 *
 * 写入**用户可见目录**（工作区根、记忆目录、Vault 笔记等 Agent / 外部程序看得到的
 * 地方）时请传 skipBackup=true：那里多出一个 .bak 会被文件浏览器 / 记忆列表 /
 * Obsidian 看到，属于污染。
 *
 * 临时文件用随机名（上游 v0.19.1 改进，防 symlink 预建）：可预测的 `<target>.tmp`
 * 可能被有目录写权限的攻击者预建成 symlink；`wx` 独占创建保证写进私有新文件，
 * rename 替换目标本身而不追随链接。随机名残留 removeFileWithCompanions 清不到
 * （它只认固定名伴生），由本函数 finally 兜底清理。
 */
export function writeTextFileAtomic(filePath: string, content: string, skipBackup = false): void {
  const bakPath = filePath + '.bak'

  if (!skipBackup && existsSync(filePath)) {
    try {
      copyFileSync(filePath, bakPath)
    } catch {
      // 备份失败不阻塞写入
    }
  }

  const parent = dirname(filePath)
  const stem = basename(filePath)
  let tmpPath: string | null = null
  let descriptor: number | null = null
  try {
    for (let attempt = 0; attempt < 16; attempt++) {
      const candidate = join(parent, `.${stem}.canopy-${randomBytes(12).toString('hex')}.tmp`)
      try {
        descriptor = openSync(candidate, 'wx', 0o600)
        tmpPath = candidate
        break
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') continue
        throw error
      }
    }
    if (descriptor === null || tmpPath === null) throw new Error(`无法为原子写入创建临时文件: ${filePath}`)
    writeFileSync(descriptor, content, 'utf-8')
    closeSync(descriptor)
    descriptor = null
    renameSync(tmpPath, filePath)
    tmpPath = null
  } finally {
    if (descriptor !== null) closeSync(descriptor)
    if (tmpPath !== null) {
      try { unlinkSync(tmpPath) } catch { /* best-effort cleanup */ }
    }
  }
}

/**
 * 删除主文件时顺带清掉它的 .bak / .tmp 伴生文件。
 * 用户删除会话时期望内容彻底消失，不能留一份备份在磁盘上。
 * 主文件不存在也照样清伴生文件（上次删到一半崩溃的残留）。失败静默。
 */
export function removeFileWithCompanions(filePath: string): void {
  for (const target of [filePath, filePath + '.bak', filePath + '.tmp']) {
    if (!existsSync(target)) continue
    try {
      unlinkSync(target)
    } catch {
      // 尽力而为，调用方不需要为清理伴生文件失败中断流程
    }
  }
}

/**
 * 安全读取 JSON 索引文件
 * 优先读主文件，损坏则尝试 .tmp / .bak，都失败返回 null
 */
export function readJsonFileSafe<T>(filePath: string): T | null {
  const tmpPath = filePath + '.tmp'
  const bakPath = filePath + '.bak'

  // 1. 尝试读取主文件
  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, 'utf-8')
      if (raw.trim().length > 0) {
        return JSON.parse(raw) as T
      }
    } catch {
      console.warn(`[数据恢复] 主索引文件损坏: ${filePath}`)
    }
  }

  // 2. 检查是否有未完成的 .tmp 文件（上次 rename 前崩溃）
  if (existsSync(tmpPath)) {
    try {
      const raw = readFileSync(tmpPath, 'utf-8')
      if (raw.trim().length > 0) {
        const parsed = JSON.parse(raw) as T
        // .tmp 有效 → 提升为主文件
        renameSync(tmpPath, filePath)
        console.log(`[数据恢复] 从 .tmp 文件恢复: ${filePath}`)
        return parsed
      }
    } catch {
      // .tmp 也损坏，继续 fallback
    }
    // 清理无效的 .tmp
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
  }

  // 3. Fallback 到 .bak
  if (existsSync(bakPath)) {
    try {
      const raw = readFileSync(bakPath, 'utf-8')
      if (raw.trim().length > 0) {
        const parsed = JSON.parse(raw) as T
        // 用 .bak 恢复主文件（跳过备份，避免用损坏的主文件覆盖好的 .bak）
        writeJsonFileAtomic(filePath, parsed as object, true)
        console.log(`[数据恢复] 从 .bak 文件恢复: ${filePath}`)
        return parsed
      }
    } catch {
      console.error(`[数据恢复] .bak 文件也损坏: ${bakPath}`)
    }
  }

  return null // 全部失败，需要上层从 JSONL 重建
}
