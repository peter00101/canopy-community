import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { resolveAppIconRelativePath } from './app-icon-path'

describe('应用图标路径解析', () => {
  test.each(['darwin', 'win32', 'linux'] as const)(
    'Given 默认变体 When 在 %s 上解析 Then 返回自带圆角几何的 icon.png',
    (platform) => {
      expect(resolveAppIconRelativePath('default', platform)).toBe('icon.png')
    },
  )

  test('Given 空变体 ID When 解析 Then 回落到默认图标', () => {
    expect(resolveAppIconRelativePath('', 'darwin')).toBe('icon.png')
  })

  test('Given 非默认变体 When 在 darwin 上解析 Then 使用 dock/ 下的圆角加工版本', () => {
    expect(resolveAppIconRelativePath('gradient', 'darwin'))
      .toBe(join('canopy-logos', 'dock', 'canopy-gradient.png'))
  })

  test.each(['win32', 'linux'] as const)(
    'Given 非默认变体 When 在 %s 上解析 Then 保持满幅方形原版',
    (platform) => {
      expect(resolveAppIconRelativePath('cyberpunk', platform))
        .toBe(join('canopy-logos', 'canopy-cyberpunk.png'))
    },
  )
})
