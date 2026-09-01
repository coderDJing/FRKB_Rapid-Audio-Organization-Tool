import type { HorizontalBrowseDeckKey } from '@shared/horizontalBrowseTransport'
import type { HorizontalBrowseBeatSyncDecks } from './horizontalBrowseBeatSyncDecks'

export const DECK_TEMPO_MIN_PLAYBACK_RATE = 0.25
export const DECK_TEMPO_MAX_PLAYBACK_RATE = 4
/** 低于 BPM 输入步进，避免 0.01 BPM 被倍率误差吃掉 */
export const DECK_TEMPO_BPM_APPLY_EPSILON = 0.0001

type DeckTempoSnapshot = {
  playbackRate: number
  effectiveBpm: number
}

type ResolveDeckTempoControlPlanParams = {
  deck: HorizontalBrowseDeckKey
  targetBpm: number
  activeSyncDecks: HorizontalBrowseBeatSyncDecks | null
  resolveBaseGridBpm: (deck: HorizontalBrowseDeckKey) => number
  resolveSnapshot: (deck: HorizontalBrowseDeckKey) => DeckTempoSnapshot
}

export type HorizontalBrowseDeckTempoControlPlan = {
  playbackDeck: HorizontalBrowseDeckKey
  playbackRate: number
  previewPlaybackRates: Partial<Record<HorizontalBrowseDeckKey, number>>
}

export const clampDeckPlaybackRate = (value: number) =>
  Math.max(DECK_TEMPO_MIN_PLAYBACK_RATE, Math.min(DECK_TEMPO_MAX_PLAYBACK_RATE, value))

export const resolveDeckTargetPlaybackRate = (targetBpm: number, baseGridBpm: number) => {
  if (!Number.isFinite(targetBpm) || targetBpm <= 0) return null
  if (!Number.isFinite(baseGridBpm) || baseGridBpm <= 0) return null
  return clampDeckPlaybackRate(targetBpm / baseGridBpm)
}

const resolveSyncedPreviewPlaybackRate = (targetBpm: number, snapshot: DeckTempoSnapshot) => {
  const currentRate = Number(snapshot.playbackRate)
  const currentEffectiveBpm = Number(snapshot.effectiveBpm)
  if (
    !Number.isFinite(targetBpm) ||
    targetBpm <= 0 ||
    !Number.isFinite(currentRate) ||
    currentRate <= 0 ||
    !Number.isFinite(currentEffectiveBpm) ||
    currentEffectiveBpm <= 0
  ) {
    return null
  }
  return clampDeckPlaybackRate((currentRate * targetBpm) / currentEffectiveBpm)
}

export const resolveDeckTempoControlPlan = ({
  deck,
  targetBpm,
  activeSyncDecks,
  resolveBaseGridBpm,
  resolveSnapshot
}: ResolveDeckTempoControlPlanParams): HorizontalBrowseDeckTempoControlPlan | null => {
  const playbackDeck = activeSyncDecks?.leader ?? deck
  const playbackRate = resolveDeckTargetPlaybackRate(targetBpm, resolveBaseGridBpm(playbackDeck))
  if (playbackRate == null) return null

  const previewPlaybackRates: Partial<Record<HorizontalBrowseDeckKey, number>> = {
    [playbackDeck]: playbackRate
  }
  if (activeSyncDecks) {
    const followerRate = resolveSyncedPreviewPlaybackRate(
      targetBpm,
      resolveSnapshot(activeSyncDecks.follower)
    )
    if (followerRate != null) {
      previewPlaybackRates[activeSyncDecks.follower] = followerRate
    }
  }

  return {
    playbackDeck,
    playbackRate,
    previewPlaybackRates
  }
}

export const shouldApplyDeckTargetBpm = (currentEffectiveBpm: number, targetBpm: number) => {
  if (!Number.isFinite(targetBpm) || targetBpm <= 0) return false
  if (!Number.isFinite(currentEffectiveBpm) || currentEffectiveBpm <= 0) return true
  return Math.abs(currentEffectiveBpm - targetBpm) > DECK_TEMPO_BPM_APPLY_EPSILON
}
