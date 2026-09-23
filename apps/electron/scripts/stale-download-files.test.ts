import { describe, expect, it } from 'bun:test'
import { isOfficeCliDirectoryClean, pickUnexpectedOfficeCliEntries } from './stale-download-files'

describe('pickUnexpectedOfficeCliEntries — OfficeCLI 资源目录残留识别', () => {
  it('Given 目录里有成品与一枚被外力打断留下的 .download-* 半成品，When 挑选，Then 只挑出半成品、成品不动', () => {
    const entries = ['officecli', 'officecli.download-90914-1788022084522']
    expect(pickUnexpectedOfficeCliEntries(entries, 'officecli')).toEqual(['officecli.download-90914-1788022084522'])
  })

  it('Given 二进制自更新留下的 .old（Windows 上运行中的映像删不掉），When 挑选，Then 认得出来', () => {
    const entries = ['officecli.exe', 'officecli.exe.old']
    expect(pickUnexpectedOfficeCliEntries(entries, 'officecli.exe')).toEqual(['officecli.exe.old'])
  })

  it('Given macOS 侧自更新留下的 officecli.old 与未提升的 .update，When 挑选，Then 两者都算残留', () => {
    const entries = ['officecli', 'officecli.old', 'officecli.update', 'officecli.update.partial']
    expect(pickUnexpectedOfficeCliEntries(entries, 'officecli')).toEqual([
      'officecli.old',
      'officecli.update',
      'officecli.update.partial',
    ])
  })

  it('Given 另一平台的产物混在目录里，When 挑选，Then 也算残留——一台机器一次只准备一个产物', () => {
    // 0.18.34 的原设计刻意「不误伤另一平台产物」，但这个目录由 prepare 独占且可再生，
    // 留着另一平台的二进制只会白白进包（mac 交叉打 x64 时换装后尤其容易残留）。
    expect(pickUnexpectedOfficeCliEntries(['officecli', 'officecli.exe'], 'officecli.exe')).toEqual(['officecli'])
  })

  it('Given 目录干净或为空，When 挑选，Then 返回空数组', () => {
    expect(pickUnexpectedOfficeCliEntries(['officecli'], 'officecli')).toEqual([])
    expect(pickUnexpectedOfficeCliEntries([], 'officecli')).toEqual([])
  })
})

describe('isOfficeCliDirectoryClean — 打包前的目录强断言', () => {
  it('Given 目录恰好只有产物本身，When 断言，Then 通过', () => {
    expect(isOfficeCliDirectoryClean(['officecli.exe'], 'officecli.exe')).toBe(true)
  })

  it('Given 目录还有别的东西，When 断言，Then 不通过（哪怕产物本身在）', () => {
    expect(isOfficeCliDirectoryClean(['officecli.exe', 'officecli.exe.old'], 'officecli.exe')).toBe(false)
  })

  it('Given 目录为空或产物缺失，When 断言，Then 不通过', () => {
    expect(isOfficeCliDirectoryClean([], 'officecli')).toBe(false)
    expect(isOfficeCliDirectoryClean(['officecli.exe'], 'officecli')).toBe(false)
  })
})
