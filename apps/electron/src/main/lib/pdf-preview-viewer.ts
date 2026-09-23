/**
 * PDF 内联预览查看器（跑在隔离的 canopy-file:// iframe 里，不与应用主页面同源）。
 *
 * 旧实现打开时把所有页一次性画成 canvas、每次缩放全部重画（276 页纯文字 PDF：3.1s 画完、
 * 每档缩放 2.0~2.3s 内容整片清空再重建），且只有图没有文字层，搜不了也选不了字。
 *
 * 本实现：
 * - 占位 + 视口懒渲染：只画视口附近的页，远离视口的页释放 canvas 与文字层，内存随「可见页」而不是「总页数」增长；
 * - 缩放时旧图先按 CSS 拉伸顶着（不闪白），只重画可见页，并以当前页为锚点保持阅读位置；
 * - pdf.js 文字层：可以选字复制；
 * - 查找：父页面经 postMessage 发起，iframe 内按页抽文字建索引匹配，CSS Custom Highlight API 高亮（不改 DOM）。
 *
 * 纯逻辑函数单独导出以便测试；注入 iframe 时用 Function#toString 拼进脚本，
 * 因此这些函数与 pdfPreviewViewerMain 必须自包含：不引用任何 import、不用 class。
 */

export interface PdfPreviewFindOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

export interface PdfTextItemLike {
  str?: string
  hasEOL?: boolean
}

/** 一页的查找索引：各文字条目按顺序拼成的全文，以及每个条目在全文里的起点与长度 */
export interface PdfPageTextIndex {
  text: string
  starts: number[]
  lengths: number[]
}

export interface PdfMatchLocation {
  startItem: number
  startOffset: number
  endItem: number
  endOffset: number
}

export interface PdfViewerConfig {
  fileUrl: string
  pdfScriptUrl: string
  pdfWorkerUrl: string
  standardFontDataUrl: string
  cMapUrl: string
}

/** 与渲染层 preview-find-matcher.ts 同语义（有测试钉住一致） */
export function buildPdfFindMatcher(query: string, options: PdfPreviewFindOptions): RegExp | null {
  if (!query) return null
  try {
    const escaped = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const source = options.wholeWord ? `\\b(?:${escaped})\\b` : escaped
    return new RegExp(source, `g${options.caseSensitive ? '' : 'i'}`)
  } catch {
    return null
  }
}

export function findPdfMatches(text: string, matcher: RegExp, limit: number): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = []
  matcher.lastIndex = 0
  let match = matcher.exec(text)
  while (match && matches.length < limit) {
    if (match[0].length === 0) {
      matcher.lastIndex += 1
    } else {
      matches.push({ start: match.index, end: match.index + match[0].length })
    }
    match = matcher.exec(text)
  }
  return matches
}

/**
 * 条目顺序与 pdf.js TextLayer 的 textDivs 一一对应：只有带 str 的条目会生成节点
 * （markedContent 这类没有 str 的条目不占位）。行尾补一个空格而不是换行，
 * 让被折到两行的词组（「预览\n补全」）也能搜到，且不改变各条目内的字符偏移。
 */
export function buildPdfPageTextIndex(items: readonly PdfTextItemLike[]): PdfPageTextIndex {
  let text = ''
  const starts: number[] = []
  const lengths: number[] = []
  for (const item of items) {
    if (typeof item.str !== 'string') continue
    starts.push(text.length)
    lengths.push(item.str.length)
    text += item.str
    if (item.hasEOL) text += ' '
  }
  return { text, starts, lengths }
}

/** 把全文里的 [start, end) 映射回「第几个条目的第几个字符」；落在补的行尾空格上时收到条目末尾 */
export function locatePdfMatch(index: PdfPageTextIndex, start: number, end: number): PdfMatchLocation | null {
  const { starts, lengths } = index
  if (starts.length === 0 || end <= start) return null
  const itemAt = (position: number): number => {
    let low = 0
    let high = starts.length - 1
    let found = 0
    while (low <= high) {
      const middle = (low + high) >> 1
      if (starts[middle]! <= position) {
        found = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    return found
  }
  const startItem = itemAt(start)
  const endItem = itemAt(end - 1)
  return {
    startItem,
    startOffset: Math.min(Math.max(start - starts[startItem]!, 0), lengths[startItem]!),
    endItem,
    endOffset: Math.min(Math.max(end - starts[endItem]!, 0), lengths[endItem]!),
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function pdfPreviewViewerMain(pdfjsLib: any, config: PdfViewerConfig): void {
  const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3]
  const RENDER_CONCURRENCY = 2
  const MAX_MATCHES = 5000
  const container = document.getElementById('c') as HTMLElement
  const scroller = (document.scrollingElement ?? document.documentElement) as HTMLElement
  let zoomIndex = 2
  let pdfDoc: any = null
  let markDocReady: () => void = () => {}
  /** 查找请求可能在文档加载完之前就到（父页面一打开就搜），先等文档与页面占位就绪 */
  const docReady = new Promise<void>((resolve) => { markDocReady = resolve })

  interface PageSlot {
    number: number
    width: number
    height: number
    el: HTMLDivElement
    canvas: HTMLCanvasElement | null
    textEl: HTMLDivElement | null
    textLayer: any
    renderTask: any
    renderedScale: number
    /** 正在按哪个比例渲染（0 = 没在渲染）；滚动时同一页反复进出视口不重复起渲染 */
    renderingScale: number
    token: number
    waiters: Array<() => void>
  }
  const pages: PageSlot[] = []
  const textIndexes: Array<PdfPageTextIndex | null> = []
  const visible = new Set<number>()
  const queue = new Set<number>()
  let activeRenders = 0

  let findSeq = 0
  let activateSeq = 0
  let matches: Array<{ page: number; start: number; end: number }> = []
  let matchesByPage = new Map<number, number[]>()
  let activeMatch = -1

  const scale = (): number => ZOOM_STEPS[zoomIndex]!

  function postToParent(message: Record<string, unknown>): void {
    window.parent.postMessage(message, '*')
  }

  function notifyZoom(): void {
    postToParent({ type: 'pdf-zoom-changed', zoom: Math.round(scale() * 100) })
  }

  function sizePage(page: PageSlot): void {
    page.el.style.width = `${Math.floor(page.width * scale())}px`
    page.el.style.height = `${Math.floor(page.height * scale())}px`
    page.el.style.setProperty('--scale-factor', String(scale()))
  }

  function releaseCanvas(canvas: HTMLCanvasElement | null): void {
    if (!canvas) return
    canvas.width = 0
    canvas.height = 0
    canvas.remove()
  }

  function cancelWork(page: PageSlot): void {
    page.token += 1
    page.renderingScale = 0
    try { page.renderTask?.cancel() } catch { /* 已结束 */ }
    try { page.textLayer?.cancel() } catch { /* 已结束 */ }
    page.renderTask = null
  }

  function releasePage(page: PageSlot): void {
    cancelWork(page)
    releaseCanvas(page.canvas)
    page.canvas = null
    page.textEl?.remove()
    page.textEl = null
    page.textLayer = null
    page.renderedScale = 0
    queue.delete(page.number)
  }

  function requestRender(number: number): void {
    const page = pages[number - 1]
    if (!page) return
    if (page.renderingScale === scale()) return
    if (page.renderedScale === scale() && page.textEl) return
    queue.add(number)
  }

  function pump(): void {
    while (activeRenders < RENDER_CONCURRENCY && queue.size > 0) {
      const center = scroller.scrollTop + scroller.clientHeight / 2
      let best = -1
      let bestDistance = Number.POSITIVE_INFINITY
      for (const number of queue) {
        if (!visible.has(number)) {
          queue.delete(number)
          continue
        }
        const el = pages[number - 1]!.el
        const distance = Math.abs(el.offsetTop + el.offsetHeight / 2 - center)
        if (distance < bestDistance) {
          bestDistance = distance
          best = number
        }
      }
      if (best < 0) return
      queue.delete(best)
      void renderPage(pages[best - 1]!)
    }
  }

  async function renderPage(page: PageSlot): Promise<void> {
    const token = page.token + 1
    page.token = token
    const renderScale = scale()
    page.renderingScale = renderScale
    activeRenders += 1
    try {
      const pdfPage = await pdfDoc.getPage(page.number)
      if (token !== page.token) return
      const viewport = pdfPage.getViewport({ scale: renderScale })
      const baseWidth = viewport.width / renderScale
      const baseHeight = viewport.height / renderScale
      if (Math.abs(baseWidth - page.width) > 0.5 || Math.abs(baseHeight - page.height) > 0.5) resizeBase(page, baseWidth, baseHeight)

      const dpr = window.devicePixelRatio || 1
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      const task = pdfPage.render({
        canvasContext: canvas.getContext('2d', { alpha: false }),
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      })
      page.renderTask = task
      await task.promise
      if (token !== page.token) {
        releaseCanvas(canvas)
        return
      }
      releaseCanvas(page.canvas)
      page.el.prepend(canvas)
      page.canvas = canvas
      page.renderedScale = renderScale

      const textContent = await pdfPage.getTextContent()
      if (token !== page.token) return
      if (!textIndexes[page.number - 1]) textIndexes[page.number - 1] = buildPdfPageTextIndex(textContent.items)
      const textEl = document.createElement('div')
      textEl.className = 'textLayer'
      const textLayer = new pdfjsLib.TextLayer({ textContentSource: textContent, container: textEl, viewport })
      page.textLayer = textLayer
      await textLayer.render()
      if (token !== page.token) return
      page.textEl?.remove()
      page.el.append(textEl)
      page.textEl = textEl
      const waiters = page.waiters.splice(0)
      for (const resolve of waiters) resolve()
      refreshHighlights()
    } catch (error: any) {
      if (error?.name !== 'RenderingCancelledException' && error?.name !== 'AbortException') {
        console.warn('[pdf-preview] 第 ' + page.number + ' 页渲染失败:', error)
      }
    } finally {
      if (token === page.token) page.renderingScale = 0
      activeRenders -= 1
      pump()
    }
  }

  /** 页面真实尺寸与占位不同（横版页、混排尺寸）时校正；该页在视口上方则同步滚动，阅读位置不跳 */
  function resizeBase(page: PageSlot, width: number, height: number): void {
    const wasAbove = page.el.offsetTop + page.el.offsetHeight <= scroller.scrollTop
    const before = page.el.offsetHeight
    page.width = width
    page.height = height
    sizePage(page)
    if (wasAbove) scroller.scrollTop += page.el.offsetHeight - before
  }

  function anchorPosition(): { page: PageSlot; ratio: number } | null {
    const top = scroller.scrollTop
    for (const page of pages) {
      if (page.el.offsetTop + page.el.offsetHeight > top) {
        return { page, ratio: (top - page.el.offsetTop) / Math.max(page.el.offsetHeight, 1) }
      }
    }
    return null
  }

  function setZoom(nextIndex: number): void {
    if (nextIndex < 0 || nextIndex >= ZOOM_STEPS.length || nextIndex === zoomIndex) return
    const anchor = anchorPosition()
    zoomIndex = nextIndex
    queue.clear()
    for (const page of pages) {
      cancelWork(page)
      // 旧图留着按 CSS 拉伸顶住，直到新比例画好；文字层按旧比例排的版，直接撤掉等重建
      page.textEl?.remove()
      page.textEl = null
      page.textLayer = null
      page.renderedScale = page.canvas ? -1 : 0
      sizePage(page)
    }
    if (anchor) scroller.scrollTop = anchor.page.el.offsetTop + anchor.ratio * anchor.page.el.offsetHeight
    for (const number of visible) requestRender(number)
    pump()
    notifyZoom()
    refreshHighlights()
  }

  async function refineSizes(): Promise<void> {
    for (let number = 2; number <= pages.length; number += 1) {
      const page = pages[number - 1]!
      try {
        const pdfPage = await pdfDoc.getPage(number)
        const viewport = pdfPage.getViewport({ scale: 1 })
        if (Math.abs(viewport.width - page.width) > 0.5 || Math.abs(viewport.height - page.height) > 0.5) {
          resizeBase(page, viewport.width, viewport.height)
        }
      } catch { /* 个别坏页不影响其余页 */ }
      if (number % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  // ---------- 查找 ----------

  function textNodeOf(div: Element | undefined): Text | null {
    const node = div?.firstChild
    return node && node.nodeType === Node.TEXT_NODE ? node as Text : null
  }

  function rangeFor(matchIndex: number): Range | null {
    const match = matches[matchIndex]
    if (!match) return null
    const page = pages[match.page - 1]
    const index = textIndexes[match.page - 1]
    const divs: HTMLElement[] | undefined = page?.textLayer?.textDivs
    if (!page?.textEl || !index || !divs || divs.length !== index.starts.length) return null
    const location = locatePdfMatch(index, match.start, match.end)
    if (!location) return null
    const startNode = textNodeOf(divs[location.startItem])
    const endNode = textNodeOf(divs[location.endItem])
    if (!startNode || !endNode) return null
    const range = document.createRange()
    range.setStart(startNode, Math.min(location.startOffset, startNode.length))
    range.setEnd(endNode, Math.min(location.endOffset, endNode.length))
    return range
  }

  function refreshHighlights(): void {
    const registry = (CSS as any).highlights
    const HighlightCtor = (window as any).Highlight
    if (!registry || !HighlightCtor) return
    const normal: Range[] = []
    let active: Range | null = null
    for (const [pageNumber, indexes] of matchesByPage) {
      const page = pages[pageNumber - 1]
      if (!page?.textEl) continue
      for (const matchIndex of indexes) {
        const range = rangeFor(matchIndex)
        if (!range) continue
        if (matchIndex === activeMatch) active = range
        else normal.push(range)
      }
    }
    registry.set('canopy-find', new HighlightCtor(...normal))
    if (active) registry.set('canopy-find-active', new HighlightCtor(active))
    else registry.delete('canopy-find-active')
  }

  async function ensureTextIndexes(seq: number): Promise<boolean> {
    for (let number = 1; number <= pages.length; number += 1) {
      if (seq !== findSeq) return false
      if (textIndexes[number - 1]) continue
      try {
        const pdfPage = await pdfDoc.getPage(number)
        const textContent = await pdfPage.getTextContent()
        textIndexes[number - 1] = buildPdfPageTextIndex(textContent.items)
      } catch {
        textIndexes[number - 1] = { text: '', starts: [], lengths: [] }
      }
      if (number % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
    }
    return seq === findSeq
  }

  function clearFind(): void {
    findSeq += 1
    activateSeq += 1
    matches = []
    matchesByPage = new Map()
    activeMatch = -1
    refreshHighlights()
  }

  async function find(requestId: number, query: string, options: PdfPreviewFindOptions): Promise<void> {
    findSeq += 1
    const seq = findSeq
    await docReady
    if (seq !== findSeq) return
    const matcher = buildPdfFindMatcher(query, options)
    if (!matcher || !pdfDoc) {
      postToParent({ type: 'pdf-find-result', requestId, count: 0, capped: false })
      return
    }
    if (!await ensureTextIndexes(seq)) return
    const found: Array<{ page: number; start: number; end: number }> = []
    const byPage = new Map<number, number[]>()
    for (let number = 1; number <= pages.length && found.length < MAX_MATCHES; number += 1) {
      const index = textIndexes[number - 1]
      if (!index?.text) continue
      for (const hit of findPdfMatches(index.text, matcher, MAX_MATCHES - found.length)) {
        const list = byPage.get(number) ?? []
        list.push(found.length)
        byPage.set(number, list)
        found.push({ page: number, start: hit.start, end: hit.end })
      }
    }
    matches = found
    matchesByPage = byPage
    activeMatch = -1
    refreshHighlights()
    postToParent({ type: 'pdf-find-result', requestId, count: found.length, capped: found.length >= MAX_MATCHES })
  }

  function waitForPage(page: PageSlot, timeoutMs: number): Promise<void> {
    if (page.textEl && page.renderedScale === scale()) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      page.waiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  async function activate(index: number): Promise<void> {
    activateSeq += 1
    const seq = activateSeq
    const match = matches[index]
    if (!match) return
    activeMatch = index
    const page = pages[match.page - 1]!
    if (!page.textEl || page.renderedScale !== scale()) {
      scroller.scrollTop = page.el.offsetTop - scroller.clientHeight / 3
      requestRender(page.number)
      pump()
      await waitForPage(page, 5000)
      if (seq !== activateSeq) return
    }
    refreshHighlights()
    const range = rangeFor(index)
    if (!range) return
    const rect = range.getBoundingClientRect()
    // 贴着上下边缘（各 20% 以内）也滚到中间：刚跳过去的命中要一眼看得到
    const margin = scroller.clientHeight * 0.2
    if (rect.top < margin || rect.bottom > scroller.clientHeight - margin) {
      scroller.scrollTop += rect.top - scroller.clientHeight / 2 + rect.height / 2
    }
    if (rect.left < 0 || rect.right > scroller.clientWidth) {
      scroller.scrollLeft += rect.left - scroller.clientWidth / 2 + rect.width / 2
    }
  }

  // ---------- 通信 ----------

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return
    const data = event.data ?? {}
    if (data.type === 'pdf-zoom') {
      if (data.direction === 'in') setZoom(zoomIndex + 1)
      if (data.direction === 'out') setZoom(zoomIndex - 1)
    } else if (data.type === 'pdf-find') {
      void find(Number(data.requestId), String(data.query ?? ''), data.options ?? { caseSensitive: false, wholeWord: false, regex: false })
    } else if (data.type === 'pdf-find-activate') {
      void activate(Number(data.index))
    } else if (data.type === 'pdf-find-clear') {
      clearFind()
    }
  })

  // 焦点在 PDF 里时 Ctrl/Cmd+F 到不了父页面的快捷键，转交父页面打开查找栏
  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      postToParent({ type: 'pdf-find-open' })
    }
  })

  // 监听已挂好：通知父页面可以发消息了（在此之前父页面把查找 / 缩放消息排队）
  postToParent({ type: 'pdf-viewer-ready' })

  // ---------- 加载 ----------

  async function start(): Promise<void> {
    pdfjsLib.GlobalWorkerOptions.workerSrc = config.pdfWorkerUrl
    pdfDoc = await pdfjsLib.getDocument({
      url: config.fileUrl,
      standardFontDataUrl: config.standardFontDataUrl,
      cMapUrl: config.cMapUrl,
      cMapPacked: true,
      isEvalSupported: false,
    }).promise
    const first = await pdfDoc.getPage(1)
    const firstViewport = first.getViewport({ scale: 1 })
    container.textContent = ''
    container.className = 'pages'
    const nearObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const number = Number((entry.target as HTMLElement).dataset.page)
        if (entry.isIntersecting) {
          visible.add(number)
          requestRender(number)
        } else {
          visible.delete(number)
        }
      }
      pump()
    }, { rootMargin: '120% 0px' })
    const farObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) continue
        const page = pages[Number((entry.target as HTMLElement).dataset.page) - 1]
        if (page && (page.canvas || page.textEl)) releasePage(page)
      }
    }, { rootMargin: '360% 0px' })
    const fragment = document.createDocumentFragment()
    for (let number = 1; number <= pdfDoc.numPages; number += 1) {
      const el = document.createElement('div')
      el.className = 'page'
      el.dataset.page = String(number)
      const page: PageSlot = {
        number,
        width: firstViewport.width,
        height: firstViewport.height,
        el,
        canvas: null,
        textEl: null,
        textLayer: null,
        renderTask: null,
        renderedScale: 0,
        renderingScale: 0,
        token: 0,
        waiters: [],
      }
      sizePage(page)
      pages.push(page)
      textIndexes.push(null)
      fragment.append(el)
    }
    const info = document.createElement('div')
    info.className = 'page-info'
    info.textContent = '共 ' + pdfDoc.numPages + ' 页'
    fragment.append(info)
    container.append(fragment)
    for (const page of pages) {
      nearObserver.observe(page.el)
      farObserver.observe(page.el)
    }
    notifyZoom()
    markDocReady()
    void refineSizes()
  }

  start().catch((error: any) => {
    // 加载失败时让排队中的查找也有结果（0 个），父页面不会一直停在「搜索中」
    markDocReady()
    container.className = 'error'
    container.textContent = 'PDF 加载失败: ' + (error?.message ?? String(error))
  })
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * 文字层样式摘自 pdfjs-dist 4.10 web/pdf_viewer.css（Apache-2.0），只保留文字层用到的规则；
 * 查找高亮用 CSS Custom Highlight API，颜色与应用内 PreviewFindBar 的 DOM 高亮一致。
 */
const PDF_VIEWER_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  body { background: transparent; overflow: auto; }
  #c.loading, #c.error { font: 12px/1.5 system-ui; padding: 40px; text-align: center; width: 100%; }
  #c.loading { color: #888; }
  #c.error { color: #f87171; }
  .pages { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 16px; width: max-content; min-width: 100%; }
  .page { position: relative; flex: none; background: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15); }
  .page canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .page-info { color: #888; font: 11px/1.5 system-ui; text-align: center; padding: 4px; width: 100%; }
  .textLayer { position: absolute; text-align: initial; inset: 0; overflow: clip; opacity: 1; line-height: 1; text-size-adjust: none; forced-color-adjust: none; transform-origin: 0 0; caret-color: CanvasText; z-index: 0; }
  .textLayer :is(span, br) { color: transparent; position: absolute; white-space: pre; cursor: text; transform-origin: 0% 0%; }
  .textLayer > :not(.markedContent), .textLayer .markedContent span:not(.markedContent) { z-index: 1; }
  .textLayer span.markedContent { top: 0; height: 0; }
  .textLayer ::selection { background: rgba(0, 0, 255, 0.25); }
  .textLayer br::selection { background: transparent; }
  ::highlight(canopy-find) { background-color: rgba(250, 204, 21, 0.48); }
  ::highlight(canopy-find-active) { background-color: rgba(249, 115, 22, 0.72); }
`

/** 注入脚本里不能出现 `</script`，否则 HTML 解析会在字符串中间截断脚本 */
function escapeInlineScript(source: string): string {
  return source.replace(/<\/(script)/gi, '<\\/$1')
}

export function buildPdfPreviewHtml(config: PdfViewerConfig): string {
  const helpers = [buildPdfFindMatcher, findPdfMatches, buildPdfPageTextIndex, locatePdfMatch]
    .map((fn) => fn.toString())
    .join('\n')
  const script = `
    ${helpers}
    const viewerMain = ${pdfPreviewViewerMain.toString()};
    const config = ${JSON.stringify(config)};
    try {
      const pdfjsLib = await import(config.pdfScriptUrl);
      viewerMain(pdfjsLib, config);
    } catch (error) {
      const container = document.getElementById('c');
      container.className = 'error';
      container.textContent = 'PDF 加载失败: ' + (error && error.message ? error.message : String(error));
    }
  `
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>${PDF_VIEWER_CSS}</style>
</head><body>
  <div class="loading" id="c">正在加载 PDF...</div>
  <script type="module">${escapeInlineScript(script)}</script>
</body></html>`
}
