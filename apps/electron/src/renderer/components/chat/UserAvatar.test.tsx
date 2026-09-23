import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_USER_AVATAR } from '../../../types'
import { UserAvatar } from './UserAvatar'

/** 模拟 user-profile.json 被写坏后经 IPC 传进来的非字符串头像 */
function renderWithRawAvatar(avatar: unknown): string {
  return renderToStaticMarkup(<UserAvatar avatar={avatar as string} size={28} />)
}

describe('用户头像坏值防御', () => {
  test.each([
    ['null', null],
    ['undefined', undefined],
    ['数字', 42],
    ['对象', { url: 'data:image/png;base64,xx' }],
    ['数组', ['🐱']],
    ['空串', ''],
  ])('给定头像为%s 当渲染 则不抛错并显示默认头像', (_label, avatar) => {
    let html = ''
    expect(() => { html = renderWithRawAvatar(avatar) }).not.toThrow()
    expect(html).toContain(DEFAULT_USER_AVATAR)
    expect(html).not.toContain('<img')
  })

  test('给定 emoji 头像 当渲染 则显示该 emoji', () => {
    const html = renderToStaticMarkup(<UserAvatar avatar="🦊" />)
    expect(html).toContain('🦊')
    expect(html).not.toContain('<img')
  })

  test('给定 data:image 头像 当渲染 则渲染为图片', () => {
    const html = renderToStaticMarkup(<UserAvatar avatar="data:image/png;base64,iVBORw0KGgo=" />)
    expect(html).toContain('<img')
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="')
  })
})
