import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeExistingSkillFile } from './skill-file-write'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'canopy-skill-file-write-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('writeExistingSkillFile', () => {
  test('Given 资源文件已存在，When 写入新内容，Then 文件内容被替换', () => {
    const target = join(tempDir, 'reference.md')
    writeFileSync(target, '旧内容', 'utf-8')

    writeExistingSkillFile(target, '新内容 new content')

    expect(readFileSync(target, 'utf-8')).toBe('新内容 new content')
  })

  test('Given 已存在的长文件，When 写入更短的内容，Then 旧内容不残留（截断生效）', () => {
    const target = join(tempDir, 'reference.md')
    writeFileSync(target, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'utf-8')

    writeExistingSkillFile(target, 'B')

    expect(readFileSync(target, 'utf-8')).toBe('B')
  })

  test('Given 已存在的文件，When 写入多字节 UTF-8 内容，Then 按字节长度截断且不产生乱码尾巴', () => {
    const target = join(tempDir, 'reference.md')
    writeFileSync(target, '这是一段足够长的中文原始内容，用来验证截断行为是否正确。', 'utf-8')

    writeExistingSkillFile(target, '中文短内容')

    expect(readFileSync(target, 'utf-8')).toBe('中文短内容')
  })

  test('Given 已存在的空文件，When 写入更长的内容，Then 内容完整写入', () => {
    const target = join(tempDir, 'reference.md')
    writeFileSync(target, '', 'utf-8')

    const long = 'x'.repeat(5000)
    writeExistingSkillFile(target, long)

    expect(readFileSync(target, 'utf-8')).toBe(long)
  })

  test('Given 目标路径不存在（已被外部删除或重命名），When 保存，Then 抛错且不创建该文件', () => {
    const target = join(tempDir, 'deleted.md')

    expect(() => writeExistingSkillFile(target, '不应该被写出去')).toThrow()
    expect(existsSync(target)).toBe(false)
  })

  test('Given 父目录不存在，When 保存，Then 抛错且不创建目录', () => {
    const target = join(tempDir, 'missing-dir', 'deleted.md')

    expect(() => writeExistingSkillFile(target, '不应该被写出去')).toThrow()
    expect(existsSync(join(tempDir, 'missing-dir'))).toBe(false)
  })

  test('Given 目标是目录，When 保存，Then 抛错且目录保持不变', () => {
    const target = join(tempDir, 'assets')
    mkdirSync(target)
    writeFileSync(join(target, 'keep.txt'), 'keep', 'utf-8')

    expect(() => writeExistingSkillFile(target, '不应该被写出去')).toThrow()
    expect(readFileSync(join(target, 'keep.txt'), 'utf-8')).toBe('keep')
  })
})
