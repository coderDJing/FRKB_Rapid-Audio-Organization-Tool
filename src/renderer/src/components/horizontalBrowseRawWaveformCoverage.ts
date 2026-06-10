import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { HORIZONTAL_BROWSE_RAW_DURATION_TAIL_TOLERANCE_SEC } from '@renderer/components/horizontalBrowseRawWaveformStreamTypes'

const resolveRawDataStartSec = (rawData: RawWaveformData | null, timeBasisOffsetSec: number) => {
  if (!rawData) return 0
  return Math.max(0, Number(rawData.startSec) || 0) + timeBasisOffsetSec
}

const resolveRawDataCoverageStartSec = (
  rawData: RawWaveformData | null,
  timeBasisOffsetSec: number
) => {
  if (!rawData) return 0
  const audioStartSec = Math.max(0, Number(rawData.startSec) || 0)
  if (audioStartSec <= 0.0001) return 0
  return resolveRawDataStartSec(rawData, timeBasisOffsetSec)
}

const resolveHorizontalBrowseRawDataCoveredEndSec = (
  rawData: RawWaveformData | null,
  timeBasisOffsetSec: number
) => {
  if (!rawData) return 0
  const startSec = resolveRawDataStartSec(rawData, timeBasisOffsetSec)
  const rate = Math.max(0, Number(rawData.rate) || 0)
  if (!rate) return startSec
  const loadedFrames = Math.max(0, Number(rawData.loadedFrames ?? rawData.frames) || 0)
  return startSec + loadedFrames / rate
}

const resolveHorizontalBrowseRawDataEffectiveEndSec = (
  rawData: RawWaveformData | null,
  timeBasisOffsetSec: number
) => {
  if (!rawData) return Number.POSITIVE_INFINITY
  const songDurationSec = Math.max(0, Number(rawData.duration) || 0)
  const totalFrames = Math.max(0, Math.floor(Number(rawData.frames) || 0))
  const loadedFrames = Math.max(0, Math.floor(Number(rawData.loadedFrames ?? totalFrames) || 0))
  const rawEndSec = resolveHorizontalBrowseRawDataCoveredEndSec(rawData, timeBasisOffsetSec)
  const tailGapSec = songDurationSec - rawEndSec
  if (
    totalFrames > 0 &&
    loadedFrames >= totalFrames &&
    songDurationSec > 0 &&
    rawEndSec > 0 &&
    tailGapSec >= 0 &&
    tailGapSec <= HORIZONTAL_BROWSE_RAW_DURATION_TAIL_TOLERANCE_SEC
  ) {
    return rawEndSec
  }
  return songDurationSec > 0 ? songDurationSec : Number.POSITIVE_INFINITY
}

export const resolveHorizontalBrowsePlaybackDurationSec = (
  rawData: RawWaveformData | null,
  previewDurationSec: number,
  timeBasisOffsetSec: number
) => {
  const effectiveEndSec = resolveHorizontalBrowseRawDataEffectiveEndSec(rawData, timeBasisOffsetSec)
  if (Number.isFinite(effectiveEndSec) && effectiveEndSec > 0) {
    return previewDurationSec > 0 ? Math.min(previewDurationSec, effectiveEndSec) : effectiveEndSec
  }
  return previewDurationSec
}

export const isHorizontalBrowseRawDataCoveringRange = (
  rawData: RawWaveformData | null,
  rangeStartSec: number,
  rangeDurationSec: number,
  timeBasisOffsetSec: number
) => {
  if (!rawData) return false
  const rawStartSec = resolveRawDataCoverageStartSec(rawData, timeBasisOffsetSec)
  const rawEndSec = resolveHorizontalBrowseRawDataCoveredEndSec(rawData, timeBasisOffsetSec)
  const rangeEndSec = rangeStartSec + Math.max(0, rangeDurationSec)
  const audioEndSec = resolveHorizontalBrowseRawDataEffectiveEndSec(rawData, timeBasisOffsetSec)
  const audibleStartSec = Math.max(rangeStartSec, 0)
  const audibleEndSec = Math.min(rangeEndSec, audioEndSec)
  if (audibleEndSec <= audibleStartSec) {
    return true
  }
  return audibleStartSec >= rawStartSec && audibleEndSec <= rawEndSec
}

export const isHorizontalBrowseRawDataIntersectingRange = (
  rawData: RawWaveformData | null,
  rangeStartSec: number,
  rangeDurationSec: number,
  timeBasisOffsetSec: number
) => {
  if (!rawData) return false
  const rawStartSec = resolveRawDataCoverageStartSec(rawData, timeBasisOffsetSec)
  const rawEndSec = resolveHorizontalBrowseRawDataCoveredEndSec(rawData, timeBasisOffsetSec)
  const rangeEndSec = rangeStartSec + Math.max(0, rangeDurationSec)
  return rangeEndSec > rawStartSec && rangeStartSec < rawEndSec
}
