/**
 * 计划模式 plan/ 目录写入与计划文档策略测试（收上游 #2018）
 *
 * 上游这 9 个文件零测试，且作者是 macOS 开发——Windows 下的 realpath / 大小写 / 盘符
 * 行为完全没验证过。本文件的 Windows 分组断言全部来自本机（Win11）实测：
 * - `realpathSync` 不做大小写规范化，传什么大小写返回什么大小写（盘符同理）；
 * - `path.relative` 对目录名与盘符大小写**不敏感**，所以全大写路径仍判定在目录内；
 * - 跨盘符 `path.relative` 返回绝对路径，靠 `isAbsolute` 挡住；
 * - junction（mklink /J，普通用户可建）`lstat().isSymbolicLink()` 为 true、`isDirectory()` 为 false；
 *   **穿过 junction 的文件本身不是符号链接**，只有 realpath 比对能识破逃逸。
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  MAX_PLAN_DOCUMENT_BYTES,
  buildPlanDocumentChangedDenyMessage,
  buildPlanFileRequiredDenyMessage,
  buildPlanModeWriteDenyMessage,
  isPlanDocumentCurrent,
  isSessionPlanMarkdownPath,
  resolvePlanDocument,
} from './agent-plan-file-policy'

const isWindows = process.platform === 'win32'

let root = ''
let planDir = ''
let outsideDir = ''
let planFile = ''
let outsideFile = ''

/** 建目录链接：Windows 用 junction（无需管理员），其余平台用符号链接。返回是否建成。 */
function createDirectoryLink(linkPath: string, targetPath: string): boolean {
  try {
    if (isWindows) execSync(`cmd /c mklink /J "${linkPath}" "${targetPath}"`, { stdio: 'pipe' })
    else symlinkSync(targetPath, linkPath, 'dir')
    return true
  } catch {
    return false
  }
}

/** 建文件符号链接；Windows 未开开发者模式时会 EPERM，此时返回 false 由用例跳过。 */
function createFileLink(linkPath: string, targetPath: string): boolean {
  try {
    symlinkSync(targetPath, linkPath, 'file')
    return true
  } catch {
    return false
  }
}

beforeAll(() => {
  root = join(tmpdir(), `canopy-plan-policy-test-${Date.now()}`)
  planDir = join(root, 'workspace-slug', 'session-id', '.context', 'plan')
  outsideDir = join(root, 'user-project')
  mkdirSync(planDir, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
  planFile = join(planDir, 'my-plan.md')
  outsideFile = join(outsideDir, 'notes.md')
  writeFileSync(planFile, '# 计划\n第一步\n')
  writeFileSync(outsideFile, '# 用户自己的笔记\n')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('isSessionPlanMarkdownPath —— 计划模式写入的地址隔离', () => {
  test('Given plan 目录内已存在的 .md When 判定 Then 放行（删掉的是无地址约束的豁免，不是全部写入）', () => {
    expect(isSessionPlanMarkdownPath(planFile, planDir)).toBe(true)
  })

  test('Given plan 目录内尚不存在的 .md When 判定 Then 放行（Write 首次创建计划文件必须能过）', () => {
    expect(isSessionPlanMarkdownPath(join(planDir, 'brand-new.md'), planDir)).toBe(true)
  })

  test('Given plan 目录下新建子目录中的 .md When 判定 Then 子目录不存在即拒（不隐式建目录）', () => {
    expect(isSessionPlanMarkdownPath(join(planDir, 'sub', 'x.md'), planDir)).toBe(false)
    mkdirSync(join(planDir, 'sub'), { recursive: true })
    expect(isSessionPlanMarkdownPath(join(planDir, 'sub', 'x.md'), planDir)).toBe(true)
  })

  test('Given 用户项目里的 .md When 判定 Then 拒（这正是维护者实测中招的 test.md / 1.md 场景）', () => {
    expect(isSessionPlanMarkdownPath(outsideFile, planDir)).toBe(false)
  })

  test('Given plan 目录内的非 .md 文件 When 判定 Then 拒', () => {
    expect(isSessionPlanMarkdownPath(join(planDir, 'plan.txt'), planDir)).toBe(false)
    expect(isSessionPlanMarkdownPath(join(planDir, 'plan.md.bak'), planDir)).toBe(false)
    expect(isSessionPlanMarkdownPath(join(planDir, 'plan'), planDir)).toBe(false)
  })

  test('Given 大写扩展名 .MD When 判定 Then 放行（扩展名比较大小写不敏感）', () => {
    const upperExt = join(planDir, 'UPPER.MD')
    writeFileSync(upperExt, '# upper\n')
    expect(isSessionPlanMarkdownPath(upperExt, planDir)).toBe(true)
  })

  test('Given 相对路径 When 判定 Then 一律拒（底层工具按 Agent cwd 解析，映射不到计划目录）', () => {
    expect(isSessionPlanMarkdownPath('my-plan.md', planDir)).toBe(false)
    expect(isSessionPlanMarkdownPath('./plan/my-plan.md', planDir)).toBe(false)
    expect(isSessionPlanMarkdownPath('../my-plan.md', planDir)).toBe(false)
  })

  test('Given 含 .. 穿越到 plan 目录之外的绝对路径 When 判定 Then 拒', () => {
    expect(isSessionPlanMarkdownPath(join(planDir, '..', '..', '..', 'user-project', 'notes.md'), planDir)).toBe(false)
    expect(isSessionPlanMarkdownPath(join(planDir, '..', 'escaped.md'), planDir)).toBe(false)
  })

  test('Given planDirectory 缺失或不存在 When 判定 Then 拒（无工作区会话没有 plan/ 目录）', () => {
    expect(isSessionPlanMarkdownPath(planFile, undefined)).toBe(false)
    expect(isSessionPlanMarkdownPath(planFile, join(root, 'no-such-dir'))).toBe(false)
  })

  test('Given 目录链接把 plan 子路径指向目录外 When 判定 Then 按 realpath 拒（字符串包含检查会被骗过）', () => {
    const linkDir = join(planDir, 'escape-link')
    if (!createDirectoryLink(linkDir, outsideDir)) return
    // 仅按字符串，`plan/escape-link/notes.md` 看起来就在 plan 目录内；realpath 才暴露它落在 user-project。
    expect(isSessionPlanMarkdownPath(join(linkDir, 'notes.md'), planDir)).toBe(false)
    // 经链接目录创建的新文件同样拒（父目录是链接）。
    expect(isSessionPlanMarkdownPath(join(linkDir, 'fresh.md'), planDir)).toBe(false)
    rmSync(linkDir, { recursive: true, force: true })
  })

  test('Given plan 目录本身是指向别处的链接 When 判定 Then 整体拒', () => {
    const fakeSessionPlanDir = join(root, 'fake-session', 'plan')
    mkdirSync(join(root, 'fake-session'), { recursive: true })
    if (!createDirectoryLink(fakeSessionPlanDir, outsideDir)) return
    expect(isSessionPlanMarkdownPath(join(fakeSessionPlanDir, 'notes.md'), fakeSessionPlanDir)).toBe(false)
    rmSync(fakeSessionPlanDir, { recursive: true, force: true })
  })

  test('Given plan 目录内指向目录外文件的符号链接 When 判定 Then 拒（Windows 无开发者模式时跳过）', () => {
    const linkFile = join(planDir, 'sneaky.md')
    if (!createFileLink(linkFile, outsideFile)) return
    expect(isSessionPlanMarkdownPath(linkFile, planDir)).toBe(false)
    rmSync(linkFile, { force: true })
  })
})

describe('Windows 路径行为（本机实测写成断言）', () => {
  test.if(isWindows)('Given 目录名全大写的同一路径 When 判定 Then 放行（path.relative 大小写不敏感，实测）', () => {
    const upperCased = join(planDir.toUpperCase(), 'MY-PLAN.MD')
    expect(existsSync(upperCased)).toBe(true)
    expect(isSessionPlanMarkdownPath(upperCased, planDir)).toBe(true)
  })

  test.if(isWindows)('Given 盘符大小写与 planDirectory 不同 When 判定 Then 放行（盘符比较同样不敏感，实测）', () => {
    const lowerDrive = planFile.charAt(0).toLowerCase() + planFile.slice(1)
    const upperDrivePlanDir = planDir.charAt(0).toUpperCase() + planDir.slice(1)
    expect(isSessionPlanMarkdownPath(lowerDrive, upperDrivePlanDir)).toBe(true)
  })

  test.if(isWindows)('Given 正斜杠书写的绝对路径 When 判定 Then 放行（resolve 会归一化分隔符，实测）', () => {
    expect(isSessionPlanMarkdownPath(planFile.split('\\').join('/'), planDir)).toBe(true)
  })

  test.if(isWindows)('Given 另一个盘符上的 .md When 判定 Then 拒（跨盘符 relative 返回绝对路径，实测）', () => {
    const otherDrive = planDir.startsWith('C:') ? 'D:\\evil\\plan.md' : 'C:\\evil\\plan.md'
    expect(isSessionPlanMarkdownPath(otherDrive, planDir)).toBe(false)
  })

  test.if(isWindows)('Given realpath 不规范化大小写 When 解析计划文档 Then filePath 保留调用方传入的大小写（实测）', () => {
    const upperCased = join(planDir.toUpperCase(), 'MY-PLAN.MD')
    const document = resolvePlanDocument(upperCased, planDir)
    expect(document?.filePath).toBe(upperCased)
    // 同一个串再解析一次仍然相等——哈希复核的字符串比对因此成立。
    expect(isPlanDocumentCurrent(document!, planDir)).toBe(true)
  })

  test.if(isWindows)('Given Windows junction When lstat Then 报告为符号链接且 isDirectory 为 false（实测，策略据此拦截）', () => {
    const linkDir = join(planDir, 'probe-junction')
    if (!createDirectoryLink(linkDir, outsideDir)) return
    const { lstatSync, statSync } = require('node:fs')
    expect(lstatSync(linkDir).isSymbolicLink()).toBe(true)
    expect(lstatSync(linkDir).isDirectory()).toBe(false)
    expect(statSync(linkDir).isDirectory()).toBe(true)
    rmSync(linkDir, { recursive: true, force: true })
  })
})

describe('resolvePlanDocument —— 审批用计划文档解析', () => {
  test('Given plan 目录内的真实 .md When 解析 Then 返回规范路径、展示名与内容哈希', () => {
    const document = resolvePlanDocument(planFile, planDir)
    expect(document?.displayName).toBe('my-plan.md')
    expect(document?.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('Given 首尾空白的 planFile When 解析 Then 先 trim 再判定', () => {
    expect(resolvePlanDocument(`  ${planFile}  `, planDir)?.displayName).toBe('my-plan.md')
  })

  test('Given 缺失 / 非字符串 / 空串的 planFile When 解析 Then undefined', () => {
    expect(resolvePlanDocument(undefined, planDir)).toBeUndefined()
    expect(resolvePlanDocument(123, planDir)).toBeUndefined()
    expect(resolvePlanDocument('   ', planDir)).toBeUndefined()
  })

  test('Given plan 目录外的 .md When 解析 Then undefined（审批不接受用户项目里的文件）', () => {
    expect(resolvePlanDocument(outsideFile, planDir)).toBeUndefined()
  })

  test('Given plan 目录内但不存在的 .md When 解析 Then undefined（写入可放行、审批必须已落盘）', () => {
    expect(resolvePlanDocument(join(planDir, 'never-written.md'), planDir)).toBeUndefined()
  })

  test('Given 超过 1 MB 的计划文件 When 解析 Then undefined（预览要整文件读入并哈希）', () => {
    const bigFile = join(planDir, 'huge.md')
    writeFileSync(bigFile, 'x'.repeat(MAX_PLAN_DOCUMENT_BYTES + 1))
    expect(resolvePlanDocument(bigFile, planDir)).toBeUndefined()
    rmSync(bigFile, { force: true })
  })

  test('Given 没有 plan 目录 When 解析 Then undefined（无工作区会话不做计划文档校验）', () => {
    expect(resolvePlanDocument(planFile, undefined)).toBeUndefined()
  })
})

describe('isPlanDocumentCurrent —— 批准前的哈希复核', () => {
  test('Given 提交后文件未变 When 复核 Then true', () => {
    const document = resolvePlanDocument(planFile, planDir)!
    expect(isPlanDocumentCurrent(document, planDir)).toBe(true)
  })

  test('Given 审批期间文件被改写 When 复核 Then false（用户批的必须是他看到的那一版）', () => {
    const swapFile = join(planDir, 'swap.md')
    writeFileSync(swapFile, '# 原始计划\n')
    const document = resolvePlanDocument(swapFile, planDir)!
    writeFileSync(swapFile, '# 被偷换的计划：顺手删库\n')
    expect(isPlanDocumentCurrent(document, planDir)).toBe(false)
    rmSync(swapFile, { force: true })
  })

  test('Given 审批期间文件被删除 When 复核 Then false', () => {
    const goneFile = join(planDir, 'gone.md')
    writeFileSync(goneFile, '# 会消失的计划\n')
    const document = resolvePlanDocument(goneFile, planDir)!
    rmSync(goneFile, { force: true })
    expect(isPlanDocumentCurrent(document, planDir)).toBe(false)
  })
})

describe('数据目录的祖先是目录链接（用户把 ~/.canopy 软链 / junction 到别的盘；macOS 的 /var → /private/var 同理）', () => {
  // 形态：<root>/linked-home/.canopy → <root>/external-disk/canopy-data。
  // 应用的 plan 目录由 join() 拼出、从不 realpath，所以走的是「链接那条路径」；而 resolvePlanDocument 返回的
  // filePath 是 realpath 后的串。0.18.100 及更早，批准前复核拿后者去和前者做字符串包含 → 一字未改也恒判「已变更」。
  let linkedPlanDir = ''
  let linkedPlanFile = ''
  let realPlanDir = ''
  let linkBuilt = false

  beforeAll(() => {
    const realData = join(root, 'external-disk', 'canopy-data')
    const linkedData = join(root, 'linked-home', '.canopy')
    mkdirSync(realData, { recursive: true })
    mkdirSync(join(root, 'linked-home'), { recursive: true })
    linkBuilt = createDirectoryLink(linkedData, realData)
    if (!linkBuilt) return
    const sessionPlan = join('agent-workspaces', 'default', 'session-id', '.context', 'plan')
    linkedPlanDir = join(linkedData, sessionPlan)
    realPlanDir = join(realData, sessionPlan)
    mkdirSync(linkedPlanDir, { recursive: true })
    linkedPlanFile = join(linkedPlanDir, 'my-plan.md')
    writeFileSync(linkedPlanFile, '# 计划\n第一步\n')
  })

  test('Given 祖先是目录链接 When 提交计划后文件一字未改再复核 Then 提交通过且复核为 true（此前恒 false，用户永远批不出去）', () => {
    if (!linkBuilt) return
    const document = resolvePlanDocument(linkedPlanFile, linkedPlanDir)
    expect(document).toBeDefined()
    expect(isPlanDocumentCurrent(document!, linkedPlanDir)).toBe(true)
  })

  test('Given 祖先是目录链接 When 审批期间文件被改写 Then 复核仍为 false（放宽的只是路径口径，不是内容校验）', () => {
    if (!linkBuilt) return
    const swapFile = join(linkedPlanDir, 'swap.md')
    writeFileSync(swapFile, '# 原始计划\n')
    const document = resolvePlanDocument(swapFile, linkedPlanDir)!
    writeFileSync(swapFile, '# 被偷换的计划：顺手删库\n')
    expect(isPlanDocumentCurrent(document, linkedPlanDir)).toBe(false)
    rmSync(swapFile, { force: true })
  })

  test('Given 祖先是目录链接 When 审批期间文件被删除 Then 复核为 false', () => {
    if (!linkBuilt) return
    const goneFile = join(linkedPlanDir, 'gone.md')
    writeFileSync(goneFile, '# 会消失的计划\n')
    const document = resolvePlanDocument(goneFile, linkedPlanDir)!
    rmSync(goneFile, { force: true })
    expect(isPlanDocumentCurrent(document, linkedPlanDir)).toBe(false)
  })

  test('Given 祖先是目录链接 When 审批期间 plan 目录自身被换成指向别处的链接 Then 复核为 false（同名同内容的文件也不认）', () => {
    if (!linkBuilt) return
    const sessionDir = join(root, 'linked-home', '.canopy', 'agent-workspaces', 'default', 'swap-session', '.context')
    const swapPlanDir = join(sessionDir, 'plan')
    mkdirSync(swapPlanDir, { recursive: true })
    writeFileSync(join(swapPlanDir, 'my-plan.md'), '# 计划\n第一步\n')
    const document = resolvePlanDocument(join(swapPlanDir, 'my-plan.md'), swapPlanDir)!
    // 把 plan 目录整个换成指向目录外的链接，链接目标里放一份同名同内容的文件
    rmSync(swapPlanDir, { recursive: true, force: true })
    const decoyDir = join(root, 'decoy-plan')
    mkdirSync(decoyDir, { recursive: true })
    writeFileSync(join(decoyDir, 'my-plan.md'), '# 计划\n第一步\n')
    if (!createDirectoryLink(swapPlanDir, decoyDir)) return
    expect(isPlanDocumentCurrent(document, swapPlanDir)).toBe(false)
    rmSync(swapPlanDir, { recursive: true, force: true })
  })

  test('Given 祖先是目录链接 When 复核时 plan 目录已不存在 Then false 而不是抛错', () => {
    if (!linkBuilt) return
    const document = resolvePlanDocument(linkedPlanFile, linkedPlanDir)!
    expect(isPlanDocumentCurrent(document, join(linkedPlanDir, '..', 'no-such-plan'))).toBe(false)
    expect(isPlanDocumentCurrent(document, undefined)).toBe(false)
  })

  test('Given 祖先是目录链接 When plan 目录内的目录链接把文件指到目录外 Then 提交阶段仍按 realpath 拒（安全口径没松）', () => {
    if (!linkBuilt) return
    const escapeLink = join(linkedPlanDir, 'escape-link')
    if (!createDirectoryLink(escapeLink, outsideDir)) return
    expect(resolvePlanDocument(join(escapeLink, 'notes.md'), linkedPlanDir)).toBeUndefined()
    rmSync(escapeLink, { recursive: true, force: true })
  })

  test('Given 调用方直接传 realpath 形态的 plan 目录 When 提交并复核 Then 同样成立（两种口径都认）', () => {
    if (!linkBuilt) return
    const realFile = join(realPlanDir, 'my-plan.md')
    const document = resolvePlanDocument(realFile, realPlanDir)
    expect(document).toBeDefined()
    expect(isPlanDocumentCurrent(document!, realPlanDir)).toBe(true)
  })
})

describe('拒绝文案并入行动指引体系（弱模型不撞墙）', () => {
  test('Given 缺 planFile When 生成拒绝文案 Then 含真实 plan 目录路径、.md 示例与「两步」重提指引', () => {
    const message = buildPlanFileRequiredDenyMessage(planDir, '没有提供 planFile')
    expect(message).toContain(planDir)
    expect(message).toContain('my-plan.md')
    expect(message).toContain('Write')
    expect(message).toContain('planFile')
    expect(message).toContain('ExitPlanMode')
    // 行动指引原文必须并进来，模型被拒后知道正道而不是空转
    expect(message).toContain('计划模式')
  })

  test('Given 写到 plan 目录外 When 生成拒绝文案 Then 同时给「改写到 plan/」与「重提审批」两条出路', () => {
    const message = buildPlanModeWriteDenyMessage(planDir)
    expect(message).toContain(planDir)
    expect(message).toContain('planFile')
    expect(message).toContain('ExitPlanMode')
  })

  test('Given 无工作区会话（无 plan 目录） When 生成写入拒绝文案 Then 退回原文案，不出现空路径', () => {
    const message = buildPlanModeWriteDenyMessage(undefined)
    expect(message).toContain('计划模式下不允许执行写操作')
    expect(message).toContain('ExitPlanMode')
    expect(message).not.toContain('undefined')
  })

  test('Given 计划文档在审批期间被改动 When 生成拒绝文案 Then 点名文件并要求带同一 planFile 重提', () => {
    const message = buildPlanDocumentChangedDenyMessage('my-plan.md')
    expect(message).toContain('my-plan.md')
    expect(message).toContain('ExitPlanMode')
    expect(message).toContain('planFile')
  })
})
