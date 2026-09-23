import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { utils, write } from '@e965/xlsx'
import { buildOfficeTools } from './office-tools'

/**
 * 旧版 .doc / .xls / .ppt 在 Agent 工具层的行为：OfficeInspect 只读三种模式、其余模式与编辑工具给出可纠正的提示，
 * 授权根判定与新格式一致。旧格式不经 OfficeCLI，所以这里不依赖内置二进制。
 */
let root: string
let workspace: string
let outside: string

type ToolResult = { content: Array<{ type: string; text: string }> }

function runTool(name: string, params: Record<string, unknown>): Promise<string> {
  const tool = buildOfficeTools({ agentCwd: workspace, allowedRoots: [] }).find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`没有工具 ${name}`)
  const execute = tool.execute as (id: string, input: unknown) => Promise<ToolResult>
  return execute('call-1', params).then((result) => result.content.map((part) => part.text).join('\n'))
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'canopy-office-tools-'))
  workspace = join(root, 'workspace')
  outside = join(root, 'outside')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(outside, { recursive: true })
  const book = utils.book_new()
  utils.book_append_sheet(book, utils.aoa_to_sheet([['城市', '金额'], ['北京', 12.5]]), '明细')
  const bytes = write(book, { bookType: 'biff8', type: 'buffer' })
  writeFileSync(join(workspace, '销售.xls'), bytes)
  writeFileSync(join(outside, '别处.xls'), bytes)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('OfficeInspect 读旧版格式', () => {
  test('Given 工作区里的 .xls（相对路径）When mode=text Then 返回单元格内容并说明只读', async () => {
    const text = await runTool('OfficeInspect', { filePath: '销售.xls', mode: 'text' })
    expect(text).toContain('Excel 97-2003')
    expect(text).toContain('"B2":"12.5"')
    expect(text).toContain('另存为 .xlsx')
  })

  test('Given .xls When 用 query / get / issues / screenshot Then 不调用 OfficeCLI，直接说明只支持哪三种模式', async () => {
    for (const mode of ['query', 'get', 'issues', 'screenshot']) {
      const text = await runTool('OfficeInspect', { filePath: '销售.xls', mode, selector: 'cell', path: '/明细/A1' })
      expect(text).toStartWith('失败：旧版 .xls 只支持 mode=text / outline / stats')
    }
  })

  test('Given 授权目录之外的 .xls When 读取 Then 与新格式一样被拒', async () => {
    const text = await runTool('OfficeInspect', { filePath: join(outside, '别处.xls'), mode: 'outline' })
    expect(text).toStartWith('失败：文件不在本次会话已授权的目录内')
  })
})

describe('工具说明（模型每轮都看得到的只有 description）', () => {
  test('Given OfficeInspect / OfficeEdit 的说明 When 读取 Then 写明旧版格式只读，且禁止用 Python / pip / LibreOffice 自行改写', () => {
    const tools = buildOfficeTools({ agentCwd: workspace, allowedRoots: [] })
    const inspect = tools.find((tool) => tool.name === 'OfficeInspect')!.description
    const edit = tools.find((tool) => tool.name === 'OfficeEdit')!.description
    expect(inspect).toContain('.doc/.xls/.ppt')
    expect(inspect).toContain('do NOT rewrite or convert it yourself with Python libraries, pip-installed packages or LibreOffice')
    expect(edit).toContain('never modify them via Python/pip/LibreOffice')
  })
})

describe('编辑工具遇到旧版格式', () => {
  test('Given .xls When OfficeEdit Then 拒绝并指向 OfficeInspect 只读与另存为 .xlsx', async () => {
    const text = await runTool('OfficeEdit', { filePath: '销售.xls', operation: 'set', path: '/明细/A1', props: { value: 'x' } })
    expect(text).toStartWith('失败：旧版 .xls 不能编辑')
    expect(text).toContain('OfficeInspect')
    expect(text).toContain('.xlsx')
  })
})
