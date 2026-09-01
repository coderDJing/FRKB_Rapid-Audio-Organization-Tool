export const DECK_TEMPO_MIN_PLAYBACK_RATE = 0.25
export const DECK_TEMPO_MAX_PLAYBACK_RATE = 4
/** 低于 BPM 输入步进，避免 0.01 BPM 被倍率误差吃掉 */
export const DECK_TEMPO_BPM_APPLY_EPSILON = 0.0001

export const clampDeckPlaybackRate = (value: number) =>
  Math.max(DECK_TEMPO_MIN_PLAYBACK_RATE, Math.min(DECK_TEMPO_MAX_PLAYBACK_RATE, value))

export const resolveDeckTargetPlaybackRate = (targetBpm: number, baseGridBpm: number) => {
  if (!Number.isFinite(targetBpm) || targetBpm <= 0) return null
  if (!Number.isFinite(baseGridBpm) || baseGridBpm <= 0) return null
  return clampDeckPlaybackRate(targetBpm / baseGridBpm)
}

export const shouldApplyDeckTargetBpm = (currentEffectiveBpm: number, targetBpm: number) => {
  if (!Number.isFinite(targetBpm) || targetBpm <= 0) return false
  if (!Number.isFinite(currentEffectiveBpm) || currentEffectiveBpm <= 0) return true
  return Math.abs(currentEffectiveBpm - targetBpm) > DECK_TEMPO_BPM_APPLY_EPSILON
}
