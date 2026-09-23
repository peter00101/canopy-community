import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { CANOPY_BRAND } from '@canopy/brand'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

type AgentWorkspaceManager = typeof import('./agent-workspace-manager')
type ConfigPathsModule = typeof import('./config-paths')

let manager: AgentWorkspaceManager
let configPaths: ConfigPathsModule
let tempHome: string
const originalHome = process.env.HOME
const originalAppDev = process.env.CANOPY_DEV

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'canopy-agent-workspace-manager-'))
  process.env.HOME = tempHome
  process.env.CANOPY_DEV = '0'
  configPaths = await import('./config-paths')
  manager = await import('./agent-workspace-manager')
})

beforeEach(() => {
  rmSync(join(tempHome, CANOPY_BRAND.configDirName), { recursive: true, force: true })
  mkdirSync(join(tempHome, CANOPY_BRAND.configDirName), { recursive: true })
})

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalAppDev === undefined) {
    delete process.env.CANOPY_DEV
  } else {
    process.env.CANOPY_DEV = originalAppDev
  }
  rmSync(tempHome, { recursive: true, force: true })
})

function writeWorkspaceSkill(workspaceSlug: string, skillSlug: string, name: string): void {
  const skillDir = join(configPaths.getWorkspaceSkillsDir(workspaceSlug), skillSlug)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf-8')
}

describe('Agent 工作区 MCP 配置', () => {
  test('Given 工作区 MCP 包含内置保留名 When 归一化配置 Then 剔除冲突项并保留普通服务器', async () => {
    const normalized = manager.normalizeWorkspaceMcpConfig({
      servers: {
        automation: {
          type: 'stdio',
          command: 'custom-automation',
          enabled: true,
        },
        nano_banana: {
          type: 'stdio',
          command: 'custom-nano',
          enabled: true,
        },
        github: {
          type: 'stdio',
          command: 'github-mcp',
          enabled: true,
        },
      },
    })

    expect(Object.keys(normalized.servers).sort()).toEqual(['github'])
    expect(normalized.servers.github?.command).toBe('github-mcp')
  })
})

describe('项目术语迁移', () => {
  test('Given 新安装 When 创建默认项目 Then 使用项目名称', async () => {
    const workspace = manager.ensureDefaultWorkspace()

    expect(workspace.name).toBe('默认项目')
  })
})

describe('Agent 工作区创建', () => {
  test('Given 项目名称是 Windows 保留设备名 When 创建工作区 Then slug 避免直接使用保留名', async () => {
    const workspace = await manager.createAgentWorkspace('CON')

    expect(workspace.slug).toBe('workspace-con')
    expect(existsSync(configPaths.getAgentWorkspacePath(workspace.slug))).toBe(true)
  })

  test('Given 默认 Skill 包含 blocklist 目录 When 创建工作区 Then 初始化 Skills 时跳过高风险目录', async () => {
    const defaultSkillDir = join(configPaths.getDefaultSkillsDir(), 'sample-skill')
    mkdirSync(join(defaultSkillDir, '.git', 'objects'), { recursive: true })
    mkdirSync(join(defaultSkillDir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(defaultSkillDir, 'SKILL.md'), '---\nname: Sample\n---\n', 'utf-8')
    writeFileSync(join(defaultSkillDir, '.git', 'objects', 'locked'), 'skip', 'utf-8')
    writeFileSync(join(defaultSkillDir, 'node_modules', 'pkg', 'index.js'), 'skip', 'utf-8')

    const workspace = await manager.createAgentWorkspace('Filtered Copy')
    const copiedSkillDir = join(configPaths.getWorkspaceSkillsDir(workspace.slug), 'sample-skill')

    expect(existsSync(join(copiedSkillDir, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(copiedSkillDir, '.git'))).toBe(false)
    expect(existsSync(join(copiedSkillDir, 'node_modules'))).toBe(false)
  })
})

describe('Agent 工作区 Skill 扫描', () => {
  test('Given Skills 目录包含 broken symlink When 获取工作区 Skills Then 跳过坏条目并继续扫描后续 Skill', async () => {
    const workspaceSlug = 'workspace-a'
    const skillsDir = configPaths.getWorkspaceSkillsDir(workspaceSlug)

    writeWorkspaceSkill(workspaceSlug, 'alpha', 'Alpha')
    symlinkSync(join(skillsDir, 'missing-target'), join(skillsDir, 'broken-link'), 'dir')
    writeWorkspaceSkill(workspaceSlug, 'zeta', 'Zeta')

    for (let i = 0; i < 20; i++) {
      const entryNames = readdirSync(skillsDir)
      const brokenIndex = entryNames.indexOf('broken-link')
      const hasSkillAfterBroken = entryNames.slice(brokenIndex + 1).some((name) => name !== 'missing-target')
      if (brokenIndex !== -1 && hasSkillAfterBroken) break
      writeWorkspaceSkill(workspaceSlug, `tail-${i}`, `Tail ${i}`)
    }

    const finalEntryNames = readdirSync(skillsDir)
    const finalBrokenIndex = finalEntryNames.indexOf('broken-link')
    expect(finalBrokenIndex).not.toBe(-1)
    expect(finalEntryNames.slice(finalBrokenIndex + 1).some((name) => name !== 'missing-target')).toBe(true)

    const expectedSlugs = finalEntryNames
      .filter((name) => name !== 'broken-link')
      .sort()
    const skills = manager.getWorkspaceSkills(workspaceSlug)

    expect(skills.map((skill) => skill.slug).sort()).toEqual(expectedSlugs)
  })
})

describe('Agent 工作区 Skill 批量导入', () => {
  test('Given 来源有多个 Skill When 批量导入 Then 成功复制并记录来源，重复项跳过', async () => {
    writeWorkspaceSkill('source', 'alpha', 'Alpha')
    writeWorkspaceSkill('source', 'beta', 'Beta')

    const imported = await manager.batchImportSkillsFromWorkspaces('target', [
      { sourceSlug: 'source', skillSlug: 'alpha' },
      { sourceSlug: 'source', skillSlug: 'beta' },
    ])

    expect(imported.imported).toBe(2)
    expect(imported.skipped).toBe(0)
    expect(imported.failed).toBe(0)
    expect(existsSync(join(configPaths.getWorkspaceSkillsDir('target'), 'alpha', 'SKILL.md'))).toBe(true)
    expect(JSON.parse(readFileSync(join(configPaths.getWorkspaceSkillsDir('target'), 'alpha', '.source.json'), 'utf-8'))).toMatchObject({
      sourceWorkspaceSlug: 'source',
    })

    const duplicate = await manager.batchImportSkillsFromWorkspaces('target', [
      { sourceSlug: 'source', skillSlug: 'alpha' },
    ])
    expect(duplicate.imported).toBe(0)
    expect(duplicate.skipped).toBe(1)
    expect(duplicate.failed).toBe(0)
  })

  test('Given 目标 inactive 目录已有同名 Skill When 批量导入 Then 跳过且不覆盖', async () => {
    writeWorkspaceSkill('source', 'inactive-skill', 'Source Skill')
    const inactivePath = join(configPaths.getInactiveSkillsDir('target'), 'inactive-skill')
    mkdirSync(inactivePath, { recursive: true })
    writeFileSync(join(inactivePath, 'SKILL.md'), '---\nname: Existing Skill\n---\n', 'utf-8')

    const result = await manager.batchImportSkillsFromWorkspaces('target', [
      { sourceSlug: 'source', skillSlug: 'inactive-skill' },
    ])

    expect(result.skipped).toBe(1)
    expect(result.failed).toBe(0)
    expect(readFileSync(join(inactivePath, 'SKILL.md'), 'utf-8')).toContain('Existing Skill')
  })

  test('Given 两个来源并发导入同名 Skill When 批量导入 Then 只保留第一个完成项且另一个跳过', async () => {
    writeWorkspaceSkill('source-a', 'shared-skill', 'Source A')
    writeWorkspaceSkill('source-b', 'shared-skill', 'Source B')

    const [fromA, fromB] = await Promise.all([
      manager.batchImportSkillsFromWorkspaces('target', [{ sourceSlug: 'source-a', skillSlug: 'shared-skill' }]),
      manager.batchImportSkillsFromWorkspaces('target', [{ sourceSlug: 'source-b', skillSlug: 'shared-skill' }]),
    ])

    expect(fromA.imported + fromB.imported).toBe(1)
    expect(fromA.skipped + fromB.skipped).toBe(1)
    expect(fromA.failed + fromB.failed).toBe(0)
    const importedContent = readFileSync(join(configPaths.getWorkspaceSkillsDir('target'), 'shared-skill', 'SKILL.md'), 'utf-8')
    expect(['Source A', 'Source B'].some((name) => importedContent.includes(name))).toBe(true)
  })

  test('Given 来源缺失或导入中元数据写入失败 When 批量导入 Then 返回失败且不留下目标残片', async () => {
    const missing = await manager.batchImportSkillsFromWorkspaces('target', [
      // 旧实现会因错误文案包含“已存在”而误判为 skipped。
      { sourceSlug: 'source', skillSlug: '已存在' },
    ])
    expect(missing.failed).toBe(1)
    expect(missing.skipped).toBe(0)

    const malformedSource = join(configPaths.getWorkspaceSkillsDir('source'), 'malformed')
    mkdirSync(malformedSource, { recursive: true })
    writeFileSync(join(malformedSource, 'SKILL.md'), '---\nname: Malformed\n---\n', 'utf-8')
    // cpSync 会复制该目录；随后写入 .source.json 必须失败，验证临时目录回滚。
    mkdirSync(join(malformedSource, '.source.json'))

    const result = await manager.batchImportSkillsFromWorkspaces('target', [
      { sourceSlug: 'source', skillSlug: 'malformed' },
    ])
    const targetSkillsDir = configPaths.getWorkspaceSkillsDir('target')

    expect(result.failed).toBe(1)
    expect(result.skipped).toBe(0)
    expect(existsSync(join(targetSkillsDir, 'malformed'))).toBe(false)
    expect(readdirSync(targetSkillsDir).some((name) => name.startsWith('.malformed.importing-'))).toBe(false)
  })
})

describe('工作区 AGENTS.md 迁移', () => {
  test('Given 旧工作区仅有 CLAUDE.md When 迁移 Then 原子改名为 AGENTS.md 且内容完整保留', async () => {
    const workspace = await manager.createAgentWorkspace('Legacy Instruction')
    const workspaceRoot = configPaths.getAgentWorkspacePath(workspace.slug)
    const legacyPath = join(workspaceRoot, 'CLAUDE.md')
    const agentsPath = join(workspaceRoot, 'AGENTS.md')
    writeFileSync(legacyPath, '# stable rules\n', 'utf-8')

    manager.migrateWorkspaceInstructionFiles()

    expect(existsSync(legacyPath)).toBe(false)
    expect(readFileSync(agentsPath, 'utf-8')).toBe('# stable rules\n')
    expect(manager.getWorkspaceMemorySummary(workspace.slug).agentsMd.path).toBe(agentsPath)
  })

  test('Given 迁移已完成 When 重复执行 Then 不改变 AGENTS.md', async () => {
    const workspace = await manager.createAgentWorkspace('Idempotent Instruction')
    const agentsPath = join(configPaths.getAgentWorkspacePath(workspace.slug), 'AGENTS.md')
    writeFileSync(agentsPath, '# existing rules\n', 'utf-8')

    manager.migrateWorkspaceInstructionFiles()
    manager.migrateWorkspaceInstructionFiles()

    expect(readFileSync(agentsPath, 'utf-8')).toBe('# existing rules\n')
  })

  test('Given 双文件内容相同 When 迁移 Then 仅清理 legacy 副本', async () => {
    const workspace = await manager.createAgentWorkspace('Duplicate Instruction')
    const workspaceRoot = configPaths.getAgentWorkspacePath(workspace.slug)
    const legacyPath = join(workspaceRoot, 'CLAUDE.md')
    const agentsPath = join(workspaceRoot, 'AGENTS.md')
    writeFileSync(legacyPath, '# shared rules\n', 'utf-8')
    writeFileSync(agentsPath, '# shared rules\n', 'utf-8')

    manager.migrateWorkspaceInstructionFiles()

    expect(existsSync(legacyPath)).toBe(false)
    expect(readFileSync(agentsPath, 'utf-8')).toBe('# shared rules\n')
  })

  test('Given 双文件内容冲突 When 迁移 Then 两份规则均保留', async () => {
    const workspace = await manager.createAgentWorkspace('Conflicting Instruction')
    const workspaceRoot = configPaths.getAgentWorkspacePath(workspace.slug)
    const legacyPath = join(workspaceRoot, 'CLAUDE.md')
    const agentsPath = join(workspaceRoot, 'AGENTS.md')
    writeFileSync(legacyPath, '# legacy rules\n', 'utf-8')
    writeFileSync(agentsPath, '# new rules\n', 'utf-8')

    manager.migrateWorkspaceInstructionFiles()

    expect(readFileSync(legacyPath, 'utf-8')).toBe('# legacy rules\n')
    expect(readFileSync(agentsPath, 'utf-8')).toBe('# new rules\n')
    expect(manager.getWorkspaceMemorySummary(workspace.slug).instructionConflict).toEqual({
      legacyPath,
      agentsPath,
    })
  })
})

describe('工作区记忆文件原子写', () => {
  test('Given 记忆文件已存在 When 覆盖写入 Then 落盘内容完整替换', async () => {
    const workspace = await manager.createAgentWorkspace('Memory Atomic Write')
    manager.writeWorkspaceAutoMemoryFile(workspace.slug, 'MEMORY.md', '# 旧索引\n')

    manager.writeWorkspaceAutoMemoryFile(workspace.slug, 'MEMORY.md', '# 新索引\n- entry\n')

    const abs = join(manager.getWorkspaceAutoMemoryDir(workspace.slug), 'MEMORY.md')
    expect(readFileSync(abs, 'utf-8')).toBe('# 新索引\n- entry\n')
  })

  test('Given 写入完成 When 检查目录 Then 不留下 .tmp 中间文件', async () => {
    const workspace = await manager.createAgentWorkspace('Memory No Temp')
    manager.writeWorkspaceAutoMemoryFile(workspace.slug, 'notes.md', '# 笔记\n')

    const dir = manager.getWorkspaceAutoMemoryDir(workspace.slug)
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  test('Given 记忆文件与工作区 AGENTS.md 被覆盖写 When 检查目录 Then 不产生用户可见的 .bak 伴生文件', async () => {
    // writeTextFileAtomic 默认留 .bak（给会话正文用），但记忆目录 / 工作区根是用户与 Agent 都看得见的地方，
    // 这两处调用刻意 skipBackup——这条用例防止将来有人把默认值改回来时无声污染工作区
    const workspace = await manager.createAgentWorkspace('Memory No Bak')
    manager.writeWorkspaceAutoMemoryFile(workspace.slug, 'MEMORY.md', '# v1\n')
    manager.writeWorkspaceAutoMemoryFile(workspace.slug, 'MEMORY.md', '# v2\n')
    manager.writeWorkspaceAgentsMd(workspace.slug, '# 规则 v1\n')
    manager.writeWorkspaceAgentsMd(workspace.slug, '# 规则 v2\n')

    const memoryDir = manager.getWorkspaceAutoMemoryDir(workspace.slug)
    expect(readdirSync(memoryDir).filter((name) => name.endsWith('.bak'))).toEqual([])
    const workspaceRoot = join(manager.getWorkspaceAgentsMdPath(workspace.slug), '..')
    expect(readdirSync(workspaceRoot).filter((name) => name.endsWith('AGENTS.md.bak'))).toEqual([])
    expect(readFileSync(manager.getWorkspaceAgentsMdPath(workspace.slug), 'utf-8')).toBe('# 规则 v2\n')
  })

  test('Given 目录残留崩溃产生的 .tmp When 列出记忆文件 Then 不展示该临时文件', async () => {
    const workspace = await manager.createAgentWorkspace('Memory Tmp Leftover')
    manager.writeWorkspaceAutoMemoryFile(workspace.slug, 'kept.md', '# 保留\n')
    const dir = manager.getWorkspaceAutoMemoryDir(workspace.slug)
    writeFileSync(join(dir, 'kept.md.tmp'), '# 半截内容', 'utf-8')

    const names = manager.listWorkspaceAutoMemoryFiles(workspace.slug).map((node) => node.relativePath)

    expect(names).toContain('kept.md')
    expect(names).not.toContain('kept.md.tmp')
  })

  test('Given 多级子目录路径 When 写入 Then 自动建目录且内容正确', async () => {
    const workspace = await manager.createAgentWorkspace('Memory Nested Dir')

    manager.writeWorkspaceAutoMemoryFile(workspace.slug, 'topics/git/rebase.md', '# rebase\n')

    const abs = join(manager.getWorkspaceAutoMemoryDir(workspace.slug), 'topics', 'git', 'rebase.md')
    expect(readFileSync(abs, 'utf-8')).toBe('# rebase\n')
  })
})

describe('附加路径可用状态（取代启动时静默删配置）', () => {
  test('Given 真实存在的目录 When 查询状态 Then 为 available', async () => {
    const dir = join(tempHome, 'attached-available')
    mkdirSync(dir, { recursive: true })

    expect(manager.getAttachedPathStatus(dir)).toBe('available')
  })

  test('Given 路径不存在 When 查询状态 Then 为 missing 而不是被删除', async () => {
    // 外接盘未插、网络盘未挂载时就是这个状态：只标记，配置必须原样保留。
    const missing = join(tempHome, 'attached-not-there')

    expect(manager.getAttachedPathStatus(missing)).toBe('missing')
  })

  test('Given 存在的普通文件 When 查询状态 Then 同样为 available', async () => {
    const file = join(tempHome, 'attached-file.txt')
    writeFileSync(file, 'x', 'utf-8')

    expect(manager.getAttachedPathStatus(file)).toBe('available')
  })

  test('Given 一组混合路径 When 批量查询 Then 顺序不变且逐项给出状态', async () => {
    const good = join(tempHome, 'attached-batch-ok')
    mkdirSync(good, { recursive: true })
    const bad = join(tempHome, 'attached-batch-missing')

    const states = manager.getAttachedPathStatuses([good, bad])

    expect(states).toEqual([
      { path: good, status: 'available' },
      { path: bad, status: 'missing' },
    ])
  })

  test('Given 空数组 When 批量查询 Then 返回空数组', async () => {
    expect(manager.getAttachedPathStatuses([])).toEqual([])
  })
})

describe('长期记忆目录只读查询（文件预览候选基路径用）', () => {
  test('Given 工作区已有 memory/ 目录 When 只读查询 Then 返回该目录路径', async () => {
    const workspace = await manager.createAgentWorkspace('Memory Lookup')
    const memoryDir = manager.getWorkspaceAutoMemoryDir(workspace.slug)
    writeFileSync(join(memoryDir, 'windows-software-install.md'), '# 记忆', 'utf-8')

    expect(manager.getExistingWorkspaceAutoMemoryDir(workspace.slug)).toBe(memoryDir)
  })

  test('Given 工作区尚无 memory/ 目录 When 只读查询 Then 返回 undefined 且不创建目录', async () => {
    // 预览热路径不能顺手 mkdir：查一次不该在用户目录里留下空文件夹。
    const workspace = await manager.createAgentWorkspace('Memory Absent')
    const expectedDir = join(configPaths.getAgentWorkspacePath(workspace.slug), 'memory')
    rmSync(expectedDir, { recursive: true, force: true })

    expect(manager.getExistingWorkspaceAutoMemoryDir(workspace.slug)).toBeUndefined()
    expect(existsSync(expectedDir)).toBe(false)
  })
})
