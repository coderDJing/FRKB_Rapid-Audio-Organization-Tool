import type { ISongInfo } from 'src/types/globals'
import { clampNumber } from '@renderer/composables/horizontalBrowse/horizontalBrowseMath'
import { HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveform.constants'
import { resolveNearestUnifiedSongBeatGridLine } from '@shared/songBeatGridRuntime'

type HorizontalBrowseGridSong = Pick<ISongInfo, 'beatGridMap'>

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
  song: HorizontalBrowseGridSong | null,
  candidateSec: number,
  durationSec: number
) => {
  const duration =
    Number.isFinite(durationSec) && durationSec > 0 ? durationSec : Math.max(0, candidateSec)
  const safeCandidate =
    duration > 0 ? clampNumber(candidateSec, 0, duration) : Math.max(0, candidateSec)
  if (safeCandidate <= 0.000001) return 0
  const nearestDynamicLine = resolveNearestUnifiedSongBeatGridLine(
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

  return 0
}

export const resolveHorizontalBrowseDefaultCuePointSec = (
  song: HorizontalBrowseGridSong | null,
  durationSec = 0
) => {
  const duration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0
  const nearestDynamicLine = resolveNearestUnifiedSongBeatGridLine(song?.beatGridMap, duration, 0)
  if (nearestDynamicLine) {
    return clampNumber(nearestDynamicLine.sec, 0, duration)
  }
  return 0
}
