/**
 * UI 偏好设置状态管理
 *
 * 管理用户界面相关的显示偏好，如输入框 Markdown 渲染等。
 */

import { atom } from 'jotai'
import { DEFAULT_PRODUCTIVITY_TOOLS_SETTINGS, type ProductivityToolsSettings } from '@/types/settings'

// ===== Jotai Atoms =====

/** 粘贴长文本时是否自动转为附件 */
export const longTextPasteAsAttachmentEnabledAtom = atom<boolean>(false)

/** 输入框是否渲染 Markdown 富文本格式（默认开启，所见即所得；关闭后回纯文本模式，仍保留 Mention 引用） */
export const richTextRenderingEnabledAtom = atom<boolean>(true)

/** 左侧会话列表悬浮预览迷你地图（默认关闭，需手动开启） */
export const sessionHoverPreviewEnabledAtom = atom<boolean>(false)

/** Agent 改动文件时自动打开侧面板「改动」标签（默认开启；关掉后只记录不弹出） */
export const agentAutoOpenChangesPanelEnabledAtom = atom<boolean>(true)

/** 生产力工具入口可见性（默认全部可见；初始化后由通用设置同步。我方定制：只控显示） */
export const productivityToolsAtom = atom<ProductivityToolsSettings>(DEFAULT_PRODUCTIVITY_TOOLS_SETTINGS)

// ===== 初始化 =====

/**
 * 从主进程加载 UI 偏好设置
 */
export async function initializeUiPreferences(
  setLongTextPasteAsAttachmentEnabled?: (enabled: boolean) => void,
  setRichTextRenderingEnabled?: (enabled: boolean) => void,
  setSessionHoverPreviewEnabled?: (enabled: boolean) => void,
  setAgentAutoOpenChangesPanelEnabled?: (enabled: boolean) => void,
  setProductivityTools?: (settings: ProductivityToolsSettings) => void,
): Promise<void> {
  try {
    const settings = await window.electronAPI.getSettings()
    setLongTextPasteAsAttachmentEnabled?.(settings.longTextPasteAsAttachmentEnabled ?? false)
    setRichTextRenderingEnabled?.(settings.richTextRenderingEnabled ?? true)
    setSessionHoverPreviewEnabled?.(settings.sessionHoverPreviewEnabled ?? false)
    setAgentAutoOpenChangesPanelEnabled?.(settings.agentAutoOpenChangesPanel ?? true)
    setProductivityTools?.(settings.productivityTools)
  } catch (error) {
    console.error('[UI偏好] 初始化失败:', error)
  }
}

// ===== 持久化更新 =====

/**
 * 更新长文本粘贴转附件开关并持久化
 */
export async function updateLongTextPasteAsAttachmentEnabled(enabled: boolean): Promise<void> {
  try {
    await window.electronAPI.updateSettings({ longTextPasteAsAttachmentEnabled: enabled })
  } catch (error) {
    console.error('[UI偏好] 更新长文本粘贴附件设置失败:', error)
  }
}

/**
 * 更新输入框 Markdown 渲染开关并持久化
 */
export async function updateRichTextRenderingEnabled(enabled: boolean): Promise<void> {
  try {
    await window.electronAPI.updateSettings({ richTextRenderingEnabled: enabled })
  } catch (error) {
    console.error('[UI偏好] 更新输入框 Markdown 渲染设置失败:', error)
  }
}

/**
 * 更新左侧会话悬浮预览开关并持久化
 */
export async function updateSessionHoverPreviewEnabled(enabled: boolean): Promise<void> {
  try {
    await window.electronAPI.updateSettings({ sessionHoverPreviewEnabled: enabled })
  } catch (error) {
    console.error('[UI偏好] 更新会话悬浮预览设置失败:', error)
  }
}

/**
 * 更新「改动文件时自动打开侧面板」开关并持久化
 */
export async function updateAgentAutoOpenChangesPanelEnabled(enabled: boolean): Promise<void> {
  try {
    await window.electronAPI.updateSettings({ agentAutoOpenChangesPanel: enabled })
  } catch (error) {
    console.error('[UI偏好] 更新改动面板自动打开设置失败:', error)
  }
}

/** 更新 Todo、日程与 Obsidian 的入口可见性设置（我方定制：只控显示，不影响 Agent 能力）。 */
export async function updateProductivityTools(settings: ProductivityToolsSettings): Promise<void> {
  try {
    await window.electronAPI.updateSettings({ productivityTools: settings })
  } catch (error) {
    console.error('[UI偏好] 更新生产力工具设置失败:', error)
    throw error
  }
}
