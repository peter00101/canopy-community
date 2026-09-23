/**
 * 麦克风权限服务
 *
 * 平台差异处理：
 * - macOS: systemPreferences 支持检查权限并弹出系统授权窗
 * - Windows: 可通过 systemPreferences 读取隐私设置，但系统不为桌面应用提供授权弹窗，
 *   「请求权限」的唯一途径是打开系统麦克风隐私设置页（ms-settings:privacy-microphone）
 * - Linux: 无系统级权限模型，由渲染进程 getUserMedia 直接采集
 */

import { shell, systemPreferences } from 'electron'
import type { MicPermissionResult } from '../../types'

/** Windows 麦克风隐私设置页（含「允许桌面应用访问麦克风」开关） */
export const WINDOWS_MICROPHONE_PRIVACY_SETTINGS_URL = 'ms-settings:privacy-microphone'

function getPlatform(): NodeJS.Platform {
  return process.platform
}

export function checkMicrophonePermission(): MicPermissionResult {
  const platform = getPlatform()

  if (platform === 'darwin') {
    const raw = systemPreferences.getMediaAccessStatus('microphone')
    // Electron 返回: 'granted' | 'denied' | 'not-determined' | 'restricted'
    let status: MicPermissionResult['status']
    if (raw === 'granted' || raw === 'denied' || raw === 'not-determined') {
      status = raw
    } else {
      // 'restricted' → 视为 denied（家长控制或企业策略限制）
      status = 'denied'
    }
    return { status, platform }
  }

  if (platform === 'win32') {
    // Windows 读取「设置 > 隐私和安全性 > 麦克风」的开关状态，没有 not-determined 概念。
    try {
      const raw = systemPreferences.getMediaAccessStatus('microphone')
      if (raw === 'granted') return { status: 'granted', platform }
      if (raw === 'denied' || raw === 'restricted') return { status: 'denied', platform }
      // 'unknown' 等异常值：交给 getUserMedia 兜底，避免误拦
      return { status: 'unsupported', platform }
    } catch (error) {
      console.warn('[语音输入] Windows 麦克风权限查询失败，回落为 unsupported:', error)
      return { status: 'unsupported', platform }
    }
  }

  // Linux 不支持 systemPreferences 麦克风权限查询
  return { status: 'unsupported', platform }
}

export async function requestMicrophonePermission(): Promise<MicPermissionResult> {
  const platform = getPlatform()

  if (platform === 'darwin') {
    const granted = await systemPreferences.askForMediaAccess('microphone')
    return {
      status: granted ? 'granted' : 'denied',
      platform,
    }
  }

  if (platform === 'win32') {
    // Windows 没有面向桌面应用的授权弹窗；已授权时直接返回，
    // 未授权时打开系统麦克风隐私设置页，由用户手动开启后重试。
    const current = checkMicrophonePermission()
    if (current.status === 'granted') return current
    try {
      await shell.openExternal(WINDOWS_MICROPHONE_PRIVACY_SETTINGS_URL)
    } catch (error) {
      console.error('[语音输入] 打开 Windows 麦克风隐私设置页失败:', error)
    }
    return current
  }

  // Linux 返回 unsupported，由渲染进程 getUserMedia 直接采集
  return { status: 'unsupported', platform }
}
