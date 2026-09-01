const RATE_EPSILON = 0.0001

export const rebaseHorizontalBrowsePlaybackClock = (
  baseSec: number,
  baseAtMs: number,
  previousRate: number,
  nextRate: number,
  nowMs: number
) => {
  const safePrevious = Math.max(0.25, Number(previousRate) || 1)
  const safeNext = Math.max(0.25, Number(nextRate) || 1)
  if (Math.abs(safePrevious - safeNext) <= RATE_EPSILON) {
    return { baseSec, baseAtMs, playbackRate: safeNext }
  }
  const elapsedSec = Math.max(0, nowMs - Math.max(0, baseAtMs)) / 1000
  return {
    baseSec: Number(baseSec) + elapsedSec * safePrevious,
    baseAtMs: nowMs,
    playbackRate: safeNext
  }
}
