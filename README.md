# Canopy Community

一个本地优先的开源 AI 桌面 Agent。你接入自己的模型 API，它在你的电脑上读写文件、跑命令、用浏览器、改 Office 文档，把一件事从头做到尾。

支持 Windows、macOS（Apple Silicon）与 Linux（实验性）。

[English](./README.en.md) · [使用教程](./apps/electron/resources/tutorial.md) · [开发约定](./AGENTS.md)

## 它能做什么

**两种工作方式**

- **Chat**：轻量对话，适合问答、写作、翻译，支持附件、图片、Markdown / Mermaid / KaTeX。
- **Agent**：多轮调用工具完成任务——读写项目文件、执行命令、打开网页、生成文档，过程逐步可见。

**在你的项目里干活**

- 每个项目独立的工作区、Skills 与 MCP 配置；可以挂载本地项目目录，也可以用托管的空白目录。
- **改动面板**：Agent 改了哪些文件、每处逐行对比，单个文件一键还原。
- **可见终端**：Agent 执行的命令在右侧真实终端里运行，你随时能看、能接手。
- **计划模式**：先让 Agent 写出计划，你批准后再执行；也可以直接给修改意见让它重来。

**办公文档与设计稿**

- 内置 OfficeCLI，Agent 直接读改 `.docx` / `.xlsx` / `.pptx`，公式写入即算，不需要装 Python 或 Office；旧版 `.doc` / `.xls` / `.ppt` 可以读取。
- `canopy-ppt`：从大纲、风格到逐页排版，产出文字可逐字编辑的 PPTX，也可以出单文件网页 PPT。
- `canopy-psd`：读取、合成、编辑分层 PSD（文字层、矢量形状、调整层、画板、智能对象），右侧面板可预览并临时切换图层显隐。

**预览**

Markdown（公式、表格就地编辑、目录）、PDF（按需渲染、全文查找）、Office、十万行级表格（虚拟滚动）、图片、HTML。

**扩展与自动化**

- **Skills** 与 **MCP**（含 OAuth 授权的远程 MCP）。
- **项目记忆**：Agent 基于项目内可验证的证据维护 `AGENTS.md`，记住项目是怎么回事、你习惯怎么做。
- **内置浏览器**：你先登录，再把网页交给 Agent 查资料、比价、填表。
- **定时任务、Todo 与日程**。
- **远程机器人**：飞书 / 钉钉 / 微信桥接，在手机上指挥电脑里的 Agent。

**其它**

语音输入、视觉助手（给不能看图的模型补上图片理解）、上下文自动压缩（阈值可调）、token 用量统计、12 套配色主题。

## 支持的模型渠道

Anthropic、OpenAI（Chat Completions 与 Responses 两种协议）、ChatGPT 订阅登录（Codex）、xAI、Google Gemini、DeepSeek、Kimi（API / Coding Plan）、智谱（API / Coding Plan）、火山方舟 Coding Plan、豆包、通义千问（含 Token Plan）、MiniMax、小米 MiMo、OpenCode Go，以及任意 Anthropic / OpenAI 兼容端点（适合自建网关或中转服务）。

Agent 模式不限定协议，上面各类渠道都可以驱动；Chat 模式暂不支持订阅登录类渠道。

## 快速开始

需要 [Bun](https://bun.sh) 1.3 或更高版本，以及 Git。

```bash
git clone https://github.com/peter00101/canopy-community.git
cd canopy-community
bun install
bun run dev
```

启动后进入 **设置 → 模型配置 → 添加配置**，选择供应商并填入你自己的 API Key，就可以开始用了。

构建安装包：

```bash
bun run dist:win     # Windows 安装包（NSIS）
bun run dist:mac     # macOS（Apple Silicon）
bun run dist:linux   # Linux（AppImage / deb，实验性）
```

构建时会从 GitHub 下载 OfficeCLI 并校验 SHA-256；国内网络可以设置 `ELECTRON_MIRROR` 与 `ELECTRON_BUILDER_BINARIES_MIRROR` 指向镜像。自行构建的安装包没有代码签名，Windows 会提示「未知发布者」，macOS 需要右键打开或执行 `xattr -cr` 解除隔离。

## 数据与安全

- 会话、配置、Skills 等都保存在本机 `~/.canopy-community/`，使用 JSON / JSONL 文件，不依赖数据库，方便备份与迁移。
- API Key 通过系统密钥环（Electron safeStorage）加密后保存。
- Canopy Community 本身不收集任何使用数据；请求只会发往你配置的模型渠道和你主动启用的服务。
- **Agent 默认以「完全自动」权限运行**，可以直接读写文件、执行命令。重要项目请先用 Git 管理，或切换到计划模式，审批后再让它执行。

## 参与开发

仓库是 Bun monorepo：主应用在 `apps/electron`，共享包在 `packages/*`。

```bash
bun run typecheck                 # 全部包类型检查
cd apps/electron && bun test      # 各包在自己的目录下运行测试
```

工程约定（IPC 四层契约、状态管理、测试要求等）见 [AGENTS.md](./AGENTS.md)。欢迎提交 Issue 与 Pull Request。

## 致谢

Canopy Community 站在许多开源项目的肩膀上，感谢这些项目和它们的贡献者：

- [Proma](https://github.com/proma-ai/Proma)：本项目的上游，Canopy Community 基于它修改而来。
- [Pi](https://github.com/earendil-works/pi)：Agent 运行时。
- [Craft Agents OSS](https://github.com/craft-ai-agents/craft-agents-oss)：Agent SDK 集成模式的参考。
- [Kimi Code](https://github.com/MoonshotAI/kimi-code)：视频输入协议等实现思路。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：上下文压缩、执行过程展示等设计思路。
- [deepseek-vision](https://github.com/ErlichLiu/deepseek-vision)：视觉助手的「视觉中间件」思路。
- [Cherry Studio](https://github.com/CherryHQ/cherry-studio)：多供应商桌面 AI 客户端，输入框、文件预览与流式渲染的交互启发。
- [MyAgents](https://github.com/hAcKlyc/MyAgents)、[OpenHanako](https://github.com/liliMozi/openhanako)：工程实践、记忆与主题设计的思路。
- [open-kimi-ppt-skill](https://github.com/acnlie/open-kimi-ppt-skill)、[ppt-master](https://github.com/hugohe3/ppt-master)、[harness-anything](https://github.com/yb2460/harness-anything)：`canopy-ppt` 的大纲、版式与 SVG 页面契约思路。
- [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)：Office 文档读写与预览引擎。
- [ag-psd](https://github.com/Agamnentzar/ag-psd)、[psd-tools](https://github.com/psd-tools/psd-tools)：PSD 文件读写与高保真合成。
- [guizang-ppt-skill](https://github.com/op7418/guizang-ppt-skill)：随包的网页 PPT Skill。
- [skill-creator](https://github.com/anthropics/skills)：随包的 Skill 创建与评测 Skill。
- [Shiki](https://shiki.style/)、[Mermaid](https://mermaid.js.org/) 与 [Beautiful Mermaid](https://github.com/lukilabs/beautiful-mermaid)、[Lobe Icons](https://github.com/lobehub/lobe-icons)：代码高亮、图表渲染与模型品牌图标。

以上项目的名称与商标归各自所有者，列在这里仅表示感谢，不代表其认可或参与本项目。

## 许可证

本项目以 [GNU AGPL-3.0](./LICENSE) 协议发布。

Canopy Community 基于 [Proma](https://github.com/proma-ai/Proma)（AGPL-3.0）修改而来，保留原项目的版权与许可声明；修改说明见 [NOTICE](./NOTICE)。

随附的第三方组件各自遵循其许可：Pi（MIT）、ag-psd（MIT）、OfficeCLI（Apache-2.0）、guizang-ppt-skill（MIT）、skill-creator（Apache-2.0）、界面音效与插画（CC0）。psd-tools（MIT）不随包分发，本机装了 Python 版时才会调用。
