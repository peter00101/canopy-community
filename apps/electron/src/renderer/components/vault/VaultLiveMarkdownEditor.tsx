import * as React from 'react'
import { LiveMarkdownEditor, type LiveMarkdownEditorHandle, type LiveMarkdownTextSelection } from '@/components/markdown/LiveMarkdownEditor'

import { createVaultWikiLinks } from './vault-wikilinks'

const MAX_PASTED_IMAGE_BYTES = 10 * 1024 * 1024

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

interface VaultLiveMarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  onSave: () => void
  /** 选区变化由 Vault 外层处理为引用/右侧问答浮窗。 */
  onTextSelectionChange?: (selection: LiveMarkdownTextSelection | null) => void
  relativePath: string
  /** 正文 `[[笔记]]` 双链被单击：目标原文交给 VaultView 解析成 Vault 内路径后打开。 */
  onOpenWikiLink: (target: string) => void
}

/** Vault's file adapter around the reusable, domain-neutral Markdown editor. */
export const VaultLiveMarkdownEditor = React.forwardRef<LiveMarkdownEditorHandle, VaultLiveMarkdownEditorProps>(function VaultLiveMarkdownEditor({ relativePath, onOpenWikiLink, ...props }, ref): React.ReactElement {
  // 回调走 ref、扩展只建一次：LiveMarkdownEditor 只在挂载时读取 extensions，父层重渲染不重建。
  const onOpenWikiLinkRef = React.useRef(onOpenWikiLink)
  onOpenWikiLinkRef.current = onOpenWikiLink
  const extensions = React.useMemo(() => [createVaultWikiLinks((target) => onOpenWikiLinkRef.current(target))], [])
  const mediaRequestsRef = React.useRef(new Map<string, Promise<string | null>>())
  const resolveImageSrc = React.useCallback((src: string): Promise<string | null> => {
    const cached = mediaRequestsRef.current.get(src)
    if (cached) return cached
    const request = window.electronAPI.resolveVaultMedia(relativePath, src).then((result) => result?.url ?? null)
    mediaRequestsRef.current.set(src, request)
    return request
  }, [relativePath])

  const savePastedImage = React.useCallback(async (file: File): Promise<string | null> => {
    // Reject before allocating raw bytes, a binary string, Base64, and IPC copies.
    if (file.size <= 0 || file.size > MAX_PASTED_IMAGE_BYTES) return null
    return (await window.electronAPI.saveVaultPastedImage({
      noteRelativePath: relativePath,
      mimeType: file.type,
      base64: await fileToBase64(file),
    }))?.src ?? null
  }, [relativePath])

  return <LiveMarkdownEditor {...props} ref={ref} extensions={extensions} resolveImageSrc={resolveImageSrc} savePastedImage={savePastedImage} />
})
