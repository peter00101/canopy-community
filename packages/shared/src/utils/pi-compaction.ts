/** Pi 自动压缩开始时的默认上下文占用比例。 */
export const PI_AUTO_COMPACTION_THRESHOLD_RATIO = 0.8

/** 用户可设定的最小自动压缩占用比例。再低压缩过于频繁，而每次压缩本身也要花 token。 */
export const PI_AUTO_COMPACTION_MIN_RATIO = 0.5

/**
 * 用户可设定的最大自动压缩占用比例。
 *
 * 不允许设到 1.0：压缩触发后模型还需要空间写摘要并接着跑完当前轮，
 * 预留不足会直接撞上游「上下文超长」，而不是走压缩。
 */
export const PI_AUTO_COMPACTION_MAX_RATIO = 0.95

/** 把用户输入的占用比例夹到允许区间；缺省或非法值回落到默认值。 */
export function normalizePiAutoCompactionRatio(ratio: number | undefined): number {
  if (ratio == null || !Number.isFinite(ratio)) return PI_AUTO_COMPACTION_THRESHOLD_RATIO
  if (ratio < PI_AUTO_COMPACTION_MIN_RATIO) return PI_AUTO_COMPACTION_MIN_RATIO
  if (ratio > PI_AUTO_COMPACTION_MAX_RATIO) return PI_AUTO_COMPACTION_MAX_RATIO
  return ratio
}

/**
 * 将目标上下文占用比例换算为 Pi SDK 的 reserveTokens 配置。
 *
 * Pi 在 `contextTokens > contextWindow - reserveTokens` 时自动压缩，
 * 因此预留 (1 - ratio) 的窗口即可在约 ratio 占用时开始压缩。
 *
 * @param contextWindow 模型上下文窗口 token 数
 * @param ratio 目标占用比例，省略时取默认 80%；超出允许区间会被夹住
 */
export function calculatePiAutoCompactionReserveTokens(
  contextWindow: number,
  ratio?: number,
): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new TypeError('Pi context window must be a positive finite number')
  }

  return Math.ceil(contextWindow * (1 - normalizePiAutoCompactionRatio(ratio)))
}

/** 返回 Pi SDK 会开始自动压缩的上下文 token 阈值。 */
export function calculatePiAutoCompactionThresholdTokens(
  contextWindow: number,
  ratio?: number,
): number {
  return contextWindow - calculatePiAutoCompactionReserveTokens(contextWindow, ratio)
}
