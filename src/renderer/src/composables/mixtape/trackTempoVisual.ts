import { BPM_MIN_VALUE, BPM_POINT_SEC_EPSILON } from '@renderer/composables/mixtape/trackTempoModel'

const BPM_VISUAL_MIN_Y_PERCENT = 75

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export const mapTrackBpmToYPercent = (
  bpm: number,
  baseBpm: number,
  minBpm: number,
  maxBpm: number
) => {
  const safeBase = Math.max(BPM_MIN_VALUE, Number(baseBpm) || BPM_MIN_VALUE)
  const safeMin = Math.max(BPM_MIN_VALUE, Number(minBpm) || BPM_MIN_VALUE)
  const safeMax = Math.max(safeBase, Number(maxBpm) || safeBase)
  const safeBpm = clampNumber(Number(bpm) || safeBase, safeMin, safeMax)
  if (safeBpm >= safeBase) {
    const ratio = (safeBpm - safeBase) / Math.max(BPM_POINT_SEC_EPSILON, safeMax - safeBase)
    return clampNumber(50 - ratio * 50, 0, 50)
  }
  const ratio = (safeBase - safeBpm) / Math.max(BPM_POINT_SEC_EPSILON, safeBase - safeMin)
  return clampNumber(50 + ratio * (BPM_VISUAL_MIN_Y_PERCENT - 50), 50, BPM_VISUAL_MIN_Y_PERCENT)
}

export const mapTrackBpmYPercentToValue = (
  yPercent: number,
  baseBpm: number,
  minBpm: number,
  maxBpm: number
) => {
  const safeBase = Math.max(BPM_MIN_VALUE, Number(baseBpm) || BPM_MIN_VALUE)
  const safeMin = Math.max(BPM_MIN_VALUE, Number(minBpm) || BPM_MIN_VALUE)
  const safeMax = Math.max(safeBase, Number(maxBpm) || safeBase)
  const safeY = clampNumber(Number(yPercent) || 0, 0, BPM_VISUAL_MIN_Y_PERCENT)
  if (safeY <= 50) {
    const ratio = (50 - safeY) / 50
    return Math.max(BPM_MIN_VALUE, Math.round(safeBase + (safeMax - safeBase) * ratio))
  }
  const ratio = (safeY - 50) / Math.max(BPM_POINT_SEC_EPSILON, BPM_VISUAL_MIN_Y_PERCENT - 50)
  return Math.max(BPM_MIN_VALUE, Math.round(safeBase - (safeBase - safeMin) * ratio))
}
