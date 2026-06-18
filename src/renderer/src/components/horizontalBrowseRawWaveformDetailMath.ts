import { HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM } from '@renderer/components/horizontalBrowseWaveform.constants'
import { clampNumber } from '@renderer/components/horizontalBrowseMath'

export const HORIZONTAL_BROWSE_LOCAL_GRID_BPM_EPSILON = 0.0005

const HORIZONTAL_BROWSE_PLAYBACK_RESYNC_THRESHOLD_SEC = 0.04

type PlaybackPositionSample = {
  songKey: string
  seconds: number
  atMs: number
  playbackRate: number
  playing: boolean
}

export const normalizeHorizontalBrowseSharedZoom = (value: unknown, maxZoom: number) => {
  const numeric =
    typeof value === 'object' && value !== null && 'value' in value
      ? Number((value as { value?: unknown }).value)
      : Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM
  return clampNumber(numeric, HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM, maxZoom)
}

export const normalizeHorizontalBrowseTimelineSeconds = (
  seconds: number,
  durationSec: number,
  allowNegativeTimeline: boolean
) => {
  const numeric = Number(seconds)
  if (!Number.isFinite(numeric)) return 0
  if (durationSec > 0) {
    return allowNegativeTimeline
      ? Math.min(numeric, durationSec)
      : clampNumber(numeric, 0, durationSec)
  }
  return allowNegativeTimeline ? numeric : Math.max(0, numeric)
}

export const createHorizontalBrowsePlaybackDiscontinuityDetector = () => {
  let previous: PlaybackPositionSample | null = null

  return {
    reset() {
      previous = null
    },
    check(
      songKey: string,
      seconds: number,
      playing: boolean,
      playbackRateInput: unknown,
      normalizeSeconds: (seconds: number) => number
    ) {
      const nowMs = performance.now()
      const playbackRate = Math.max(0.25, Number(playbackRateInput) || 1)
      const sample = previous
      previous = { songKey, seconds, atMs: nowMs, playbackRate, playing }
      if (!playing || !sample?.playing || sample.songKey !== songKey) return false
      const elapsedSec = Math.max(0, nowMs - sample.atMs) / 1000
      const expectedSeconds = sample.seconds + elapsedSec * sample.playbackRate
      const boundedExpectedSeconds = normalizeSeconds(expectedSeconds)
      return (
        Math.abs(seconds - boundedExpectedSeconds) > HORIZONTAL_BROWSE_PLAYBACK_RESYNC_THRESHOLD_SEC
      )
    }
  }
}
