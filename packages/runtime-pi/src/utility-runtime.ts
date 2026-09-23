/**
 * Electron 耦合子路径——`@canopy/runtime-pi/utility-runtime`。
 *
 * 只放跨进程 utility runtime 相关的东西（`PiUtilityAdapter` 经 `agent-runtime-client.ts`
 * 静态 import 了 Electron 的 `MessageChannelMain`/`utilityProcess`），不与主入口
 * `@canopy/runtime-pi` 混在一起，避免任何只想要模型注册表/工具校验等纯逻辑的消费方
 * 被迫连带加载 Electron API。只应由 `apps/electron/src/main/lib/agent-service.ts`
 * （真正跑在 Electron 主进程里）导入。
 */
export { PiUtilityAdapter } from './pi-utility-adapter'
export { createPiRuntimePlugin } from './plugin'
