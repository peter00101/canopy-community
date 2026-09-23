/**
 * IM 桥接（飞书/钉钉/微信）业务包的 Electron 侧装配点。
 *
 * `@canopy/business-im-bridge` 只依赖窄接口（路径 / 应用设置 / 工作区查询 /
 * 渠道查询 / Agent headless 运行 / 窗口广播 / safeStorage / powerMonitor），
 * 本文件在模块加载时用真实的 Electron 实现装配一次（与 `agent-service.ts`/
 * `automation-service.ts` 同一惯例），保证只要 `main/index.ts` 引用过本文件，
 * 之后任何消费方直接从 `@canopy/business-im-bridge` 导入的函数都能正常工作。
 */

import { BrowserWindow, safeStorage, powerMonitor } from 'electron'
import { configureImBridgeBusiness } from '@canopy/business-im-bridge'
import {
  getFeishuConfigPath,
  getFeishuBotBindingsPath,
  getFeishuBotMetadataPath,
  getDingTalkConfigPath,
  getDingTalkBotBindingsPath,
  getWeChatConfigPath,
  getWeChatBindingsPath,
  getWeChatSyncPath,
  getAgentSessionWorkspacePath,
  resolveAgentSessionWorkspacePath,
} from './config-paths'
import { getSettings } from './settings-service'
import {
  getAgentWorkspace,
  getProjectFilesPath,
  getWorkspaceCapabilities,
  listAgentWorkspacesByUpdatedAt,
} from './agent-workspace-manager'
import { listChannels, getChannelById } from './channel-manager'
import { runAgentHeadless, stopAgent, isAgentSessionActive, agentEventBus } from './agent-service'
import { getMainWindow } from './main-window-store'

configureImBridgeBusiness({
  paths: {
    getFeishuConfigPath,
    getFeishuBotBindingsPath,
    getFeishuBotMetadataPath,
    getDingTalkConfigPath,
    getDingTalkBotBindingsPath,
    getWeChatConfigPath,
    getWeChatBindingsPath,
    getWeChatSyncPath,
    getAgentSessionWorkspacePath,
    resolveAgentSessionWorkspacePath,
  },
  getSettings: () => {
    const settings = getSettings()
    return {
      agentChannelId: settings.agentChannelId,
      agentWorkspaceId: settings.agentWorkspaceId,
      agentModelId: settings.agentModelId,
      feishuSessionMirror: settings.feishuSessionMirror,
    }
  },
  workspaces: {
    getAgentWorkspace,
    getProjectFilesPath,
    getWorkspaceCapabilities,
    listAgentWorkspacesByUpdatedAt,
  },
  channels: {
    listChannels,
    getChannelById,
  },
  agentRunner: {
    runAgentHeadless,
    stopAgent,
    isAgentSessionActive,
    onAgentEvent: (handler) => agentEventBus.on(handler),
  },
  window: {
    sendToMainWindow: (channel, payload) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send(channel, payload)
      }
    },
    broadcastToAllWindows: (channel, payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(channel, payload)
        }
      }
    },
  },
  safeStorage,
  powerMonitor,
})

export * from '@canopy/business-im-bridge'
