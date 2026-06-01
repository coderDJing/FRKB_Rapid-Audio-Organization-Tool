import type { RawWaveformData } from '@renderer/composables/mixtape/types'

type ResolveEffectiveTimelineEndOptions = {
  rawData: RawWaveformData | null
  durationSec: number
  timeBasisOffsetMs: number
  tailToleranceSec: number
}

const resolveRawTimelineEndSec = (
  rawData: RawWaveformData | null,
  timeBasisOffsetMs: number,
  tailToleranceSec: number
) => {
  if (!rawData) return null
  const rate = Math.max(0, Number(rawData.rate) || 0)
  const totalFrames = Math.max(0, Math.floor(Number(rawData.frames) || 0))
  const loadedFrames = Math.max(0, Math.floor(Number(rawData.loadedFrames ?? totalFrames) || 0))
  const rawStartSec = Math.max(0, Number(rawData.startSec) || 0)
  const durationSec = Math.max(0, Number(rawData.duration) || 0)
  if (rawStartSec > 0.0001 || rate <= 0 || totalFrames <= 0 || loadedFrames < totalFrames) {
    return null
  }
  const rawEndSec =
    rawStartSec + totalFrames / rate + Math.max(0, Number(timeBasisOffsetMs) || 0) / 1000
  const tailGapSec = durationSec - rawEndSec
  if (durationSec <= 0 || rawEndSec <= 0 || tailGapSec < 0 || tailGapSec > tailToleranceSec) {
    return null
  }
  return rawEndSec
}

export const resolveHorizontalBrowseEffectiveTimelineEndSec = ({
  rawData,
  durationSec,
  timeBasisOffsetMs,
  tailToleranceSec
}: ResolveEffectiveTimelineEndOptions) => {
  const rawEndSec = resolveRawTimelineEndSec(rawData, timeBasisOffsetMs, tailToleranceSec)
  if (rawEndSec === null) return durationSec
  return durationSec > 0 ? Math.min(durationSec, rawEndSec) : rawEndSec
}
