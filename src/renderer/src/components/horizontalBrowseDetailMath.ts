import type { ISongInfo } from 'src/types/globals'
import { clampNumber } from '@renderer/components/MixtapeBeatAlignDialog.constants'
import { HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO } from '@renderer/components/horizontalBrowseWaveform.constants'

export const clampHorizontalBrowsePreviewStartByVisibleDuration = (
  value: number,
  duration: number,
  visibleDuration: number
) => {
  if (!duration || !visibleDuration) return 0
  const leadingPad = visibleDuration * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
  const trailingPad = visibleDuration * (1 - HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO)
  return clampNumber(value, -leadingPad, Math.max(-leadingPad, duration - trailingPad))
}

export const resolveHorizontalBrowsePlaybackAlignedStart = (
  seconds: number,
  duration: number,
  visibleDuration: number
) =>
  clampHorizontalBrowsePreviewStartByVisibleDuration(
    seconds - visibleDuration * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO,
    duration,
    visibleDuration
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
  const firstBeatMs = Number(song?.firstBeatMs)
  const firstBeatSec = Number.isFinite(firstBeatMs) ? firstBeatMs / 1000 : 0
  if (firstBeatSec <= 0.000001) return 0
  return clampNumber(firstBeatSec, 0, duration)
}
