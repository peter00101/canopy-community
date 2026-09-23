import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_USER_AVATAR,
  DEFAULT_USER_NAME,
  normalizeUserAvatar,
  normalizeUserName,
  normalizeUserProfile,
} from './user-profile'

const DEFAULT_PROFILE = { userName: DEFAULT_USER_NAME, avatar: DEFAULT_USER_AVATAR }

describe('用户档案字段归一化', () => {
  test('给定档案字段都是合法文本 当归一化 则原样保留（去首尾空白）', () => {
    expect(normalizeUserProfile({ userName: '  张三 ', avatar: '🐱' })).toEqual({
      userName: '张三',
      avatar: '🐱',
    })
  })

  test('给定头像是 data:image 地址 当归一化 则保留完整地址', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo='
    expect(normalizeUserAvatar(dataUrl)).toBe(dataUrl)
  })

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['数字', 42],
    ['布尔', true],
    ['对象', { emoji: '🐱' }],
    ['数组', ['🐱']],
    ['空串', ''],
    ['纯空白', '   \n\t'],
  ])('给定头像为%s 当归一化 则回落默认头像', (_label, value) => {
    expect(normalizeUserAvatar(value)).toBe(DEFAULT_USER_AVATAR)
  })

  test.each([
    ['null', null],
    ['数字', 0],
    ['对象', { name: '张三' }],
    ['空串', ''],
    ['纯空白', '  '],
  ])('给定用户名为%s 当归一化 则回落默认用户名', (_label, value) => {
    expect(normalizeUserName(value)).toBe(DEFAULT_USER_NAME)
  })

  test.each([
    ['null', null],
    ['数组', [{ userName: '张三', avatar: '🐱' }]],
    ['字符串', 'user-profile'],
    ['数字', 1],
    ['空对象', {}],
  ])('给定整个档案为%s 当归一化 则得到完整默认档案', (_label, value) => {
    expect(normalizeUserProfile(value)).toEqual(DEFAULT_PROFILE)
  })

  test('给定只有一个字段坏了 当归一化 则只回落该字段、另一个保留', () => {
    expect(normalizeUserProfile({ userName: '李四', avatar: null })).toEqual({
      userName: '李四',
      avatar: DEFAULT_USER_AVATAR,
    })
    expect(normalizeUserProfile({ userName: 123, avatar: '🦊' })).toEqual({
      userName: DEFAULT_USER_NAME,
      avatar: '🦊',
    })
  })
})
