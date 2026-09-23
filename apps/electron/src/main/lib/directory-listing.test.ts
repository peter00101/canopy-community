import { describe, expect, test } from 'bun:test'
import type { Dirent, Stats } from 'node:fs'
import { listShallowDirectory } from './directory-listing'

function dirent(name: string, isDirectory = false): Dirent {
  return { name, isDirectory: () => isDirectory } as unknown as Dirent
}

function codedError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

function fakeFs(items: Dirent[], statErrors: Record<string, string> = {}) {
  return {
    readdirSync: () => items,
    statSync: (path: string): Stats => {
      const name = path.split(/[\\/]/).pop() ?? ''
      const code = statErrors[name]
      if (code) throw codedError(code)
      return { size: name.length } as Stats
    },
  }
}

describe('listShallowDirectory · 临时 / 锁文件不展示', () => {
  test('给定目录里夹着 Office 锁文件、LibreOffice 锁文件与 .tmp，当列出时，则只剩正常条目', () => {
    const entries = listShallowDirectory('/proj', fakeFs([
      dirent('报告.docx'),
      dirent('~$报告.docx'),
      dirent('.~lock.报告.docx#'),
      dirent('ckpt-3.tmp'),
      dirent('run', true),
    ]))

    expect(entries.map((entry) => entry.name)).toEqual(['run', '报告.docx'])
  })

  test('给定名为 cache.tmp 的目录，当列出时，则目录照常展示（只隐藏文件）', () => {
    const entries = listShallowDirectory('/proj', fakeFs([dirent('cache.tmp', true)]))
    expect(entries.map((entry) => entry.name)).toEqual(['cache.tmp'])
  })
})

describe('listShallowDirectory · 单个条目读不到属性不拖垮整个目录', () => {
  test('给定一个文件 stat 报 EBUSY、一个报 EPERM，当列出时，则两者照常列出、没有大小，其余条目不受影响', () => {
    const entries = listShallowDirectory('/proj', fakeFs(
      [dirent('pagefile.sys'), dirent('locked.bin'), dirent('README.md')],
      { 'pagefile.sys': 'EBUSY', 'locked.bin': 'EPERM' },
    ))

    expect(entries.map((entry) => [entry.name, entry.size])).toEqual([
      ['locked.bin', undefined],
      ['pagefile.sys', undefined],
      ['README.md', 9],
    ])
  })

  test('给定条目在 readdir 与 stat 之间消失（ENOENT），当列出时，则跳过该条目', () => {
    const entries = listShallowDirectory('/proj', fakeFs([dirent('gone.md'), dirent('a.md')], { 'gone.md': 'ENOENT' }))
    expect(entries.map((entry) => entry.name)).toEqual(['a.md'])
  })

  test('给定 stat 报其他未知错误，当列出时，则仍然抛出，不静默吞掉', () => {
    expect(() => listShallowDirectory('/proj', fakeFs([dirent('x.md')], { 'x.md': 'EIO' }))).toThrow('EIO')
  })
})
