import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'

export type HorizontalBrowseLinkedGridVisualTransactionGridTimeBasis = {
  bpm: number
  firstBeatMs: number
  barBeatOffset: number
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

const BAR_BEAT_INTERVAL = 32

const normalizePhase = (value: number, modulo: number) => {
  if (!Number.isFinite(value) || !Number.isFinite(modulo) || modulo <= 0) return 0
  return ((value % modulo) + modulo) % modulo
}

const normalizeBarBeatOffset = (value: number) =>
  normalizePhase(Math.round(Number.isFinite(value) ? value : 0), BAR_BEAT_INTERVAL)

const resolveBeatDistance = (result: HorizontalBrowseLinkedGridVisualTransactionResult) => {
  const bpm = Number(result.gridTimeBasis.bpm)
  if (!Number.isFinite(bpm) || bpm <= 0) return null
  const beatSec = 60 / bpm
  if (!Number.isFinite(beatSec) || beatSec <= 0) return null
  const anchorSec = Number(result.anchorSec)
  if (!Number.isFinite(anchorSec)) return null
  const firstBeatSec = (Number(result.gridTimeBasis.firstBeatMs) || 0) / 1000
  return (anchorSec - firstBeatSec) / beatSec
}

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
  const leaderBeatDistance = resolveBeatDistance(leaderResult)
  const followerBeatDistance = resolveBeatDistance(followerResult)
  if (leaderBeatDistance === null || followerBeatDistance === null) return results
  const leaderBarPhase = normalizePhase(
    leaderBeatDistance - normalizeBarBeatOffset(leaderResult.gridTimeBasis.barBeatOffset),
    BAR_BEAT_INTERVAL
  )
  const alignedPlayback = alignPlaybackClocks(leaderResult, followerResult)
  const alignedLeaderResult = alignedPlayback.leaderResult
  const alignedFollowerResult = alignedPlayback.followerResult
  return {
    ...results,
    [leader]: alignedLeaderResult,
    [follower]: {
      ...alignedFollowerResult,
      gridTimeBasis: {
        ...alignedFollowerResult.gridTimeBasis,
        barBeatOffset: normalizeBarBeatOffset(followerBeatDistance - leaderBarPhase)
      }
    }
  }
}
