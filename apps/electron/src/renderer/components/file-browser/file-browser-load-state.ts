/**
 * FileBrowser 异步根目录加载的纯状态判断。
 *
 * 请求无法由 IPC 取消，因此渲染层以单调递增的代次拒绝过期结果；
 * 空态只在当前根目录至少成功加载一次后展示，后台刷新期间保持已确认的空态。
 *
 * watcher 在 Agent 运行时会以 300ms～2s 的节奏连续触发后台刷新，这里的规则保证：
 * - 刷新进行中继续展示上一次成功的列表，不清空、不插入占位；
 * - 结果与当前列表一致时复用原数组引用，React 直接跳过重渲染；
 * - 同一组根目录已成功加载过时，偶发失败保留旧列表，不把整棵树换成一行错误再重建。
 */

export interface FileBrowserEmptyStateInput {
  /** 当前 FileBrowser 实际消费的根目录稳定签名。 */
  currentRootsKey: string
  /** 最近一次成功完成目录读取的根目录签名。 */
  loadedRootsKey: string | null
  entryCount: number
  hasError: boolean
  hideEmpty: boolean | undefined
}

/** 只有仍属于最新加载代次的异步结果才能写回文件树状态。 */
export function isCurrentFileBrowserLoadRequest(requestId: number, latestRequestId: number): boolean {
  return requestId === latestRequestId
}

/**
 * 判断是否展示“目录为空”。
 *
 * 不以 loading 为条件：已确认为空的目录在 watcher 触发后台刷新时应保持稳定，
 * 避免“目录为空”文案和下方上传区反复出现、消失而造成面板闪烁。
 */
export function shouldShowFileBrowserEmptyState({
  currentRootsKey,
  loadedRootsKey,
  entryCount,
  hasError,
  hideEmpty,
}: FileBrowserEmptyStateInput): boolean {
  return !hasError
    && !hideEmpty
    && entryCount === 0
    && loadedRootsKey === currentRootsKey
}

/**
 * 当前应渲染的根级条目。
 *
 * 只看「条目属于哪组根目录」，不看是否正在加载：后台刷新开始时 loadedRootsKey 不变，
 * 旧列表原样保留到新结果返回；只有根目录真正切换时才不展示上一组根的内容。
 */
export function getFileBrowserVisibleEntries<T>(
  entries: T[],
  loadedRootsKey: string | null,
  currentRootsKey: string,
): T[] {
  return loadedRootsKey === currentRootsKey ? entries : []
}

/**
 * 行组件收到的刷新版本号。
 *
 * 只有目录行需要随 watcher 重新列出子项；文件行恒为 0，这样一次后台刷新不会让
 * 成千上万个文件行的 memo 因版本号变化而全部失效（实测 2000 行展开时每次刷新冻结约 420ms）。
 */
export function getFileTreeRowRefreshVersion(entry: { isDirectory: boolean }, refreshVersion: number): number {
  return entry.isDirectory ? refreshVersion : 0
}

/** 文件树比较所需的最小字段；scope / rootPath 只在主文件树的合并根场景存在。 */
export interface FileBrowserComparableEntry {
  name: string
  path: string
  isDirectory: boolean
  size?: number
  scope?: string
  rootPath?: string
}

function isSameFileBrowserEntry(a: FileBrowserComparableEntry, b: FileBrowserComparableEntry): boolean {
  return a.path === b.path
    && a.name === b.name
    && a.isDirectory === b.isDirectory
    && a.size === b.size
    && a.scope === b.scope
    && a.rootPath === b.rootPath
}

/**
 * 把一次刷新得到的目录列表与当前列表合并（结构共享）。
 *
 * - 逐项一致（顺序、名称、类型、大小、来源都没变）→ 返回 previous 本身，setState 不触发重渲染；
 * - 有变化 → 返回新数组，但未变化的条目复用旧对象，行组件只为真正变化的条目重渲染。
 */
export function reconcileFileBrowserEntries<T extends FileBrowserComparableEntry>(previous: T[], next: T[]): T[] {
  const previousByPath = new Map<string, T>()
  for (const entry of previous) previousByPath.set(entry.path, entry)

  let changed = previous.length !== next.length
  const reconciled = next.map((entry, index) => {
    const prior = previousByPath.get(entry.path)
    const kept = prior && isSameFileBrowserEntry(prior, entry) ? prior : entry
    if (kept !== previous[index]) changed = true
    return kept
  })
  return changed ? reconciled : previous
}

/** 已成功列出过的目录再次刷新失败时的提示：列表保留，但不静默。 */
export const REFRESH_FAILED_KEEP_PREVIOUS_MESSAGE = '刷新失败，下面显示的是上次读取的内容'

export interface FileListingRefreshFailureInput {
  /** 失败请求对应的目录签名（根目录签名或附加目录 identity）。 */
  requestKey: string
  /** 最近一次成功列出的目录签名；从未成功过为 null。 */
  loadedKey: string | null
}

/**
 * 刷新失败时是否保留上一次成功的列表。
 *
 * 同一目录已经成功列出过（含已确认为空）→ 保留旧列表、不插入错误行，避免 watcher
 * 连续刷新时整棵树「清空成一行错误 → 恢复 → 子目录再逐个补载」上下跳动；
 * 首次加载或目录已切换 → 如实展示错误，不能拿别的目录的内容冒充。
 */
export function shouldKeepPreviousListingOnRefreshFailure({ requestKey, loadedKey }: FileListingRefreshFailureInput): boolean {
  return loadedKey !== null && loadedKey === requestKey
}
