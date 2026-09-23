# Canopy Community 开发约定

Canopy Community 是一个本地优先的 Electron AI 桌面 Agent。仓库是 Bun monorepo：主应用在 `apps/electron`，共享包在 `packages/*`。

本文件写给参与开发的人，也写给在本仓库里工作的 AI 编码助手。

## 必须遵守

- 使用 **Bun**，不使用 npm / pnpm：`bun install`、`bun run dev`、`bun run typecheck`、`bun test`。
- 注释、日志与面向用户的文案以中文为主，保留必要的技术术语。
- 不使用 `any`；对象类型优先 `interface`，仅类型导入用 `import type`。
- 渲染层状态统一用 Jotai。保持组件化、可读、最小设计，避免过度抽象。
- 新增依赖前先调研，写明版本与维护状态；已被 esbuild / Vite 打进 bundle 的纯 JS 库放 `devDependencies`，否则会被整包复制进安装包。
- 本地优先：持久化用可移植的 JSON / JSONL 文件，不引入本地数据库。
- 写 JSON 配置或会话元数据必须用 `packages/kernel/src/safe-file.ts` 的原子写封装，不要直接 `writeFileSync`。
- 功能改动要有 BDD 风格（Given / When / Then）的可执行测试，至少覆盖正常路径和主要边界；纯逻辑抽成独立文件，便于单测。
- 改 UI 时复用 `apps/electron/src/renderer/components/ui/` 里既有的 Radix / shadcn 组件与主题变量；照顾空状态、键盘操作、加载态和深浅主题。
- 含反斜杠的源码（正则、Windows 路径、转义字符串）不要经 shell heredoc 写入，容易被折掉反斜杠。

## 常用命令

```bash
bun install
bun run dev                        # vite + electron 热重载，数据在 ~/.canopy-community-dev/
bun run typecheck                  # 全部包；看每个包的「Exited with code」，聚合退出码恒为 0
bun run electron:build             # main / preload / renderer 等构建管线
bun run dist:win | dist:mac | dist:linux
```

测试分散在各个包里，`bun run --filter='*' test` 只覆盖带 `test` 脚本的包；`apps/electron`、`packages/shared`、`packages/core` 需要进入目录单独运行 `bun test`。判断是否回归，以单文件运行相关测试为准。

## 目录与边界

```text
apps/electron/                    Electron 主应用
  src/main/                       主进程：窗口、文件、Agent 编排、IPC handler
  src/main/lib/                   主进程服务（按前缀分区：agent-* / channel-* / browser-* …）
  src/preload/                    类型安全的 IPC bridge
  src/renderer/                   React + Vite + Tailwind 界面
  default-skills/                 随应用分发的默认 Skills
packages/brand/                   产品名、appId、数据目录名等品牌常量的唯一来源
packages/shared/                  类型、IPC 通道常量、通用工具
packages/core/                    模型供应商适配器、SSE、代码高亮
packages/kernel/                  Runtime 无关的内核：插件契约、会话存储、原子写
packages/runtime-pi/              Pi Runtime 插件（唯一可在运行时 import @earendil-works/pi-* 的包）
packages/session-core/            会话读取、检索与渲染
packages/business-automation/     定时任务
packages/business-im-bridge/      飞书 / 钉钉 / 微信桥接
packages/ui/                      跨应用共享 UI
```

### IPC 是四层契约

新增或修改 IPC 时，四处必须同步：

1. `packages/shared` 的通道常量与请求 / 响应类型；
2. `apps/electron/src/main/ipc.ts` 的 handler；
3. `apps/electron/src/preload/index.ts` 的 bridge；
4. 渲染层的调用、错误处理与状态更新。

handler 里只做参数校验与转发，业务逻辑放在 `src/main/lib/`，这样才能写单元测试。

### Agent Runtime

- 内核层（`packages/kernel`）不得硬编码任何具体 Runtime 的类型、协议或打包依赖；Runtime 通过内核定义的 `AgentRuntimePlugin` 接口接入。当前唯一的 Runtime 插件是 `packages/runtime-pi`。
- 新增或替换 Runtime 须新建独立的 `packages/runtime-*` 包并完整实现内核接口，不得让内核层或业务层反向依赖某个 Runtime 的私有类型。
- 不要引入 Claude Agent SDK 或其配置、会话语义与打包依赖。

### 项目指令与工作区

- 用户项目的 `AGENTS.md` 由 `project-instruction-resolver.ts` 在已授权的项目根内显式解析；不做 cwd、祖先目录或附加目录的环境式规则发现。
- 受管工作区的 `AGENTS.md` 与用户项目的 `AGENTS.md` 所有权不同，均须通过已验证的显式路径注入。
- 旧项目的 `CLAUDE.md` 只是兼容输入，不能自动覆盖、合并或删除用户文件。
- 改动 Agent 工具、权限或上下文路径时，检查工作区隔离、附加目录边界、会话恢复，以及定时任务与协作子 Agent 的回归。
- 附加路径判定为不可用时只标灰、由用户手动移除；不要因为一次 `existsSync` 失败就删除用户配置。

### 默认 Skills

修改 `apps/electron/default-skills/<skill>/` 下的任何内容时，必须同时递增该 Skill `SKILL.md` frontmatter 的 `version`（patch +1），否则已安装用户的工作区不会收到更新。

## 版本与提交

- 改动影响某个包的行为时，递增该包 `package.json` 的 patch 版本；`apps/electron/package.json` 是桌面应用版本。
- 提交信息用 `type(scope): 一句话`，正文写清原因与做法。
- 提交前检查 `git diff`，不要提交无关文件。
