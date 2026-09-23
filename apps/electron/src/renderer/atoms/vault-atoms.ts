import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { VaultReadResult } from '@canopy/shared'

/**
 * Vault 文件树侧栏是否展开（独立视图与右侧面板嵌入态共用）。
 * 收起后笔记独占视图；用户选择跨启动记忆（用户反馈：树侧栏常驻会把视觉重心拽到侧栏上）。
 */
export const vaultSidebarOpenAtom = atomWithStorage<boolean>(
  'canopy-vault-sidebar-open',
  true,
  undefined,
  { getOnInit: true },
)

export const selectedVaultFileAtom = atom<string | null>(null)
/** Transient navigation target for an Obsidian context chip; not Agent state. */
export const focusedVaultFolderAtom = atom<string | null>(null)
export const vaultReadResultAtom = atom<VaultReadResult | null>(null)
export const vaultRefreshTokenAtom = atom(0)
