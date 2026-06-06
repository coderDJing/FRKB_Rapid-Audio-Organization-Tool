import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { HORIZONTAL_BROWSE_RAW_DURATION_TAIL_TOLERANCE_SEC } from '@renderer/components/horizontalBrowseRawWaveformStreamTypes'

export type HorizontalBrowseRawLoadedTimelineRange = {
  rate: number
  loadedFrames: number
  loadedStartSec: number
  loadedEndSec: number
  streamComplete: boolean
}

const resolveAudioSecToTimelineSec = (audioSec: number, timeBasisOffsetSec: number) =>
  Math.max(0, (Number(audioSec) || 0) + Math.max(0, Number(timeBasisOffsetSec) || 0))

const resolveAudioRangeStartSecToTimelineSec = (audioSec: number, timeBasisOffsetSec: number) => {
  const safeAudioSec = Math.max(0, Number(audioSec) || 0)
  if (safeAudioSec <= 0.0001) return 0
  return resolveAudioSecToTimelineSec(safeAudioSec, timeBasisOffsetSec)
}

export const resolveRawWaveformStreamLoadedTimelineRange = (params: {
  current: RawWaveformData | null
  rawStreamStartSec: number
  timeBasisOffsetSec: number
}): HorizontalBrowseRawLoadedTimelineRange => {
  const current = params.current
  const rate = Math.max(0, Number(current?.rate) || 0)
  const loadedFrames = Math.max(0, Number(current?.loadedFrames ?? current?.frames) || 0)
  const totalFrames = Math.max(0, Number(current?.frames) || 0)
  const currentStartSec = Number(current?.startSec)
  const rawStartSec =
    current && Number.isFinite(currentStartSec)
      ? Math.max(0, currentStartSec)
      : Math.max(0, Number(params.rawStreamStartSec) || 0)
  const loadedStartSec = resolveAudioRangeStartSecToTimelineSec(
    rawStartSec,
    params.timeBasisOffsetSec
  )
  const loadedEndSec =
    rate > 0
      ? resolveAudioSecToTimelineSec(rawStartSec + loadedFrames / rate, params.timeBasisOffsetSec)
      : loadedStartSec

  return {
    rate,
    loadedFrames,
    loadedStartSec,
    loadedEndSec,
    streamComplete: Boolean(current && totalFrames > 0 && loadedFrames >= totalFrames)
  }
}

export const resolveRawWaveformStreamVisibleTimelineRange = (params: {
  anchorSec: number
  visibleDurationSec: number
  songDurationSec: number
  overscanFactor?: number
}) => {
  const visibleDurationSec = Math.max(0.001, Number(params.visibleDurationSec) || 0.001)
  const halfVisible = visibleDurationSec * 0.5
  const overscanSec = Math.max(
    0,
    visibleDurationSec * Math.max(0, Number(params.overscanFactor) || 0)
  )
  const anchorSec = Math.max(0, Number(params.anchorSec) || 0)
  const songDurationSec = Math.max(0, Number(params.songDurationSec) || 0)
  const visibleStartSec = Math.max(0, anchorSec - halfVisible - overscanSec)
  const visibleEndSec =
    songDurationSec > 0
      ? Math.min(songDurationSec, anchorSec + halfVisible + overscanSec)
      : anchorSec + halfVisible + overscanSec

  return {
    visibleDurationSec,
    visibleStartSec,
    visibleEndSec
  }
}

export const resolveRawWaveformStreamCoverageEndSec = (params: {
  visibleEndSec: number
  loadedEndSec: number
  streamComplete: boolean
  songDurationSec: number
}) => {
  const songDurationSec = Math.max(0, Number(params.songDurationSec) || 0)
  const loadedEndSec = Math.max(0, Number(params.loadedEndSec) || 0)
  if (
    params.streamComplete &&
    songDurationSec > 0 &&
    loadedEndSec > 0 &&
    params.visibleEndSec >= loadedEndSec &&
    songDurationSec - loadedEndSec >= 0 &&
    songDurationSec - loadedEndSec <= HORIZONTAL_BROWSE_RAW_DURATION_TAIL_TOLERANCE_SEC
  ) {
    return Math.min(params.visibleEndSec, loadedEndSec)
  }
  return params.visibleEndSec
}

export const isRawWaveformStreamCoveringVisibleRange = (params: {
  current: RawWaveformData | null
  rawStreamStartSec: number
  timeBasisOffsetSec: number
  anchorSec: number
  visibleDurationSec: number
  songDurationSec: number
  overscanFactor?: number
}) => {
  if (!params.current) return false
  const loadedRange = resolveRawWaveformStreamLoadedTimelineRange(params)
  const visibleRange = resolveRawWaveformStreamVisibleTimelineRange(params)
  const coverageEndSec = resolveRawWaveformStreamCoverageEndSec({
    visibleEndSec: visibleRange.visibleEndSec,
    loadedEndSec: loadedRange.loadedEndSec,
    streamComplete: loadedRange.streamComplete,
    songDurationSec: params.songDurationSec
  })
  return (
    visibleRange.visibleStartSec >= loadedRange.loadedStartSec &&
    coverageEndSec <= loadedRange.loadedEndSec
  )
}

export const isRawWaveformActiveInitialStreamCoveringVisibleCore = (params: {
  requestId: string
  active: boolean
  chunkCount: number
  rawStreamTargetRate: number
  targetRate: number
  rawStreamStartSec: number
  bootstrapDurationSec: number
  timeBasisOffsetSec: number
  anchorSec: number
  visibleDurationSec: number
  songDurationSec: number
}) => {
  if (
    !params.requestId ||
    !params.active ||
    params.chunkCount > 0 ||
    params.rawStreamTargetRate < params.targetRate
  ) {
    return false
  }

  const startSec = resolveAudioRangeStartSecToTimelineSec(
    params.rawStreamStartSec,
    params.timeBasisOffsetSec
  )
  const endSec = startSec + Math.max(params.bootstrapDurationSec, 0.001)
  const { visibleStartSec, visibleEndSec } = resolveRawWaveformStreamVisibleTimelineRange(params)
  return visibleStartSec >= startSec - 0.001 && visibleEndSec <= endSec + 0.001
}
