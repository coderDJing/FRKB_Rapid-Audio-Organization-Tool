import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'

export type HorizontalBrowseLinkedGridVisualTransactionMode = 'linked' | 'beatsync'

export type HorizontalBrowseLinkedGridVisualTransactionCommitOptions = {
  mutate?: boolean
}

export type HorizontalBrowseLinkedGridVisualTransactionGridTimeBasis = {
  bpm: number
  firstBeatMs: number
  downbeatBeatOffset: number
  timeBasisOffsetMs: number
}

export type HorizontalBrowseLinkedGridVisualTransactionPlaybackClock = {
  seconds: number
  startedAtMs: number
  playbackRate: number
}

export type HorizontalBrowseLinkedGridVisualTransactionDeckState = {
  currentSeconds?: number
  playbackRate?: number
  playbackActive?: boolean
  startedAtMs?: number
}

export type HorizontalBrowseLinkedGridVisualTransactionResult = {
  deck: HorizontalBrowseDeckKey
  committed: boolean
  anchorSec: number
  viewportStartSec: number
  visibleDurationSec: number
  anchorRatio: number
  timeScale: number
  gridTimeBasis: HorizontalBrowseLinkedGridVisualTransactionGridTimeBasis
  playbackClock: HorizontalBrowseLinkedGridVisualTransactionPlaybackClock | null
}

export type HorizontalBrowseLinkedGridVisualTransactionResults = Partial<
  Record<HorizontalBrowseDeckKey, HorizontalBrowseLinkedGridVisualTransactionResult | null>
>

const normalizePlaybackClockToStartedAt = (
  result: HorizontalBrowseLinkedGridVisualTransactionResult,
  startedAtMs: number
): HorizontalBrowseLinkedGridVisualTransactionResult => {
  const clock = result.playbackClock
  if (!clock) return result
  const sourceStartedAtMs = Number(clock.startedAtMs)
  const sourceSeconds = Number(clock.seconds)
  const playbackRate = Math.max(0.25, Number(clock.playbackRate) || 1)
  if (!Number.isFinite(sourceStartedAtMs) || !Number.isFinite(sourceSeconds)) return result
  const elapsedSec = Math.max(0, startedAtMs - sourceStartedAtMs) / 1000
  return {
    ...result,
    playbackClock: {
      seconds: sourceSeconds + elapsedSec * playbackRate,
      startedAtMs,
      playbackRate
    }
  }
}

const alignPlaybackClocks = (
  leaderResult: HorizontalBrowseLinkedGridVisualTransactionResult,
  followerResult: HorizontalBrowseLinkedGridVisualTransactionResult
) => {
  const leaderClock = leaderResult.playbackClock
  const followerClock = followerResult.playbackClock
  if (!leaderClock || !followerClock) {
    return {
      leaderResult,
      followerResult
    }
  }
  const leaderStartedAtMs = Number(leaderClock.startedAtMs)
  const followerStartedAtMs = Number(followerClock.startedAtMs)
  if (!Number.isFinite(leaderStartedAtMs) || !Number.isFinite(followerStartedAtMs)) {
    return {
      leaderResult,
      followerResult
    }
  }
  const startedAtMs = Math.max(leaderStartedAtMs, followerStartedAtMs)
  return {
    leaderResult: normalizePlaybackClockToStartedAt(leaderResult, startedAtMs),
    followerResult: normalizePlaybackClockToStartedAt(followerResult, startedAtMs)
  }
}

export const alignHorizontalBrowseLinkedGridVisualTransactionResults = (
  results: HorizontalBrowseLinkedGridVisualTransactionResults,
  leader: HorizontalBrowseDeckKey,
  follower: HorizontalBrowseDeckKey
): HorizontalBrowseLinkedGridVisualTransactionResults => {
  const leaderResult = results[leader]
  const followerResult = results[follower]
  if (leaderResult?.committed !== true || followerResult?.committed !== true) return results
  const alignedPlayback = alignPlaybackClocks(leaderResult, followerResult)
  return {
    ...results,
    [leader]: alignedPlayback.leaderResult,
    [follower]: alignedPlayback.followerResult
  }
}
