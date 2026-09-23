import { describe, expect, it, test } from 'bun:test'
import { classifyWorkspaceWatchFilename, shouldFlushPendingWatchEvents, shouldNotifyForWatchFilename } from './workspace-watcher-utils'

describe('待发文件变更的 debounce 兜底', () => {
  const base = { maxPending: 500, maxWaitMs: 2000 }

  test('Given 无待发事件 When 判定是否 flush Then 不发送', () => {
    expect(shouldFlushPendingWatchEvents({
      ...base, pendingCount: 0, firstPendingAt: 0, now: 999_999,
    })).toBe(false)
  })

  test('Given 刚攒了几条且时间很短 When 判定 Then 继续 debounce', () => {
    expect(shouldFlushPendingWatchEvents({
      ...base, pendingCount: 3, firstPendingAt: 1_000, now: 1_100,
    })).toBe(false)
  })

  test('Given 待发数达到上限 When 判定 Then 立即发送', () => {
    expect(shouldFlushPendingWatchEvents({
      ...base, pendingCount: 500, firstPendingAt: 1_000, now: 1_010,
    })).toBe(true)
  })

  test('Given 持续写入把 debounce 饿死 When 已等满上限 Then 立即发送', () => {
    // 这正是批量下载脚本的场景：写入间隔始终小于 debounce 窗口，
    // 纯 debounce 会一直重置定时器、待发集合无界增长。
    expect(shouldFlushPendingWatchEvents({
      ...base, pendingCount: 7, firstPendingAt: 1_000, now: 3_000,
    })).toBe(true)
  })

  test('Given 等待时间差一毫秒到上限 When 判定 Then 仍继续 debounce', () => {
    expect(shouldFlushPendingWatchEvents({
      ...base, pendingCount: 7, firstPendingAt: 1_000, now: 2_999,
    })).toBe(false)
  })
})

describe('shouldNotifyForWatchFilename · 训练项目降噪', () => {
  it('给定带后缀的虚拟环境与 site-packages 里的写入，当判定是否通知时，则都不触发刷新', () => {
    for (const path of [
      '.venv-train/Lib/site-packages/torch/__init__.py',
      'venv310/lib/python3.10/site-packages/a.py',
      'envs/site-packages/b.py',
    ]) {
      expect(shouldNotifyForWatchFilename(path)).toBe(false)
    }
  })

  it('给定临时 / 锁文件的出现与消失，当判定时，则不触发刷新；同目录正常文件照常刷新', () => {
    expect(shouldNotifyForWatchFilename('out/ckpt-12.tmp')).toBe(false)
    expect(shouldNotifyForWatchFilename('docs/~$方案.docx')).toBe(false)
    expect(shouldNotifyForWatchFilename('.~lock.方案.docx#')).toBe(false)
    expect(shouldNotifyForWatchFilename('out/ckpt.bin')).toBe(true)
    expect(shouldNotifyForWatchFilename('docs/方案.docx')).toBe(true)
  })

  it('给定名字以 venv 开头的普通文件或普通目录，当判定时，则不误伤', () => {
    expect(shouldNotifyForWatchFilename('venv.py')).toBe(true)
    expect(shouldNotifyForWatchFilename('scripts/venv_setup.sh')).toBe(true)
    expect(shouldNotifyForWatchFilename('venue/notes.md')).toBe(true)
  })
})

describe('shouldNotifyForWatchFilename', () => {
  it('refreshes only Git metadata that changes diff state', () => {
    expect(shouldNotifyForWatchFilename('.git/FETCH_HEAD')).toBe(false)
    expect(shouldNotifyForWatchFilename('.git/objects/pack/pack-a.idx')).toBe(false)
    expect(shouldNotifyForWatchFilename('.git/index')).toBe(true)
    expect(shouldNotifyForWatchFilename('.git/HEAD')).toBe(true)
    expect(shouldNotifyForWatchFilename('node_modules/.cache/index')).toBe(false)
    expect(shouldNotifyForWatchFilename('src\\components\\Button.tsx')).toBe(true)
  })

  it('ignores Python, test and build cache directories', () => {
    const noisyPaths = [
      '.venv/lib/python3.12/site-packages/pkg.py',
      'venv/Lib/site-packages/pkg.py',
      '.tox/py312/lib/pkg.py',
      '.nox/tests/lib/pkg.py',
      '__pypackages__/3.12/lib/pkg.py',
      '.pytest_cache/v/cache/lastfailed',
      '.mypy_cache/3.12/pkg.meta.json',
      '.ruff_cache/0.8.0/cache',
      '.hypothesis/examples/example.db',
      '.gradle/caches/modules-2/metadata.bin',
    ]

    for (const path of noisyPaths) {
      expect(shouldNotifyForWatchFilename(path)).toBe(false)
    }
  })

  it('keeps generic coverage and target directories observable', () => {
    expect(shouldNotifyForWatchFilename('coverage/lcov.info')).toBe(true)
    expect(shouldNotifyForWatchFilename('target/debug/generated.rs')).toBe(true)
  })

  it('normalizes Buffer filenames before filtering', () => {
    expect(shouldNotifyForWatchFilename(Buffer.from('.git/index'))).toBe(true)
    expect(shouldNotifyForWatchFilename(Buffer.from('src/file.ts'))).toBe(true)
  })

  it('ignores events without a filename instead of bypassing the noise filter', () => {
    expect(shouldNotifyForWatchFilename(null)).toBe(false)
  })
})

describe('classifyWorkspaceWatchFilename 区分能力变更与用户文件', () => {
  test('Given 工作区顶层 mcp.json When 分类 Then 判为能力变更', () => {
    expect(classifyWorkspaceWatchFilename('default/mcp.json')).toBe('capabilities')
  })

  test('Given 会话目录里的同名 mcp.json When 分类 Then 只是用户文件，不刷新能力', () => {
    // 旧逻辑用 endsWith('/mcp.json')，会把会话工作目录里用户自己的 mcp.json
    // 误判成能力变更，触发无谓的侧边栏刷新。
    expect(classifyWorkspaceWatchFilename('default/sess-20260907/mcp.json')).toBe('files')
    expect(classifyWorkspaceWatchFilename('default/sess-20260907/sub/mcp.json')).toBe('files')
  })

  test('Given 顶层 skills/ 下的 SKILL.md When 分类 Then 判为能力变更', () => {
    expect(classifyWorkspaceWatchFilename('default/skills/pdf-tools/SKILL.md')).toBe('capabilities')
  })

  test('Given 顶层 skills-inactive/ 下的 SKILL.md When 分类 Then 同样判为能力变更', () => {
    // 旧逻辑只认 '/skills/'，停用 Skill 改名后侧边栏与消息标签都不刷新。
    expect(classifyWorkspaceWatchFilename('default/skills-inactive/pdf-tools/SKILL.md')).toBe('capabilities')
  })

  test('Given 会话目录里名为 skills 的子目录 When 分类 Then 只是用户文件', () => {
    expect(classifyWorkspaceWatchFilename('default/sess-20260907/skills/notes.md')).toBe('files')
  })

  test('Given 工作区顶层 config.json When 分类 Then 完全忽略', () => {
    expect(classifyWorkspaceWatchFilename('default/config.json')).toBe(null)
  })

  test('Given 会话目录里的 config.json When 分类 Then 仍算用户文件', () => {
    expect(classifyWorkspaceWatchFilename('default/sess-20260907/config.json')).toBe('files')
  })

  test('Given 高噪声目录里的变更 When 分类 Then 完全忽略', () => {
    expect(classifyWorkspaceWatchFilename('default/sess-1/node_modules/pkg/index.js')).toBe(null)
  })

  test('Given Windows 反斜杠路径与 Buffer 文件名 When 分类 Then 归一化后仍能识别能力目录', () => {
    expect(classifyWorkspaceWatchFilename('default\\skills\\pdf-tools\\SKILL.md')).toBe('capabilities')
    expect(classifyWorkspaceWatchFilename(Buffer.from('default/mcp.json'))).toBe('capabilities')
  })

  test('Given 没有文件名的事件 When 分类 Then 返回 null', () => {
    expect(classifyWorkspaceWatchFilename(null)).toBe(null)
  })
})
