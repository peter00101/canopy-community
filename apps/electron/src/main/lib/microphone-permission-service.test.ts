/**
 * 麦克风权限服务测试
 *
 * 覆盖 Windows 权限预检（读系统隐私设置）与「请求权限 = 打开系统设置页」的行为，
 * 以及 macOS / Linux 的既有语义不回归。
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

let mediaAccessStatus: string = 'granted'
let mediaAccessError: Error | null = null
let askForMediaAccessResult = true
const openedExternalUrls: string[] = []

mock.module('electron', () => ({
  systemPreferences: {
    getMediaAccessStatus: (mediaType: string) => {
      expect(mediaType).toBe('microphone')
      if (mediaAccessError) throw mediaAccessError
      return mediaAccessStatus
    },
    askForMediaAccess: async () => askForMediaAccessResult,
  },
  shell: {
    openExternal: async (url: string) => {
      openedExternalUrls.push(url)
    },
  },
}))

const {
  checkMicrophonePermission,
  requestMicrophonePermission,
  WINDOWS_MICROPHONE_PRIVACY_SETTINGS_URL,
} = await import('./microphone-permission-service')

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

beforeEach(() => {
  mediaAccessStatus = 'granted'
  mediaAccessError = null
  askForMediaAccessResult = true
  openedExternalUrls.length = 0
})

afterAll(() => {
  setPlatform(originalPlatform)
})

describe('Windows 麦克风权限预检', () => {
  test('隐私设置允许时返回 granted', () => {
    setPlatform('win32')
    mediaAccessStatus = 'granted'
    expect(checkMicrophonePermission()).toEqual({ status: 'granted', platform: 'win32' })
  })

  test('隐私设置阻止时返回 denied', () => {
    setPlatform('win32')
    mediaAccessStatus = 'denied'
    expect(checkMicrophonePermission()).toEqual({ status: 'denied', platform: 'win32' })
  })

  test('restricted 视为 denied', () => {
    setPlatform('win32')
    mediaAccessStatus = 'restricted'
    expect(checkMicrophonePermission()).toEqual({ status: 'denied', platform: 'win32' })
  })

  test('查询接口异常时回落为 unsupported，交给 getUserMedia 兜底', () => {
    setPlatform('win32')
    mediaAccessError = new Error('API not available')
    expect(checkMicrophonePermission()).toEqual({ status: 'unsupported', platform: 'win32' })
  })

  test('unknown 等异常值回落为 unsupported，避免误拦', () => {
    setPlatform('win32')
    mediaAccessStatus = 'unknown'
    expect(checkMicrophonePermission()).toEqual({ status: 'unsupported', platform: 'win32' })
  })
})

describe('Windows 请求权限 = 引导到系统设置页', () => {
  test('未授权时打开麦克风隐私设置页并返回当前状态', async () => {
    setPlatform('win32')
    mediaAccessStatus = 'denied'
    const result = await requestMicrophonePermission()
    expect(result).toEqual({ status: 'denied', platform: 'win32' })
    expect(openedExternalUrls).toEqual([WINDOWS_MICROPHONE_PRIVACY_SETTINGS_URL])
  })

  test('已授权时直接返回 granted，不打开设置页', async () => {
    setPlatform('win32')
    mediaAccessStatus = 'granted'
    const result = await requestMicrophonePermission()
    expect(result).toEqual({ status: 'granted', platform: 'win32' })
    expect(openedExternalUrls).toEqual([])
  })
})

describe('macOS 语义不回归', () => {
  test('granted 状态原样返回', () => {
    setPlatform('darwin')
    mediaAccessStatus = 'granted'
    expect(checkMicrophonePermission()).toEqual({ status: 'granted', platform: 'darwin' })
  })

  test('restricted 视为 denied', () => {
    setPlatform('darwin')
    mediaAccessStatus = 'restricted'
    expect(checkMicrophonePermission()).toEqual({ status: 'denied', platform: 'darwin' })
  })

  test('请求权限走系统授权弹窗', async () => {
    setPlatform('darwin')
    askForMediaAccessResult = false
    const result = await requestMicrophonePermission()
    expect(result).toEqual({ status: 'denied', platform: 'darwin' })
    expect(openedExternalUrls).toEqual([])
  })
})

describe('Linux 保持 unsupported', () => {
  test('检查与请求均返回 unsupported 且无副作用', async () => {
    setPlatform('linux')
    expect(checkMicrophonePermission()).toEqual({ status: 'unsupported', platform: 'linux' })
    expect(await requestMicrophonePermission()).toEqual({ status: 'unsupported', platform: 'linux' })
    expect(openedExternalUrls).toEqual([])
  })
})
