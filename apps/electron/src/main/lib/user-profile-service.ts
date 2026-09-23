/**
 * 用户档案服务
 *
 * 管理用户档案（用户名 + 头像）的读写。
 * 存储在 ~/.canopy/user-profile.json
 *
 * 读写两侧都做字段归一化/校验：文件里的坏值（null、数字、对象、空串）不能原样经 IPC
 * 进渲染层——UserAvatar 渲染期会抛 TypeError，叠加每次启动都读同一份文件 = 永久白屏。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { getUserProfilePath } from './config-paths'
import { DEFAULT_USER_AVATAR, DEFAULT_USER_NAME, normalizeUserProfile } from '../../types'
import type { UserProfile } from '../../types'

/**
 * 获取用户档案
 *
 * 文件不存在、解析失败或字段非法时，对应字段回落默认值。
 */
export function getUserProfile(filePath: string = getUserProfilePath()): UserProfile {
  if (!existsSync(filePath)) {
    return {
      userName: DEFAULT_USER_NAME,
      avatar: DEFAULT_USER_AVATAR,
    }
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    return normalizeUserProfile(JSON.parse(raw))
  } catch (error) {
    console.error('[用户档案] 读取失败:', error)
    return {
      userName: DEFAULT_USER_NAME,
      avatar: DEFAULT_USER_AVATAR,
    }
  }
}

/** 校验更新字段：只接受 userName / avatar 两个非空字符串，其余键忽略，非法值直接拒绝 */
function validateUserProfileUpdates(updates: unknown): Partial<UserProfile> {
  if (updates === null || typeof updates !== 'object' || Array.isArray(updates)) {
    throw new Error('用户档案更新内容无效')
  }
  const record = updates as Record<string, unknown>
  const patch: Partial<UserProfile> = {}

  if (record.userName !== undefined) {
    if (typeof record.userName !== 'string' || !record.userName.trim()) {
      throw new Error('用户名必须是非空文本')
    }
    patch.userName = record.userName.trim()
  }

  if (record.avatar !== undefined) {
    if (typeof record.avatar !== 'string' || !record.avatar.trim()) {
      throw new Error('头像必须是非空文本')
    }
    patch.avatar = record.avatar.trim()
  }

  return patch
}

/**
 * 更新用户档案
 *
 * 校验更新字段后与（已归一化的）当前档案合并写入；旧文件里的坏字段借此自愈。
 */
export function updateUserProfile(
  updates: unknown,
  filePath: string = getUserProfilePath(),
): UserProfile {
  const patch = validateUserProfileUpdates(updates)
  const current = getUserProfile(filePath)
  const updated: UserProfile = {
    ...current,
    ...patch,
  }

  try {
    writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8')
    console.log(`[用户档案] 已更新: ${updated.userName}`)
  } catch (error) {
    console.error('[用户档案] 写入失败:', error)
    throw new Error('写入用户档案失败')
  }

  return updated
}
