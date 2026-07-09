import type { ISongInfo } from 'src/types/globals'
import { clampNumber } from '@renderer/composables/horizontalBrowse/horizontalBrowseMath'
import { HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveform.constants'
import { resolveNearestSongBeatGridLine } from '@shared/songBeatGridMap'

export const clampHorizontalBrowsePreviewStartByVisibleDuration = (
  value: number,
  duration: number,
  visibleDuration: number,
  allowNegativeTimeline = false
) => {
  if (!duration || !visibleDuration) return 0
  const leadingPad = visibleDuration * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
  const trailingPad = visibleDuration * (1 - HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO)
  const maxStart = Math.max(-leadingPad, duration - trailingPad)
  if (allowNegativeTimeline) {
    return Math.min(Number.isFinite(value) ? value : 0, maxStart)
  }
  return clampNumber(value, -leadingPad, maxStart)
}

export const resolveHorizontalBrowsePlaybackAlignedStart = (
  seconds: number,
  duration: number,
  visibleDuration: number,
  allowNegativeTimeline = false
) =>
  clampHorizontalBrowsePreviewStartByVisibleDuration(
    seconds - visibleDuration * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO,
    duration,
    visibleDuration,
    allowNegativeTimeline
  )

export const resolveHorizontalBrowseTimePercent = (
  seconds: number,
  rangeStartSec: number,
  rangeDurationSec: number
) => {
  if (!Number.isFinite(seconds) || rangeDurationSec <= 0) return null
  const ratio = (seconds - rangeStartSec) / rangeDurationSec
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) return null
  return ratio
}

export const resolveHorizontalBrowseCuePointSec = (
  song: ISongInfo | null,
  candidateSec: number,
  durationSec: number
) => {
  const duration =
    Number.isFinite(durationSec) && durationSec > 0 ? durationSec : Math.max(0, candidateSec)
  const safeCandidate =
    duration > 0 ? clampNumber(candidateSec, 0, duration) : Math.max(0, candidateSec)
  if (safeCandidate <= 0.000001) return 0
  const nearestDynamicLine = resolveNearestSongBeatGridLine(
    song?.beatGridMap,
    duration,
    safeCandidate
  )
  if (nearestDynamicLine) {
    const snappedDynamicSec =
      duration > 0
        ? clampNumber(nearestDynamicLine.sec, 0, duration)
        : Math.max(0, nearestDynamicLine.sec)
    return Math.abs(safeCandidate) <= Math.abs(safeCandidate - snappedDynamicSec)
      ? 0
      : snappedDynamicSec
  }

  const bpm = Number(song?.bpm)
  if (!Number.isFinite(bpm) || bpm <= 0) return 0

  const beatSec = 60 / bpm
  if (!Number.isFinite(beatSec) || beatSec <= 0) return 0

  const firstBeatMs = Number(song?.firstBeatMs)
  const firstBeatSec = Number.isFinite(firstBeatMs) ? firstBeatMs / 1000 : 0
  const nearestBeatIndex = Math.round((safeCandidate - firstBeatSec) / beatSec)
  const snappedBeatSec =
    duration > 0
      ? clampNumber(firstBeatSec + nearestBeatIndex * beatSec, 0, duration)
      : Math.max(0, firstBeatSec + nearestBeatIndex * beatSec)

  return Math.abs(safeCandidate) <= Math.abs(safeCandidate - snappedBeatSec) ? 0 : snappedBeatSec
}

export const resolveHorizontalBrowseDefaultCuePointSec = (
  song: ISongInfo | null,
  durationSec = 0
) => {
  const duration =
    Number.isFinite(durationSec) && durationSec > 0 ? durationSec : Number.POSITIVE_INFINITY
  const nearestDynamicLine = resolveNearestSongBeatGridLine(song?.beatGridMap, duration, 0)
  if (nearestDynamicLine) {
    return clampNumber(nearestDynamicLine.sec, 0, duration)
  }
  const firstBeatMs = Number(song?.firstBeatMs)
  const firstBeatSec = Number.isFinite(firstBeatMs) ? firstBeatMs / 1000 : 0
  if (firstBeatSec <= 0.000001) return 0
  return clampNumber(firstBeatSec, 0, duration)
}
