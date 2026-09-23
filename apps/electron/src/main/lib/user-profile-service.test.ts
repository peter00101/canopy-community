import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_USER_AVATAR, DEFAULT_USER_NAME } from '../../types'
import { getUserProfile, updateUserProfile } from './user-profile-service'

let tempDir: string
let caseIndex = 0

/** 每个用例一份独立的 user-profile.json，避免用例间串状态 */
function profilePath(content?: string): string {
  caseIndex += 1
  const filePath = join(tempDir, `user-profile-${caseIndex}.json`)
  if (content !== undefined) writeFileSync(filePath, content, 'utf-8')
  return filePath
}

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'canopy-user-profile-'))
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('用户档案读取归一化', () => {
  test('给定档案文件不存在 当读取 则返回默认档案', () => {
    expect(getUserProfile(profilePath())).toEqual({
      userName: DEFAULT_USER_NAME,
      avatar: DEFAULT_USER_AVATAR,
    })
  })

  test('给定头像被写成 null、用户名被写成数字 当读取 则坏字段回落默认值而不是原样透传', () => {
    const filePath = profilePath(JSON.stringify({ userName: 42, avatar: null }))
    const profile = getUserProfile(filePath)
    expect(profile).toEqual({ userName: DEFAULT_USER_NAME, avatar: DEFAULT_USER_AVATAR })
    expect(typeof profile.avatar).toBe('string')
    expect(typeof profile.userName).toBe('string')
  })

  test('给定头像是对象、用户名是数组 当读取 则都回落默认值', () => {
    const filePath = profilePath(JSON.stringify({ userName: ['张三'], avatar: { url: 'x' } }))
    expect(getUserProfile(filePath)).toEqual({ userName: DEFAULT_USER_NAME, avatar: DEFAULT_USER_AVATAR })
  })

  test('给定文件内容是 JSON null 或数组 当读取 则返回默认档案', () => {
    expect(getUserProfile(profilePath('null'))).toEqual({ userName: DEFAULT_USER_NAME, avatar: DEFAULT_USER_AVATAR })
    expect(getUserProfile(profilePath('[1,2]'))).toEqual({ userName: DEFAULT_USER_NAME, avatar: DEFAULT_USER_AVATAR })
  })

  test('给定文件不是合法 JSON 当读取 则返回默认档案且不抛错', () => {
    expect(getUserProfile(profilePath('{ userName: '))).toEqual({
      userName: DEFAULT_USER_NAME,
      avatar: DEFAULT_USER_AVATAR,
    })
  })

  test('给定合法档案 当读取 则保留用户设置', () => {
    const filePath = profilePath(JSON.stringify({ userName: '张三', avatar: '🐱' }))
    expect(getUserProfile(filePath)).toEqual({ userName: '张三', avatar: '🐱' })
  })
})

describe('用户档案写入校验', () => {
  test('给定旧文件头像已坏 当只更新用户名 则写回的文件头像被修复为默认值', () => {
    const filePath = profilePath(JSON.stringify({ userName: '旧名字', avatar: 7 }))
    const updated = updateUserProfile({ userName: '  新名字 ' }, filePath)
    expect(updated).toEqual({ userName: '新名字', avatar: DEFAULT_USER_AVATAR })
    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual({ userName: '新名字', avatar: DEFAULT_USER_AVATAR })
  })

  test.each([
    ['头像为 null', { avatar: null }, '头像必须是非空文本'],
    ['头像为数字', { avatar: 1 }, '头像必须是非空文本'],
    ['头像为空白串', { avatar: '  ' }, '头像必须是非空文本'],
    ['用户名为对象', { userName: { a: 1 } }, '用户名必须是非空文本'],
    ['用户名为空串', { userName: '' }, '用户名必须是非空文本'],
  ])('给定更新内容%s 当写入 则拒绝且不改动文件', (_label, updates, message) => {
    const original = JSON.stringify({ userName: '张三', avatar: '🐱' })
    const filePath = profilePath(original)
    expect(() => updateUserProfile(updates, filePath)).toThrow(message)
    expect(readFileSync(filePath, 'utf-8')).toBe(original)
  })

  test.each([
    ['null', null],
    ['数组', [{ avatar: '🐱' }]],
    ['字符串', 'avatar'],
  ])('给定更新内容整体为%s 当写入 则拒绝且不创建文件', (_label, updates) => {
    const filePath = profilePath()
    expect(() => updateUserProfile(updates, filePath)).toThrow('用户档案更新内容无效')
    expect(existsSync(filePath)).toBe(false)
  })

  test('给定更新内容带未知字段 当写入 则只落盘 userName 与 avatar', () => {
    const filePath = profilePath()
    updateUserProfile({ avatar: '🦊', extra: 'should-not-persist' }, filePath)
    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual({ userName: DEFAULT_USER_NAME, avatar: '🦊' })
  })
})
