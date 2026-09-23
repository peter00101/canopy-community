import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readJsonFileSafe,
  removeFileWithCompanions,
  writeJsonFileAtomic,
  writeTextFileAtomic,
} from './safe-file'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canopy-safe-file-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 模拟一份 N 条消息的会话 JSONL */
function jsonl(count: number, prefix = 'msg'): string {
  return Array.from({ length: count }, (_, i) => JSON.stringify({ uuid: `${prefix}-${i}`, type: 'assistant' })).join('\n') + '\n'
}

describe('writeTextFileAtomic（会话正文 JSONL 全量重写）', () => {
  test('Given 已有正文 When 全量重写为截断版 Then 旧正文完整保留在 .bak', () => {
    const file = join(dir, 'session.jsonl')
    const original = jsonl(300)
    writeFileSync(file, original, 'utf-8')

    writeTextFileAtomic(file, jsonl(50))

    expect(readFileSync(file, 'utf-8')).toBe(jsonl(50))
    expect(readFileSync(`${file}.bak`, 'utf-8')).toBe(original)
  })

  test('Given 重写后进程被杀 When 人工把 .bak 改回原名 Then 250 条被截掉的消息一条不少', () => {
    const file = join(dir, 'session.jsonl')
    const original = jsonl(300)
    writeFileSync(file, original, 'utf-8')
    writeTextFileAtomic(file, jsonl(50))
    // 「进程被杀，元数据没来得及更新」——此刻磁盘只剩截断版 + .bak

    // 人工恢复：把 .bak 的内容写回主文件（等价于 rename）
    writeFileSync(file, readFileSync(`${file}.bak`, 'utf-8'), 'utf-8')

    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(300)
    expect(JSON.parse(lines[299]!).uuid).toBe('msg-299')
  })

  test('Given 目标文件尚不存在 When 首次写入 Then 不生成 .bak（无可备份内容）且主文件正确', () => {
    const file = join(dir, 'fresh.jsonl')

    writeTextFileAtomic(file, jsonl(3))

    expect(readFileSync(file, 'utf-8')).toBe(jsonl(3))
    expect(existsSync(`${file}.bak`)).toBe(false)
  })

  test('Given 调用方写入用户可见目录 When 传 skipBackup=true Then 不产生 .bak 伴生文件', () => {
    const file = join(dir, 'MEMORY.md')
    writeFileSync(file, '# 旧', 'utf-8')

    writeTextFileAtomic(file, '# 新', true)

    expect(readFileSync(file, 'utf-8')).toBe('# 新')
    expect(readdirSync(dir)).toEqual(['MEMORY.md'])
  })

  test('Given 连续多次重写 When 检查 .bak Then 永远是上一版而非更早的版本', () => {
    const file = join(dir, 'session.jsonl')
    writeFileSync(file, jsonl(1, 'v1'), 'utf-8')
    writeTextFileAtomic(file, jsonl(1, 'v2'))
    writeTextFileAtomic(file, jsonl(1, 'v3'))

    expect(readFileSync(`${file}.bak`, 'utf-8')).toBe(jsonl(1, 'v2'))
    expect(readFileSync(file, 'utf-8')).toBe(jsonl(1, 'v3'))
  })

  test('Given 写入完成 When 检查目录 Then 不残留 .tmp 中间文件', () => {
    const file = join(dir, 'session.jsonl')
    writeFileSync(file, jsonl(2), 'utf-8')

    writeTextFileAtomic(file, jsonl(1))

    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('writeJsonFileAtomic（索引 / 配置）', () => {
  test('Given 已有索引 When 重写 Then 生成 .bak 且主文件为新内容', () => {
    const file = join(dir, 'index.json')
    writeJsonFileAtomic(file, { sessions: [1, 2, 3] })
    writeJsonFileAtomic(file, { sessions: [1] })

    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ sessions: [1] })
    expect(JSON.parse(readFileSync(`${file}.bak`, 'utf-8'))).toEqual({ sessions: [1, 2, 3] })
  })

  test('Given 任意对象 When 落盘 Then 序列化不带缩进（体积不虚增）且可被 JSON.parse 原样读回', () => {
    const file = join(dir, 'index.json')
    const data = { version: 6, sessions: [{ id: 'a', piEntryBindings: { u1: 'e1', u2: 'e2' } }] }

    writeJsonFileAtomic(file, data)

    const raw = readFileSync(file, 'utf-8')
    expect(raw).toBe(JSON.stringify(data))
    expect(raw).not.toContain('\n')
    expect(raw.length).toBeLessThan(JSON.stringify(data, null, 2).length)
    expect(JSON.parse(raw)).toEqual(data)
  })

  test('Given skipBackup=true When 重写 Then 不触碰 .bak', () => {
    const file = join(dir, 'index.json')
    writeJsonFileAtomic(file, { v: 1 })
    writeJsonFileAtomic(file, { v: 2 }) // .bak = {v:1}
    writeJsonFileAtomic(file, { v: 3 }, true)

    expect(JSON.parse(readFileSync(`${file}.bak`, 'utf-8'))).toEqual({ v: 1 })
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ v: 3 })
  })
})

describe('readJsonFileSafe（三层容错读取）', () => {
  test('Given 主文件完好 When 读取 Then 直接返回内容', () => {
    const file = join(dir, 'index.json')
    writeJsonFileAtomic(file, { ok: true })

    expect(readJsonFileSafe<{ ok: boolean }>(file)).toEqual({ ok: true })
  })

  test('Given 主文件损坏但 .tmp 完好（rename 前崩溃） When 读取 Then 用 .tmp 恢复并提升为主文件', () => {
    const file = join(dir, 'index.json')
    writeFileSync(file, '{ 半截', 'utf-8')
    writeFileSync(`${file}.tmp`, JSON.stringify({ from: 'tmp' }), 'utf-8')

    expect(readJsonFileSafe<{ from: string }>(file)).toEqual({ from: 'tmp' })
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ from: 'tmp' })
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  test('Given 主文件与 .tmp 都损坏但 .bak 完好 When 读取 Then 用 .bak 重建主文件且不覆盖 .bak', () => {
    const file = join(dir, 'index.json')
    writeFileSync(file, '', 'utf-8')
    writeFileSync(`${file}.tmp`, '{ 也坏了', 'utf-8')
    writeFileSync(`${file}.bak`, JSON.stringify({ from: 'bak' }), 'utf-8')

    expect(readJsonFileSafe<{ from: string }>(file)).toEqual({ from: 'bak' })
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ from: 'bak' })
    expect(JSON.parse(readFileSync(`${file}.bak`, 'utf-8'))).toEqual({ from: 'bak' })
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  test('Given 三份全坏或不存在 When 读取 Then 返回 null 交由上层重建', () => {
    const file = join(dir, 'index.json')
    writeFileSync(file, '{ 坏', 'utf-8')
    writeFileSync(`${file}.bak`, '也坏', 'utf-8')

    expect(readJsonFileSafe(file)).toBeNull()
    expect(readJsonFileSafe(join(dir, 'never-existed.json'))).toBeNull()
  })
})

describe('removeFileWithCompanions（删主文件连同 .bak / .tmp）', () => {
  test('Given 主文件、.bak、.tmp 同在 When 删除 Then 三个全部消失', () => {
    const file = join(dir, 'session.jsonl')
    writeFileSync(file, jsonl(2), 'utf-8')
    writeTextFileAtomic(file, jsonl(1)) // 产生 .bak
    writeFileSync(`${file}.tmp`, '半截', 'utf-8')

    removeFileWithCompanions(file)

    expect(readdirSync(dir)).toEqual([])
  })

  test('Given 主文件已不在只剩伴生文件（上次删到一半） When 删除 Then 伴生文件也被清掉且不抛错', () => {
    const file = join(dir, 'session.jsonl')
    writeFileSync(`${file}.bak`, jsonl(2), 'utf-8')

    expect(() => removeFileWithCompanions(file)).not.toThrow()
    expect(readdirSync(dir)).toEqual([])
  })
})
