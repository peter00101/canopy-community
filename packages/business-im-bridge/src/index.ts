export {
  configureImBridgeBusiness,
  type ImBridgeBusinessDeps,
  type ImBridgePathResolver,
  type ImBridgeAppSettings,
  type ImBridgeWorkspaceLookup,
  type ImBridgeChannelRegistry,
  type ImBridgeAgentRunnerDeps,
  type ImBridgeWindowBroadcast,
  type ImBridgeSafeStorage,
  type ImBridgePowerMonitor,
} from './im-bridge-business-deps'

export {
  registerBridge,
  startAllBridges,
  startBridgeSelfHealing,
  stopBridgeSelfHealing,
  stopAllBridges,
  recoverAllBridges,
  type BridgeRegistration,
  type BridgeSelfHealingOptions,
} from './bridge-registry'

export {
  BridgeCommandHandler,
  type BridgePlatformAdapter,
  type BridgeAttachment,
  type BridgeCommandHandlerConfig,
  type BridgeChatBinding,
} from './bridge-command-handler'

export {
  getFeishuConfig,
  saveFeishuConfig,
  getDecryptedAppSecret,
  getFeishuMultiBotConfig,
  getFeishuBotById,
  saveFeishuBotConfig,
  removeFeishuBot,
  getDecryptedBotAppSecret,
} from './feishu-config'
export { FeishuBridge } from './feishu-bridge'
export { feishuBridgeManager } from './feishu-bridge-manager'

export {
  getDingTalkConfig,
  saveDingTalkConfig,
  getDecryptedClientSecret,
  getDingTalkMultiBotConfig,
  getDingTalkBotById,
  saveDingTalkBotConfig,
  removeDingTalkBot,
  getDecryptedBotClientSecret,
} from './dingtalk-config'
export { DingTalkBridge } from './dingtalk-bridge'
export { dingtalkBridgeManager } from './dingtalk-bridge-manager'

export {
  getWeChatConfig,
  getDecryptedCredentials,
  saveWeChatCredentials,
  clearWeChatCredentials,
  updateWeChatDefaultWorkspace,
} from './wechat-config'
export { wechatBridge } from './wechat-bridge'

export {
  FeishuSyncSleepBlocker,
  shouldPreventSleepForFeishuSync,
  type SleepBlockerAdapter,
  type SleepBlockerType,
} from './feishu/sleep-blocker'
