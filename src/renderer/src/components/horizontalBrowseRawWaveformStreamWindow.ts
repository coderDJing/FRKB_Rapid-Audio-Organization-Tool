import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import type { PendingRawStreamChunkWork } from '@renderer/components/horizontalBrowseRawWaveformStreamTypes'
import {
  HORIZONTAL_BROWSE_RAW_PLAYING_APPEND_OVERLAP_SEC,
  HORIZONTAL_BROWSE_RAW_PLAYING_WINDOW_TRAILING_FACTOR
} from '@renderer/components/horizontalBrowseRawWaveformStreamTypes'
import { isRawWaveformWindowFormatCompatible } from '@renderer/components/horizontalBrowseRawWaveformRollingBuffer'

export const resolvePlayingRawWindowStartAudioSec = (
  anchorSec: number,
  visibleDurationSec: number,
  timeBasisOffsetSec: number
) =>
  Math.max(
    0,
    Math.max(0, Number(anchorSec) || 0) -
      Math.max(0.001, Number(visibleDurationSec) || 0.001) *
        HORIZONTAL_BROWSE_RAW_PLAYING_WINDOW_TRAILING_FACTOR -
      Math.max(0, Number(timeBasisOffsetSec) || 0)
  )

export const resolveSafePlayingRawWindowStartAudioSec = (
  current: RawWaveformData,
  requestedStartSec: number,
  visibleDurationSec: number
) => {
  const rate = Math.max(0, Number(current.rate) || 0)
  if (!rate) return Math.max(0, Number(current.startSec) || 0)
  const currentStartSec = Math.max(0, Number(current.startSec) || 0)
  const loadedFrames = Math.max(0, Math.floor(Number(current.loadedFrames ?? current.frames) || 0))
  const loadedEndSec = currentStartSec + loadedFrames / rate
  const minRetainedDurationSec =
    Math.max(0.5, Number(visibleDurationSec) || 0.001) *
    HORIZONTAL_BROWSE_RAW_PLAYING_WINDOW_TRAILING_FACTOR
  const maxSafeStartSec = Math.max(currentStartSec, loadedEndSec - minRetainedDurationSec)
  return Math.max(currentStartSec, Math.min(Math.max(0, requestedStartSec), maxSafeStartSec))
}

export const resolveChunkRawWindowStartSec = (
  current: RawWaveformData | null,
  work: PendingRawStreamChunkWork
) => {
  const workStartSec = Math.max(0, Number(work.startSec) || 0)
  const rate = Math.max(0, Number(work.rate) || 0)
  if (
    current &&
    isRawWaveformWindowFormatCompatible(current, {
      duration: work.duration,
      sampleRate: work.sampleRate,
      rate: work.rate
    })
  ) {
    const currentStartSec = Math.max(0, Number(current.startSec) || 0)
    const chunkEndSec =
      rate > 0 ? workStartSec + (work.startFrame + work.chunkFrames) / rate : workStartSec
    if (chunkEndSec > currentStartSec + 0.0001) {
      return currentStartSec
    }
  }
  return workStartSec
}

export const resolveRawStreamAppendStartAudioSec = (
  loadedEndTimelineSec: number,
  timeBasisOffsetSec: number
) =>
  Math.max(
    0,
    Math.max(0, Number(loadedEndTimelineSec) || 0) -
      HORIZONTAL_BROWSE_RAW_PLAYING_APPEND_OVERLAP_SEC -
      Math.max(0, Number(timeBasisOffsetSec) || 0)
  )
