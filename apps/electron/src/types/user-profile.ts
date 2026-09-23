/**
 * 用户档案类型
 *
 * 用户名、头像、IPC 通道等定义。
 */

/** 默认用户头像 emoji */
export const DEFAULT_USER_AVATAR = '🧑‍💻'

/** 默认用户名 */
export const DEFAULT_USER_NAME = '用户'

/** 用户档案 */
export interface UserProfile {
  /** 用户名 */
  userName: string
  /** 头像（emoji 字符串 或 data:image/* base64 URL） */
  avatar: string
}

/**
 * 档案文本字段归一化：非字符串、空串或纯空白一律回落默认值，其余去掉首尾空白。
 *
 * user-profile.json 可能被手改或被旧版本写坏（avatar 为 null / 数字 / 对象），坏值原样
 * 经 IPC 进渲染层会在 UserAvatar 调 startsWith 时抛 TypeError，整页白屏且每次启动复现。
 */
function normalizeUserProfileText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed ? trimmed : fallback
}

/** 用户名归一化（坏值回落 DEFAULT_USER_NAME） */
export function normalizeUserName(value: unknown): string {
  return normalizeUserProfileText(value, DEFAULT_USER_NAME)
}

/** 头像归一化（坏值回落 DEFAULT_USER_AVATAR） */
export function normalizeUserAvatar(value: unknown): string {
  return normalizeUserProfileText(value, DEFAULT_USER_AVATAR)
}

/** 任意来源（文件 JSON / IPC 入参）的档案归一化为字段齐全、均为非空字符串的 UserProfile */
export function normalizeUserProfile(raw: unknown): UserProfile {
  const record = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  return {
    userName: normalizeUserName(record.userName),
    avatar: normalizeUserAvatar(record.avatar),
  }
}

/** 用户档案 IPC 通道 */
export const USER_PROFILE_IPC_CHANNELS = {
  GET: 'user-profile:get',
  UPDATE: 'user-profile:update',
} as const
