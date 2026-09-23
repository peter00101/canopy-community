import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isAbsolutePreviewPath, resolveFilePath, resolveTargetPath, restrictOfficeCliHtml } from './file-preview-service'

/**
 * 复刻上游 issue #1691 的目录布局：
 *   agent-workspaces/default/{sessionId}/   会话工作台（渲染层给的首个候选目录）
 *   agent-workspaces/default/memory/        长期记忆目录（兄弟目录，Agent 用绝对路径写入）
 * Agent 正文里裸提 `windows-software-install.md` 时，只按会话工作台找不到，必须把记忆目录纳入候选。
 */
let root: string
let sessionDir: string
let memoryDir: string
const NAME = 'windows-software-install.md'

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'canopy-file-preview-'))
  const wsRoot = join(root, 'agent-workspaces', 'default')
  sessionDir = join(wsRoot, 'session-abc')
  memoryDir = join(wsRoot, 'memory')
  mkdirSync(sessionDir, { recursive: true })
  mkdirSync(memoryDir, { recursive: true })
  writeFileSync(join(memoryDir, NAME), '# 记忆', 'utf-8')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('resolveFilePath —— 裸文件名按候选目录解析', () => {
  test('Given 只有会话工作台作候选 When 解析记忆目录里的文件名 Then 找不到返回 null（issue #1691 复现）', () => {
    expect(resolveFilePath(NAME, [sessionDir])).toBeNull()
  })

  test('Given 候选目录未命中 When 取兜底路径 Then 是「首个候选目录 + 文件名」的猜测（这就是曾被当成事实展示的路径）', () => {
    expect(resolveTargetPath(NAME, [sessionDir])).toBe(join(sessionDir, NAME))
  })

  test('Given 记忆目录被追加进候选 When 解析 Then 命中记忆目录里的真实文件', () => {
    expect(resolveFilePath(NAME, [sessionDir, memoryDir])).toBe(join(memoryDir, NAME))
  })

  test('Given 会话工作台里有同名文件 When 解析 Then 会话侧优先于记忆目录', () => {
    writeFileSync(join(sessionDir, NAME), '# 会话里的同名文件', 'utf-8')
    try {
      expect(resolveFilePath(NAME, [sessionDir, memoryDir])).toBe(join(sessionDir, NAME))
    } finally {
      rmSync(join(sessionDir, NAME), { force: true })
    }
  })

  test('Given 绝对路径 When 解析 Then 直接按该路径判断存在性', () => {
    expect(resolveFilePath(join(memoryDir, NAME), [sessionDir])).toBe(join(memoryDir, NAME))
    expect(resolveFilePath(join(memoryDir, 'missing.md'), [sessionDir])).toBeNull()
  })
})

/**
 * OfficeCLI 输出的骨架（1.0.145 实测）：head 里是它自己的 style，body 第一个子节点
 * 是文件名标题条——xlsx 是 Excel 绿色的 div.file-title，pptx 是 h1.file-title，docx 没有。
 * 那是这个文件名在界面上的第三次出现（标签栏 + 预览工具行已各一次），故隐藏掉。
 */
describe('restrictOfficeCliHtml：CSP 与标题条隐藏', () => {
  const xlsxLike = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>.file-title{padding:12px 20px;background:#217346}</style></head><body><div class="file-title">排班模版.xlsx</div><div class="sheet-slider"></div><div class="sheet-tabs"></div></body></html>'

  test('Given OfficeCLI 的 xlsx HTML When 处理 Then 注入 CSP', () => {
    expect(restrictOfficeCliHtml(xlsxLike)).toContain("default-src 'none'")
  })

  test('Given 带绿色标题条的 HTML When 处理 Then 注入隐藏规则且排在自带 style 之后', () => {
    const out = restrictOfficeCliHtml(xlsxLike)
    expect(out).toContain('.file-title{display:none !important}')
    expect(out.indexOf('.file-title{display:none !important}')).toBeGreaterThan(out.indexOf('background:#217346'))
    expect(out.indexOf('.file-title{display:none !important}')).toBeLessThan(out.indexOf('</head>'))
  })

  test('Given 标题条本体 When 处理 Then 结构不动（只靠 CSS 隐藏，不改 DOM）', () => {
    expect(restrictOfficeCliHtml(xlsxLike)).toContain('<div class="file-title">排班模版.xlsx</div>')
  })

  test('Given 工作表页签 When 处理 Then 不受影响（它是必要控件，不在隐藏之列）', () => {
    const out = restrictOfficeCliHtml(xlsxLike)
    expect(out).toContain('<div class="sheet-tabs">')
    expect(out).not.toContain('.sheet-tabs{display:none')
  })

  test('Given docx 那种没有标题条的 HTML When 处理 Then 规则仍注入但无副作用', () => {
    const docxLike = '<!DOCTYPE html><html><head><style>body{margin:0}</style></head><body><p>正文</p></body></html>'
    const out = restrictOfficeCliHtml(docxLike)
    expect(out).toContain('.file-title{display:none !important}')
    expect(out).toContain('<p>正文</p>')
  })

  test('Given 缺少 </head> 的畸形 HTML When 处理 Then CSP 与隐藏规则仍然都在', () => {
    const noClose = '<html><head><body><div class="file-title">x</div></body></html>'
    const out = restrictOfficeCliHtml(noClose)
    expect(out).toContain("default-src 'none'")
    expect(out).toContain('.file-title{display:none !important}')
  })

  test('Given 连 head 都没有的 HTML When 处理 Then 补出 head 并同时带上两者', () => {
    const out = restrictOfficeCliHtml('<html><body><div class="file-title">x</div></body></html>')
    expect(out).toContain("default-src 'none'")
    expect(out).toContain('.file-title{display:none !important}')
  })
})

/**
 * 上游 #2020把 resolveTargetPath 收紧成「只按确定的候选根拼接」：
 * searchFileInDir 全目录搜同名、homedir() 兜底、resolve('/') 兜底三样整块删掉。
 * 「猜中一个同名文件」比明确提示找不到更危险——最终授权边界由 IPC 层的 realpath 校验兜底
 * （见 preview-access-policy.ts），但解析这一步先不能把请求带到别处去。
 */
describe('resolveTargetPath —— 只按候选根拼接，不再猜', () => {
  let base: string
  let deepDir: string
  let outsideFile: string

  beforeAll(() => {
    base = join(root, 'resolve-target')
    deepDir = join(base, 'deep', 'nested')
    mkdirSync(deepDir, { recursive: true })
    mkdirSync(join(base, 'plan'), { recursive: true })
    writeFileSync(join(deepDir, 'buried.md'), '# 埋在深处的同名文件', 'utf-8')
    writeFileSync(join(base, 'plan', 'report.md'), '# 计划报告', 'utf-8')
    outsideFile = join(root, 'outside-target.md')
    writeFileSync(outsideFile, '# 候选根之外', 'utf-8')
  })

  test('Given 相对路径落在候选根内 When 解析 Then 按候选根拼接并命中真实文件', () => {
    expect(resolveTargetPath('plan/report.md', [base])).toBe(join(base, 'plan', 'report.md'))
  })

  test('Given 相对路径用 .. 越出候选根 When 解析 Then 不返回该候选（文件真实存在也不给）', () => {
    expect(existsSync(outsideFile)).toBe(true)
    expect(resolveTargetPath('../outside-target.md', [base])).toBe('')
  })

  test('Given 输入省了前缀但完整保留候选根末段 When 解析 Then 能恢复出真实路径', () => {
    expect(resolveTargetPath('resolve-target/plan/report.md', [base])).toBe(join(base, 'plan', 'report.md'))
  })

  test('Given 同名文件只存在于候选根的深层子目录 When 解析裸文件名 Then 不再跨目录搜，返回不存在的拼接路径', () => {
    const resolved = resolveTargetPath('buried.md', [base])
    expect(resolved).toBe(join(base, 'buried.md'))
    expect(existsSync(resolved)).toBe(false)
    // 反证：文件确实躺在 deep/nested 下，旧实现的 searchFileInDir 会把它搜出来
    expect(existsSync(join(deepDir, 'buried.md'))).toBe(true)
  })

  test('Given 没有任何候选根 When 解析相对路径 Then 返回空串（不再回落 homedir）', () => {
    expect(resolveTargetPath('buried.md')).toBe('')
    expect(resolveTargetPath('buried.md', [])).toBe('')
  })

  test('Given 一个在文件系统根下真实存在的相对路径 When 解析 Then 仍只按候选根拼接（不再回落根目录）', () => {
    const rootProbe = process.platform === 'win32' ? 'Windows/win.ini' : 'etc/hosts'
    if (!existsSync(resolve('/', rootProbe))) return
    expect(resolveTargetPath(rootProbe, [base])).toBe(resolve(base, rootProbe))
  })

  test('Given 路径里含 NUL 字节 When 解析 Then 直接返回空串', () => {
    expect(resolveTargetPath('plan/\0report.md', [base])).toBe('')
    expect(resolveTargetPath('\0', [base])).toBe('')
  })

  test('Given 绝对路径 When 解析 Then 直接 resolve，不因不存在而回退搜同名文件', () => {
    expect(resolveTargetPath(join(deepDir, 'buried.md'), [base])).toBe(join(deepDir, 'buried.md'))
    const missing = join(base, 'buried.md')
    expect(resolveTargetPath(missing, [base])).toBe(missing)
    expect(existsSync(resolveTargetPath(missing, [base]))).toBe(false)
  })
})

describe('isAbsolutePreviewPath —— 绝对路径形态识别', () => {
  test('Given POSIX 绝对路径 When 判定 Then 为真', () => {
    expect(isAbsolutePreviewPath('/tmp/a.md')).toBe(true)
  })

  test('Given UNC 路径 When 判定 Then 为真', () => {
    expect(isAbsolutePreviewPath('\\\\server\\share\\a.md')).toBe(true)
  })

  test('Given Windows 盘符路径（正反斜杠、大小写盘符）When 判定 Then 均为真', () => {
    expect(isAbsolutePreviewPath('C:\\Users\\a.md')).toBe(true)
    expect(isAbsolutePreviewPath('c:/Users/a.md')).toBe(true)
  })

  test('Given 相对路径 When 判定 Then 为假', () => {
    expect(isAbsolutePreviewPath('docs/a.md')).toBe(false)
    expect(isAbsolutePreviewPath('./a.md')).toBe(false)
    expect(isAbsolutePreviewPath('a.md')).toBe(false)
    expect(isAbsolutePreviewPath('')).toBe(false)
  })
})
