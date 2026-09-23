# Canopy Community

A local-first, open-source AI desktop agent. Bring your own model API keys, and it works on your machine — reading and writing files, running commands, using a browser, editing Office documents — to carry a task from start to finish.

Runs on Windows, macOS (Apple Silicon) and Linux (experimental).

[中文](./README.md) · [Tutorial (Chinese)](./apps/electron/resources/tutorial.md) · [Engineering conventions](./AGENTS.md)

## What it does

**Two ways to work**

- **Chat** — lightweight conversations for Q&A, writing and translation, with attachments, images, Markdown / Mermaid / KaTeX.
- **Agent** — multi-step tool use to get a task done: edit project files, run commands, browse the web, produce documents, with every step visible.

**Works inside your projects**

- Per-project workspaces with their own Skills and MCP configuration; mount a local folder or use a managed empty one.
- **Changes panel** — see every file the agent touched with line-by-line diffs, and revert a single file in one click.
- **Visible terminal** — commands run in a real terminal in the side panel that you can watch and take over.
- **Plan mode** — have the agent write a plan first and run it only after you approve, or send feedback to revise it.

**Office documents and design files**

- Bundled OfficeCLI lets the agent read and edit `.docx` / `.xlsx` / `.pptx` directly (formulas are recalculated on write) — no Python or Office install needed. Legacy `.doc` / `.xls` / `.ppt` files can be read.
- `canopy-ppt` — from outline and style to page layout, producing PPTX files with editable text, or a single-file web deck.
- `canopy-psd` — read, compose and edit layered PSD files (text layers, vector shapes, adjustment layers, artboards, smart objects), with a live preview that can toggle layer visibility.

**Previews**

Markdown (math, in-place table editing, outline), PDF (lazy rendering, full-text search), Office, spreadsheets with hundreds of thousands of rows (virtual scrolling), images and HTML.

**Extensions and automation**

- **Skills** and **MCP** (including OAuth-protected remote MCP servers).
- **Project memory** — the agent maintains an `AGENTS.md` grounded in verifiable evidence from your project.
- **Built-in browser** — sign in yourself, then hand the page to the agent for research, comparison or form filling.
- **Scheduled tasks, todos and calendar**.
- **Remote bots** — Feishu / DingTalk / WeChat bridges to drive the agent on your computer from your phone.

**Also**

Voice input, a vision assistant that adds image understanding to text-only models, automatic context compaction (adjustable threshold), token usage statistics, and 12 color themes.

## Supported model providers

Anthropic, OpenAI (Chat Completions and Responses), ChatGPT subscription sign-in (Codex), xAI, Google Gemini, DeepSeek, Kimi (API / Coding Plan), Zhipu (API / Coding Plan), Volcengine Ark Coding Plan, Doubao, Qwen (including Token Plan), MiniMax, Xiaomi MiMo, OpenCode Go, plus any Anthropic- or OpenAI-compatible endpoint (for self-hosted gateways and relays).

Agent mode works with all of the above protocols; Chat mode does not yet support subscription sign-in providers.

## Getting started

Requires [Bun](https://bun.sh) 1.3 or later and Git.

```bash
git clone https://github.com/peter00101/canopy-community.git
cd canopy-community
bun install
bun run dev
```

Then open **Settings → Models → Add**, pick a provider and paste your own API key.

Building installers:

```bash
bun run dist:win     # Windows (NSIS)
bun run dist:mac     # macOS (Apple Silicon)
bun run dist:linux   # Linux (AppImage / deb, experimental)
```

The build downloads OfficeCLI from GitHub and verifies its SHA-256. Self-built installers are not code-signed: Windows shows an "unknown publisher" warning, and on macOS you need to right-click → Open or run `xattr -cr`.

## Data and safety

- Sessions, settings and Skills live in `~/.canopy-community/` as plain JSON / JSONL files — no database, easy to back up and move.
- API keys are encrypted with the system keychain (Electron safeStorage).
- Canopy Community itself collects no usage data; requests go only to the model providers you configure and the services you enable.
- **The agent runs in fully automatic mode by default** and can read and write files and run commands directly. Keep important projects under Git, or switch to plan mode to approve before execution.

## Development

A Bun monorepo: the app lives in `apps/electron`, shared packages in `packages/*`.

```bash
bun run typecheck                 # type-check every package
cd apps/electron && bun test      # run tests inside each package directory
```

See [AGENTS.md](./AGENTS.md) for engineering conventions (the four-layer IPC contract, state management, testing requirements). Issues and pull requests are welcome.

## Acknowledgements

Canopy Community stands on the shoulders of many open-source projects. Thanks to them and their contributors:

- [Proma](https://github.com/proma-ai/Proma) — the upstream project Canopy Community is modified from.
- [Pi](https://github.com/earendil-works/pi) — the agent runtime.
- [Craft Agents OSS](https://github.com/craft-ai-agents/craft-agents-oss) — reference for agent SDK integration patterns.
- [Kimi Code](https://github.com/MoonshotAI/kimi-code) — ideas such as the video input protocol.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — ideas on context compaction and presenting agent execution.
- [deepseek-vision](https://github.com/ErlichLiu/deepseek-vision) — the "vision middleware" idea behind the vision assistant.
- [Cherry Studio](https://github.com/CherryHQ/cherry-studio) — a multi-provider desktop AI client that inspired the composer, file previews and streaming rendering.
- [MyAgents](https://github.com/hAcKlyc/MyAgents) and [OpenHanako](https://github.com/liliMozi/openhanako) — ideas on engineering practices, memory and theming.
- [open-kimi-ppt-skill](https://github.com/acnlie/open-kimi-ppt-skill), [ppt-master](https://github.com/hugohe3/ppt-master) and [harness-anything](https://github.com/yb2460/harness-anything) — ideas behind the outline, layout and SVG page contract of `canopy-ppt`.
- [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) — the Office document reading, editing and preview engine.
- [ag-psd](https://github.com/Agamnentzar/ag-psd) and [psd-tools](https://github.com/psd-tools/psd-tools) — PSD reading, writing and high-fidelity compositing.
- [guizang-ppt-skill](https://github.com/op7418/guizang-ppt-skill) — the bundled web-deck Skill.
- [skill-creator](https://github.com/anthropics/skills) — the bundled Skill for creating and evaluating Skills.
- [Shiki](https://shiki.style/), [Mermaid](https://mermaid.js.org/) with [Beautiful Mermaid](https://github.com/lukilabs/beautiful-mermaid), and [Lobe Icons](https://github.com/lobehub/lobe-icons) — code highlighting, diagram rendering and model brand icons.

Project names and trademarks belong to their respective owners. They are listed here only to express our thanks and do not imply endorsement of or involvement in this project.

## License

Released under the [GNU AGPL-3.0](./LICENSE).

Canopy Community is a modified version of [Proma](https://github.com/proma-ai/Proma) (AGPL-3.0); the original copyright and license notices are preserved. See [NOTICE](./NOTICE) for a summary of modifications.

Bundled third-party components keep their own licenses: Pi (MIT), ag-psd (MIT), OfficeCLI (Apache-2.0), guizang-ppt-skill (MIT), skill-creator (Apache-2.0), UI sound effects and illustrations (CC0). psd-tools (MIT) is not bundled; it is used only when a local Python installation provides it.
