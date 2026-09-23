import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OFFICE_EDITABLE_EXTENSIONS,
  OfficeDocumentAccessError,
  defaultScreenshotOutputPath,
  describeEnvelope,
  resolveCreatableOfficePath,
  resolveEditableOfficePath,
  resolveReadableLegacyOfficePath,
  resolveScreenshotOutputPath,
} from './officecli-service'

/**
 * 这批用例守的是编辑工具的安全边界。
 *
 * 预览链路的 `resolveTargetPath()` 是「任何存在的绝对路径直接放行、找不到还按文件名
 * 跨目录搜」——那是登记的既有缺口。编辑工具若复用它，就把「能读任意文件」
 * 变成「能写任意文件」，所以这里必须独立走授权根判定，并把判定钉死在测试里。
 */
let root: string
let authorized: string
let outside: string

beforeAll(() => {
  // macOS 的 tmpdir 在 /var 下、是 /private/var 的软链；生产代码按设计先 realpath 再判授权根，
  // 夹具不 realpath 的话断言拿 /var 去比 /private/var 必红（0.18.81 起 mac 基线里的两例）。
  root = realpathSync(mkdtempSync(join(tmpdir(), 'canopy-officecli-')))
  authorized = join(root, 'workspace')
  outside = join(root, 'outside')
  mkdirSync(authorized, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(authorized, 'book.xlsx'), 'x')
  writeFileSync(join(authorized, 'notes.txt'), 'x')
  writeFileSync(join(authorized, 'legacy.xls'), 'x')
  writeFileSync(join(authorized, 'deck-preview.png'), 'x')
  writeFileSync(join(outside, 'secret.xlsx'), 'x')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('resolveEditableOfficePath — 授权根判定', () => {
  it('Given 授权目录内的 .xlsx，When 解析，Then 返回其真实绝对路径', () => {
    expect(resolveEditableOfficePath(join(authorized, 'book.xlsx'), [authorized])).toContain('book.xlsx')
  })

  it('Given 授权目录之外的 .xlsx，When 解析，Then 拒绝（这是编辑工具与预览的关键差别）', () => {
    expect(() => resolveEditableOfficePath(join(outside, 'secret.xlsx'), [authorized]))
      .toThrow(OfficeDocumentAccessError)
  })

  it('Given 用 .. 穿越出授权根的路径，When 解析，Then 拒绝', () => {
    const traversal = join(authorized, '..', 'outside', 'secret.xlsx')
    expect(() => resolveEditableOfficePath(traversal, [authorized])).toThrow(OfficeDocumentAccessError)
  })

  it('Given 非 Office 扩展名，When 解析，Then 拒绝并说明支持哪几种', () => {
    expect(() => resolveEditableOfficePath(join(authorized, 'notes.txt'), [authorized]))
      .toThrow(/仅支持 \.docx/)
  })

  it('Given 旧版二进制格式 .xls，When 解析，Then 拒绝并提示先另存为新格式', () => {
    expect(() => resolveEditableOfficePath(join(authorized, 'legacy.xls'), [authorized]))
      .toThrow(/另存为新格式/)
  })

  it('Given 旧版 .xls 走编辑路径，When 被拒，Then 告诉模型可以改用 OfficeInspect 只读查看、以及该另存成哪种格式', () => {
    expect(() => resolveEditableOfficePath(join(authorized, 'legacy.xls'), [authorized]))
      .toThrow(/OfficeInspect 的 mode=text \/ outline \/ stats 只读查看.*（\.xlsx）/)
  })

  it('Given 文件不存在，When 解析，Then 报文件不存在而不是越权', () => {
    expect(() => resolveEditableOfficePath(join(authorized, 'missing.xlsx'), [authorized]))
      .toThrow(/文件不存在/)
  })

  it('Given 授权根为空（会话没有任何已授权目录），When 解析，Then 一律拒绝', () => {
    expect(() => resolveEditableOfficePath(join(authorized, 'book.xlsx'), []))
      .toThrow(/没有已授权的目录/)
  })

  it('Given 空路径，When 解析，Then 拒绝', () => {
    expect(() => resolveEditableOfficePath('', [authorized])).toThrow(OfficeDocumentAccessError)
  })

  it('Given 目录而非文件，When 解析，Then 拒绝', () => {
    const dir = join(authorized, 'sub.xlsx')
    mkdirSync(dir, { recursive: true })
    expect(() => resolveEditableOfficePath(dir, [authorized])).toThrow(/不是常规文件/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('Given 多个授权根，When 目标在其中之一，Then 放行', () => {
    expect(resolveEditableOfficePath(join(authorized, 'book.xlsx'), [outside, authorized]))
      .toContain('book.xlsx')
  })
})

describe('resolveEditableOfficePath — symlink 逃逸', () => {
  it('Given 授权根内指向根外文件的 symlink，When 解析，Then 按 realpath 判定并拒绝', () => {
    const link = join(authorized, 'link.xlsx')
    try {
      symlinkSync(join(outside, 'secret.xlsx'), link)
    } catch {
      // Windows 无开发者模式 / 无管理员权限时建不了符号链接，跳过该断言。
      return
    }
    try {
      expect(() => resolveEditableOfficePath(link, [authorized])).toThrow(OfficeDocumentAccessError)
    } finally {
      rmSync(link, { force: true })
    }
  })
})

describe('resolveReadableLegacyOfficePath — 旧版格式只读，授权规则与编辑相同', () => {
  it('Given 授权目录内的 .xls（含工作区相对路径），When 解析，Then 放行', () => {
    expect(resolveReadableLegacyOfficePath(join(authorized, 'legacy.xls'), [authorized])).toContain('legacy.xls')
    expect(resolveReadableLegacyOfficePath('legacy.xls', [authorized], authorized)).toContain('legacy.xls')
  })

  it('Given 授权目录之外或经 .. 穿越的旧版文件，When 解析，Then 拒绝', () => {
    writeFileSync(join(outside, 'secret.doc'), 'x')
    expect(() => resolveReadableLegacyOfficePath(join(outside, 'secret.doc'), [authorized])).toThrow(OfficeDocumentAccessError)
    expect(() => resolveReadableLegacyOfficePath('../outside/secret.doc', [authorized], authorized)).toThrow(OfficeDocumentAccessError)
  })

  it('Given 新格式或其他扩展名，When 走只读旧版路径，Then 拒绝（新格式必须走 OfficeCLI）', () => {
    expect(() => resolveReadableLegacyOfficePath(join(authorized, 'book.xlsx'), [authorized])).toThrow(/不是旧版 Office 格式/)
    expect(() => resolveReadableLegacyOfficePath(join(authorized, 'notes.txt'), [authorized])).toThrow(/不是旧版 Office 格式/)
  })

  it('Given 授权根为空或文件不存在，When 解析，Then 与编辑路径同样拒绝', () => {
    expect(() => resolveReadableLegacyOfficePath(join(authorized, 'legacy.xls'), [])).toThrow(/没有已授权的目录/)
    expect(() => resolveReadableLegacyOfficePath(join(authorized, 'missing.ppt'), [authorized])).toThrow(/文件不存在/)
  })
})

describe('OFFICE_EDITABLE_EXTENSIONS', () => {
  it('Given 支持集合，When 检查，Then 恰是三种新版 OOXML 格式', () => {
    expect([...OFFICE_EDITABLE_EXTENSIONS].sort()).toEqual(['.docx', '.pptx', '.xlsx'])
  })
})

describe('resolveEditableOfficePath — 工作区相对路径', () => {
  it('Given 相对路径与工作目录，When 解析，Then 按工作目录解析而不是主进程 cwd', () => {
    // 工具描述承诺「absolute or workspace-relative」，不接 baseDir 的话相对路径永远报不存在
    expect(resolveEditableOfficePath('book.xlsx', [authorized], authorized)).toContain('book.xlsx')
    expect(resolveEditableOfficePath('./book.xlsx', [authorized], authorized)).toContain('book.xlsx')
  })

  it('Given 相对路径经工作目录穿越到根外，When 解析，Then 仍被授权根拦下', () => {
    expect(() => resolveEditableOfficePath('../outside/secret.xlsx', [authorized], authorized))
      .toThrow(OfficeDocumentAccessError)
  })

  it('Given 相对路径解析失败，When 报错，Then 带上用于解析的工作目录便于模型纠正', () => {
    expect(() => resolveEditableOfficePath('missing.xlsx', [authorized], authorized))
      .toThrow(/按工作目录/)
  })
})

describe('resolveCreatableOfficePath — 新建文档的边界', () => {
  it('Given 授权目录内的新文件名，When 解析，Then 返回目标绝对路径', () => {
    expect(resolveCreatableOfficePath('新表.xlsx', [authorized], authorized)).toContain('新表.xlsx')
  })

  it('Given 目标已存在，When 解析，Then 拒绝（新建绝不覆盖已有文件）', () => {
    expect(() => resolveCreatableOfficePath('book.xlsx', [authorized], authorized))
      .toThrow(/已存在/)
  })

  it('Given 父目录在授权根外，When 解析，Then 拒绝', () => {
    expect(() => resolveCreatableOfficePath(join(outside, '新表.xlsx'), [authorized]))
      .toThrow(OfficeDocumentAccessError)
  })

  it('Given 父目录不存在，When 解析，Then 报目录不存在而不是越权', () => {
    expect(() => resolveCreatableOfficePath(join(authorized, '没有这个目录', 'a.xlsx'), [authorized]))
      .toThrow(/目录不存在/)
  })

  it('Given 非 Office 扩展名，When 解析，Then 拒绝', () => {
    expect(() => resolveCreatableOfficePath('a.txt', [authorized], authorized)).toThrow(/仅支持新建/)
  })
})

/**
 * 截图这条链路是唯一「Agent 指定路径、我们往磁盘写非文档文件」的口子，
 * 所以它的边界要跟编辑链路一样钉死：扩展名锁 .png、父目录必须在授权根内。
 * 唯一刻意放宽的是「允许覆盖同名 PNG」——视觉 QA 要反复渲染同一份文件。
 */
describe('resolveScreenshotOutputPath — 截图输出的边界', () => {
  it('Given 授权目录内的 .png，When 解析，Then 返回目标绝对路径', () => {
    expect(resolveScreenshotOutputPath('deck.png', [authorized], authorized)).toContain('deck.png')
  })

  it('Given 已存在的同名 .png，When 解析，Then 放行（视觉 QA 要反复覆盖同一张图）', () => {
    expect(resolveScreenshotOutputPath('deck-preview.png', [authorized], authorized))
      .toContain('deck-preview.png')
  })

  it('Given 非 .png 扩展名，When 解析，Then 拒绝（防止这条链路变成任意写文件）', () => {
    expect(() => resolveScreenshotOutputPath('a.txt', [authorized], authorized)).toThrow(/只能输出 \.png/)
    expect(() => resolveScreenshotOutputPath('a.xlsx', [authorized], authorized)).toThrow(/只能输出 \.png/)
    expect(() => resolveScreenshotOutputPath('noext', [authorized], authorized)).toThrow(/只能输出 \.png/)
  })

  it('Given 父目录在授权根外，When 解析，Then 拒绝', () => {
    expect(() => resolveScreenshotOutputPath(join(outside, 'shot.png'), [authorized]))
      .toThrow(OfficeDocumentAccessError)
  })

  it('Given 用 .. 穿越出授权根，When 解析，Then 拒绝', () => {
    expect(() => resolveScreenshotOutputPath(join(authorized, '..', 'outside', 'shot.png'), [authorized]))
      .toThrow(OfficeDocumentAccessError)
  })

  it('Given 父目录不存在，When 解析，Then 报目录不存在而不是越权', () => {
    expect(() => resolveScreenshotOutputPath(join(authorized, '没有这个目录', 'shot.png'), [authorized]))
      .toThrow(/目录不存在/)
  })

  it('Given 授权根为空，When 解析，Then 一律拒绝', () => {
    expect(() => resolveScreenshotOutputPath('shot.png', [], authorized)).toThrow(OfficeDocumentAccessError)
  })

  it('Given 空路径，When 解析，Then 拒绝', () => {
    expect(() => resolveScreenshotOutputPath('', [authorized], authorized)).toThrow(OfficeDocumentAccessError)
  })

  it('Given 相对路径与工作目录，When 解析，Then 按工作目录解析而不是主进程 cwd', () => {
    expect(resolveScreenshotOutputPath('shot.png', [authorized], authorized)).toBe(join(authorized, 'shot.png'))
  })

  it('Given 授权根内指向根外目录的 symlink，When 解析，Then 按 realpath 判定并拒绝', () => {
    const linkDir = join(authorized, 'linked-dir')
    try {
      symlinkSync(outside, linkDir, 'dir')
    } catch {
      // Windows 无开发者模式 / 无管理员权限时建不了符号链接，跳过该断言。
      return
    }
    try {
      expect(() => resolveScreenshotOutputPath(join(linkDir, 'shot.png'), [authorized]))
        .toThrow(OfficeDocumentAccessError)
    } finally {
      rmSync(linkDir, { force: true, recursive: true })
    }
  })
})

describe('defaultScreenshotOutputPath — 默认落在文档旁边', () => {
  it('Given 一份 .pptx，When 取默认输出路径，Then 是同目录下的 <名字>-preview.png', () => {
    expect(defaultScreenshotOutputPath(join(authorized, 'deck.pptx'))).toBe(join(authorized, 'deck-preview.png'))
  })

  it('Given 文件名里本身带点，When 取默认输出路径，Then 只剥最后一段扩展名', () => {
    expect(defaultScreenshotOutputPath(join(authorized, '2026.Q1.报表.xlsx')))
      .toBe(join(authorized, '2026.Q1.报表-preview.png'))
  })

  it('Given 文档在授权根内，When 取默认输出路径，Then 结果仍在同一个授权根内', () => {
    const out = defaultScreenshotOutputPath(join(authorized, 'deck.pptx'))
    expect(resolveScreenshotOutputPath(out, [authorized])).toBe(out)
  })
})

describe('describeEnvelope — 输出体积上限', () => {
  it('Given 超大结果，When 描述，Then 截断到 48KB 内并提示缩小范围', () => {
    // 实测一张 400 行的表 `get /` 输出 866KB，不截断会当场撑爆模型上下文
    const huge = { rows: Array.from({ length: 60000 }, (_, i) => `第${i}行的一些内容`) }
    const text = describeEnvelope({ success: true, data: huge })
    expect(Buffer.byteLength(text)).toBeLessThan(50 * 1024)
    expect(text).toContain('已截断')
    expect(text).toContain('缩小范围')
  })

  it('Given 正常大小结果，When 描述，Then 原样返回不加截断提示', () => {
    const text = describeEnvelope({ success: true, data: { path: '/Sheet1/A1', text: '年假' } })
    expect(text).not.toContain('已截断')
    expect(text).toContain('年假')
  })
})

describe('describeEnvelope — batch 失败要挖到具体条目', () => {
  // 实测：batch 的失败信封没有顶层 error/message，原因全在 data.results[] 里
  const batchFailure = {
    success: false,
    data: {
      results: [
        { index: 0, success: true },
        { index: 1, success: false, code: 'sheet_not_found', error: 'Sheet not found: "Nope"', item: { path: '/Nope/A1' } },
      ],
      summary: { total: 2, failed: 1, atomicRolledBack: true },
    },
  }

  it('Given batch 失败信封，When 描述，Then 列出是第几条、什么 code、什么原因', () => {
    const text = describeEnvelope(batchFailure)
    expect(text).toContain('第 2 条')
    expect(text).toContain('sheet_not_found')
    expect(text).toContain('Sheet not found')
    expect(text).toContain('/Nope/A1')
  })

  it('Given 整批已回滚，When 描述，Then 明确告诉模型文件未改动', () => {
    expect(describeEnvelope(batchFailure)).toContain('整批已回滚')
  })

  it('Given 成功的条目，When 描述失败，Then 不混进失败列表', () => {
    expect(describeEnvelope(batchFailure)).not.toContain('第 1 条')
  })
})

describe('describeEnvelope — 给模型的可纠错反馈', () => {
  it('Given 成功信封带 data，When 描述，Then 输出消息与数据', () => {
    const text = describeEnvelope({ success: true, message: 'Updated /Sheet1/A1', data: { path: '/Sheet1/A1' } })
    expect(text).toContain('Updated /Sheet1/A1')
    expect(text).toContain('/Sheet1/A1')
  })

  it('Given 成功但无数据，When 描述，Then 不返回空串', () => {
    expect(describeEnvelope({ success: true })).toBe('完成')
  })

  it('Given 失败信封，When 描述，Then 带上错误码——上游承诺 code 永不改名，模型可据此纠错', () => {
    const text = describeEnvelope({ success: false, error: { code: 'file_locked', error: '文件被占用' } })
    expect(text).toContain('[file_locked]')
    expect(text).toContain('文件被占用')
  })

  it('Given 失败且只有 message，When 描述，Then 退回用 message', () => {
    expect(describeEnvelope({ success: false, message: '路径不存在' })).toBe('失败：路径不存在')
  })
})
