/**
 * 定时任务（Automation）业务包的 Electron 侧装配点。
 *
 * `@canopy/business-automation` 只依赖窄接口（路径 / Agent headless 运行 / 通知投递 /
 * 渲染窗口广播），本文件在模块加载时用真实的 Electron 实现装配一次
 * （与 `agent-service.ts` 的"模块级单例、启动时装配一次"惯例一致），
 * 保证只要 `main/index.ts` 引用过本文件，之后任何消费方直接从
 * `@canopy/business-automation` 导入的函数都能正常工作。
 */

import { BrowserWindow } from 'electron'
import { AUTOMATION_IPC_CHANNELS } from '@canopy/shared'
import { configureAutomationBusiness } from '@canopy/business-automation'
import { getAutomationsPath } from './config-paths'
import { runAgentHeadless, isAgentSessionActive } from './agent-service'
import { feishuBridgeManager } from './im-bridge-service'

configureAutomationBusiness({
  getAutomationsPath,
  agentRunner: { runAgentHeadless, isAgentSessionActive },
  notificationSender: {
    sendCardToChat: (botId, chatId, card) => feishuBridgeManager.sendCardToChat(botId, chatId, card),
  },
  broadcastAutomationChanged: () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(AUTOMATION_IPC_CHANNELS.CHANGED)
      }
    }
  },
})

export { startScheduler, stopScheduler } from '@canopy/business-automation'
