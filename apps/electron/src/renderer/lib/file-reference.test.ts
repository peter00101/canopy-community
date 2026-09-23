import { describe, expect, test } from 'bun:test'
import { CANOPY_BRAND } from '@canopy/brand'
import {
  buildFilePathChipTitle,
  isAbsoluteFilePath,
  isLocalFileReference,
  isRelativeFilePath,
  mergeCandidateBasePaths,
  resolveInlineFileReference,
} from './file-reference'

// 源码里不直接写反斜杠字面量（历史上被工具转义坑过），统一用 BS 拼 Windows 路径
const BS = String.fromCharCode(92)
const win = (...segments: string[]): string => segments.join(BS)

describe('isRelativeFilePath —— 正文里的裸文件名会被识别成文件引用（issue #1691 的触发点）', () => {
  test('Given 反引号里的裸 .md 文件名 When 判定 Then 视为相对文件路径', () => {
    expect(isRelativeFilePath('windows-software-install.md')).toBe(true)
    expect(isRelativeFilePath('user-profile.md')).toBe(true)
  })

  test('Given 带子目录 / 反斜杠 / 行号后缀的相对路径 When 判定 Then 同样识别', () => {
    expect(isRelativeFilePath('docs/guide.md')).toBe(true)
    expect(isRelativeFilePath(win('src', 'lib', 'index.ts'))).toBe(true)
    expect(isRelativeFilePath('src/lib/index.ts:42:7')).toBe(true)
  })

  test('Given 命令、变量、含空格文本、点开头隐藏文件 When 判定 Then 不当成文件', () => {
    expect(isRelativeFilePath('npm install')).toBe(false)
    expect(isRelativeFilePath('MAX_RETRIES')).toBe(false)
    expect(isRelativeFilePath('.gitignore')).toBe(false)
    expect(isRelativeFilePath('a b.md')).toBe(false)
  })
})

describe('isAbsoluteFilePath', () => {
  test('Given Windows 盘符路径与 POSIX 多级路径 When 判定 Then 为绝对路径', () => {
    expect(isAbsoluteFilePath(win('C:', 'Users', 'me', 'memory', 'a.md'))).toBe(true)
    expect(isAbsoluteFilePath('D:/work/a.md')).toBe(true)
    expect(isAbsoluteFilePath('/home/me/a.md:12')).toBe(true)
  })

  test('Given 单级 / 或正则样式 When 判定 Then 不当成绝对路径', () => {
    expect(isAbsoluteFilePath('/tmp')).toBe(false)
    expect(isAbsoluteFilePath('/foo/bar/')).toBe(false)
  })
})

describe('resolveInlineFileReference —— 本轮映射优先，会话映射兜底', () => {
  const turnGuide = win('C:', 'ws', 'session-1', 'guide.md')
  const memoryGuide = win('C:', 'ws', 'default', 'memory', 'guide.md')
  const memoryInstall = win('C:', 'ws', 'default', 'memory', 'windows-software-install.md')
  const turnMap = new Map([['guide.md', turnGuide]])
  const sessionMap = new Map([
    ['guide.md', memoryGuide],
    ['windows-software-install.md', memoryInstall],
  ])

  test('Given 本轮映射命中 When 补全 Then 用本轮的绝对路径（不被会话映射覆盖）', () => {
    expect(resolveInlineFileReference('guide.md', turnMap, sessionMap)).toBe(turnGuide)
  })

  test('Given 本轮未命中但会话映射命中（跨轮次引用早先写过的记忆文件） When 补全 Then 用会话映射的绝对路径', () => {
    expect(resolveInlineFileReference('windows-software-install.md', turnMap, sessionMap)).toBe(memoryInstall)
  })

  test('Given 带行号后缀 When 补全 Then 绝对路径后保留后缀', () => {
    expect(resolveInlineFileReference('guide.md:42:7', undefined, sessionMap)).toBe(`${memoryGuide}:42:7`)
  })

  test('Given 相对子路径 When 补全 Then 按文件名匹配', () => {
    expect(resolveInlineFileReference('notes/guide.md', turnMap, undefined)).toBe(turnGuide)
  })

  test('Given 两级映射都未命中或都为空 When 补全 Then 返回 null 让调用方原样降级', () => {
    expect(resolveInlineFileReference('other.md', turnMap, sessionMap)).toBeNull()
    expect(resolveInlineFileReference('guide.md', undefined, undefined)).toBeNull()
    expect(resolveInlineFileReference('guide.md', new Map(), new Map())).toBeNull()
  })
})

describe('buildFilePathChipTitle —— 悬停文案不能把猜测路径说成事实', () => {
  const displayPath = `${win('C:', 'ws', 'default', 'session-1')}/windows-software-install.md`
  const realPath = win('C:', 'ws', 'default', 'memory', 'windows-software-install.md')

  test('Given 已解析且主进程回传真实路径 When 取文案 Then 显示真实路径而非猜测拼接', () => {
    expect(buildFilePathChipTitle({
      status: 'resolved', isAbsolute: false, requestedPath: 'windows-software-install.md', displayPath, resolvedPath: realPath,
    })).toBe(realPath)
  })

  test('Given 已解析但旧版主进程未回传路径 When 取文案 Then 回落到展示路径', () => {
    expect(buildFilePathChipTitle({ status: 'resolved', isAbsolute: false, requestedPath: 'a.md', displayPath, resolvedPath: '' }))
      .toBe(displayPath)
  })

  test('Given 相对引用未找到 When 取文案 Then 说「未找到」并给出裸引用，不说「文件不存在: <猜的路径>」', () => {
    const title = buildFilePathChipTitle({ status: 'broken', isAbsolute: false, requestedPath: 'windows-software-install.md', displayPath, resolvedPath: null })
    expect(title.startsWith('未找到文件: windows-software-install.md')).toBe(true)
    expect(title.includes('文件不存在')).toBe(false)
    expect(title.includes(displayPath)).toBe(false)
  })

  test('Given 绝对路径不存在 When 取文案 Then 明确说文件不存在并给出该路径', () => {
    const gone = win('C:', 'x', 'gone.md')
    expect(buildFilePathChipTitle({ status: 'broken', isAbsolute: true, requestedPath: gone, displayPath: gone, resolvedPath: null }))
      .toBe(`文件不存在: ${gone}`)
  })

  test('Given 尚未检查 When 取文案 Then 显示展示路径', () => {
    expect(buildFilePathChipTitle({ status: 'idle', isAbsolute: false, requestedPath: 'a.md', displayPath })).toBe(displayPath)
  })
})

describe('mergeCandidateBasePaths —— chip 的解析基准目录（0.18.16 修「改动摘要 chip 点开说未找到」）', () => {
  const 会话工作台 = win('C:', 'Users', 'me', CANOPY_BRAND.configDirName, 'agent-workspaces', 'default', 'sess-1')
  const 项目文件根 = win('C:', 'Users', 'me', CANOPY_BRAND.configDirName, 'agent-workspaces', 'default', 'workspace-files')
  const 附加目录 = win('D:', 'notes')

  test('Given 只给了 basePath（改动摘要的老行为）When 合并上下文候选 Then 项目文件根被补进来', () => {
    expect(mergeCandidateBasePaths(会话工作台, undefined, [会话工作台, 项目文件根, 附加目录]))
      .toEqual([会话工作台, 项目文件根, 附加目录])
  })

  test('Given 调用点什么都没传（write-result 的老行为）When 合并 Then 仍拿到完整消息级候选', () => {
    expect(mergeCandidateBasePaths(undefined, undefined, [会话工作台, 项目文件根]))
      .toEqual([会话工作台, 项目文件根])
  })

  test('Given 显式 basePaths 非空 When 合并 Then 它排在上下文候选之前且不被覆盖', () => {
    expect(mergeCandidateBasePaths(undefined, [附加目录], [会话工作台, 项目文件根]))
      .toEqual([附加目录, 会话工作台, 项目文件根])
  })

  test('Given basePaths 与 basePath 同时存在 When 合并 Then basePaths 优先、basePath 不重复插入', () => {
    expect(mergeCandidateBasePaths(会话工作台, [项目文件根], [会话工作台]))
      .toEqual([项目文件根, 会话工作台])
  })

  test('Given 候选之间有重复项 When 合并 Then 去重且保持首次出现的顺序', () => {
    expect(mergeCandidateBasePaths(会话工作台, undefined, [项目文件根, 会话工作台, 项目文件根]))
      .toEqual([会话工作台, 项目文件根])
  })

  test('Given 空串与 undefined 混入 When 合并 Then 全部丢弃、不产生空候选', () => {
    expect(mergeCandidateBasePaths('', undefined, ['', 项目文件根])).toEqual([项目文件根])
    expect(mergeCandidateBasePaths(undefined, [], undefined)).toEqual([])
  })

  test('Given 没有任何候选 When 合并 Then 返回空数组（调用方据此退化为不带候选解析）', () => {
    expect(mergeCandidateBasePaths(undefined, undefined, undefined)).toEqual([])
  })
})

/**
 * 上游 #2020：Markdown 链接目标里的相对文件引用此前根本不会变成可点芯片
 * （`MarkdownLink` 只认绝对路径），点了等于没反应。这里放宽的是「链接」这一处，
 * 行内代码仍走严格的 isRelativeFilePath，避免 `v0.18.65` 之类被误判成文件。
 */
describe('isLocalFileReference —— Markdown 链接目标的宽口径文件引用判定', () => {
  test('Given 相对链接（含子目录、Unicode、空格、括号）When 判定 Then 都算本地文件引用', () => {
    expect(isLocalFileReference('workspace-files/plan/report.md')).toBe(true)
    expect(isLocalFileReference('文档/需求说明.docx')).toBe(true)
    expect(isLocalFileReference('my notes (1).md')).toBe(true)
    expect(isLocalFileReference('./README')).toBe(true)
  })

  test('Given 白名单之外的扩展名 When 判定 Then 也算（链接语义就是「打开这个文件」）', () => {
    expect(isLocalFileReference('build/app.zip')).toBe(true)
    expect(isRelativeFilePath('build/app.zip')).toBe(false)
  })

  test('Given 无扩展名的常见文件名 When 判定 Then 按文件处理', () => {
    expect(isLocalFileReference('Dockerfile')).toBe(true)
    expect(isLocalFileReference('LICENSE')).toBe(true)
    expect(isLocalFileReference('Makefile')).toBe(true)
  })

  test('Given 绝对路径 When 判定 Then 仍然算本地文件引用', () => {
    expect(isLocalFileReference(win('C:', 'Users', 'me', 'a.md'))).toBe(true)
    expect(isLocalFileReference('/home/me/a.md')).toBe(true)
  })

  test('Given URL / 协议相对地址 / 站内路由 / 锚点 When 判定 Then 不劫持为文件预览', () => {
    expect(isLocalFileReference('https://example.com/a.md')).toBe(false)
    expect(isLocalFileReference('mailto:a@b.com')).toBe(false)
    expect(isLocalFileReference('//cdn.example.com/x.js')).toBe(false)
    expect(isLocalFileReference('api/v1/users')).toBe(false)
    expect(isLocalFileReference('#section')).toBe(false)
  })

  test('Given 用 .. 上溯的相对路径 When 判定 Then 拒绝（相对引用不得跨出候选根）', () => {
    expect(isLocalFileReference('../secrets/id_rsa.txt')).toBe(false)
    expect(isLocalFileReference('docs/../../etc/hosts')).toBe(false)
  })

  test('Given 目录形态、超长文本、控制字符 When 判定 Then 一律拒绝', () => {
    expect(isLocalFileReference('docs/')).toBe(false)
    expect(isLocalFileReference('a'.repeat(4097) + '.md')).toBe(false)
    expect(isLocalFileReference(`a${String.fromCharCode(0)}b.md`)).toBe(false)
    expect(isLocalFileReference(`a${String.fromCharCode(10)}b.md`)).toBe(false)
  })

  test('Given 行内代码里常见的非文件文本 When 判定 Then 不误判', () => {
    expect(isLocalFileReference('npm install')).toBe(false)
    expect(isLocalFileReference('MAX_RETRIES')).toBe(false)
  })

  test('Given 行内代码判定 isRelativeFilePath 时 Then 口径不受本次放宽影响（版本号 / 属性访问仍不是文件）', () => {
    expect(isRelativeFilePath('v0.18.65')).toBe(false)
    expect(isRelativeFilePath('array.length')).toBe(false)
    expect(isRelativeFilePath('.gitignore')).toBe(false)
  })
})
