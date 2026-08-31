import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import type { WaveformGlobalOverviewData } from '@shared/waveformSurfaceCache'
import {
  AUDIO_EDIT_EPSILON_SEC,
  isIdentityAudioEditClips,
  mapAudioEditPlanToSource,
  resolveAudioEditPlanDuration,
  roundAudioEditSec,
  type AudioEditClip
} from '@shared/audioEditTimeline'

const remapBytes = (
  values: Uint8Array | undefined,
  sourceDurationSec: number,
  planDurationSec: number,
  clips: readonly AudioEditClip[],
  rate: number
) => {
  if (!values?.length || !(rate > 0) || !(planDurationSec > 0)) {
    return values ? new Uint8Array(values) : new Uint8Array()
  }
  const outLength = Math.max(1, Math.round(planDurationSec * rate))
  const out = new Uint8Array(outLength)
  const sourceLength = values.length
  for (let index = 0; index < outLength; index += 1) {
    const planSec = index / rate
    const mapped = mapAudioEditPlanToSource(clips, planSec)
    const sourceSec = mapped?.sourceSec ?? 0
    const sourceIndex = Math.max(
      0,
      Math.min(
        sourceLength - 1,
        Math.floor((sourceSec / Math.max(sourceDurationSec, 0.0001)) * sourceLength)
      )
    )
    out[index] = values[sourceIndex] || 0
  }
  return out
}

export const remapAudioEditOverviewWaveform = (
  data: WaveformGlobalOverviewData | null,
  clips: readonly AudioEditClip[]
): WaveformGlobalOverviewData | null => {
  if (!data) return null
  const planDurationSec = resolveAudioEditPlanDuration(clips)
  if (!(planDurationSec > 0)) return data
  const sourceDurationSec = Math.max(0.0001, Number(data.duration) || planDurationSec)
  const detailRate = Math.max(1, Number(data.detailRate) || 1)
  const overviewRate = Math.max(1, Number(data.overviewRate) || 1)
  return {
    ...data,
    duration: planDurationSec,
    detailPeakTop: remapBytes(
      data.detailPeakTop,
      sourceDurationSec,
      planDurationSec,
      clips,
      detailRate
    ),
    detailPeakBottom: remapBytes(
      data.detailPeakBottom,
      sourceDurationSec,
      planDurationSec,
      clips,
      detailRate
    ),
    detailBody: remapBytes(
      data.detailBody,
      sourceDurationSec,
      planDurationSec,
      clips,
      detailRate / Math.max(1, Number(data.bodyRateDivisor) || 1)
    ),
    colorIndex: remapBytes(data.colorIndex, sourceDurationSec, planDurationSec, clips, detailRate),
    colorLow: remapBytes(data.colorLow, sourceDurationSec, planDurationSec, clips, detailRate),
    colorMid: remapBytes(data.colorMid, sourceDurationSec, planDurationSec, clips, detailRate),
    colorHigh: remapBytes(data.colorHigh, sourceDurationSec, planDurationSec, clips, detailRate),
    colorRed: remapBytes(data.colorRed, sourceDurationSec, planDurationSec, clips, detailRate),
    colorGreen: remapBytes(data.colorGreen, sourceDurationSec, planDurationSec, clips, detailRate),
    colorBlue: remapBytes(data.colorBlue, sourceDurationSec, planDurationSec, clips, detailRate),
    overviewTop: remapBytes(
      data.overviewTop,
      sourceDurationSec,
      planDurationSec,
      clips,
      overviewRate
    ),
    overviewBottom: remapBytes(
      data.overviewBottom,
      sourceDurationSec,
      planDurationSec,
      clips,
      overviewRate
    )
  }
}

const remapWaveformSamples = <T extends Float32Array | Uint8Array>(
  values: T | undefined,
  sourceFrames: number,
  sourceIndexByOut: Int32Array
): T | undefined => {
  if (!values) return values
  const Ctor = values.constructor as new (length: number) => T
  const out = new Ctor(sourceIndexByOut.length)
  if (!values.length) return out
  const scale = values.length / Math.max(1, sourceFrames)
  for (let index = 0; index < sourceIndexByOut.length; index += 1) {
    const sourceIndex = Math.max(
      0,
      Math.min(values.length - 1, Math.floor(sourceIndexByOut[index] * scale))
    )
    out[index] = values[sourceIndex]
  }
  return out
}

const buildAudioEditRawSourceIndexMap = (
  clips: readonly AudioEditClip[],
  rate: number,
  sourceFrames: number,
  outFrames: number
) => {
  const sourceIndexByOut = new Int32Array(outFrames)
  let planCursorSec = 0
  let outIndex = 0
  for (const clip of clips) {
    const clipDurationSec = roundAudioEditSec(Math.max(0, clip.sourceEndSec - clip.sourceStartSec))
    if (clipDurationSec <= AUDIO_EDIT_EPSILON_SEC) continue
    const clipPlanEndSec = roundAudioEditSec(planCursorSec + clipDurationSec)
    const clipOutEnd = Math.min(outFrames, Math.round(clipPlanEndSec * rate))
    while (outIndex < clipOutEnd) {
      const planSec = outIndex / rate
      const sourceSec = clip.sourceStartSec + (planSec - planCursorSec)
      sourceIndexByOut[outIndex] = Math.max(
        0,
        Math.min(sourceFrames - 1, Math.floor(sourceSec * rate))
      )
      outIndex += 1
    }
    planCursorSec = clipPlanEndSec
  }
  const lastIndex = sourceIndexByOut[Math.max(0, outIndex - 1)] || 0
  while (outIndex < outFrames) {
    sourceIndexByOut[outIndex] = lastIndex
    outIndex += 1
  }
  return sourceIndexByOut
}

export const remapAudioEditRawWaveform = (
  data: RawWaveformData | null,
  clips: readonly AudioEditClip[] | null | undefined
): RawWaveformData | null => {
  if (!data) return null
  const sourceDurationSec = Math.max(0, Number(data.duration) || 0)
  if (!clips?.length || isIdentityAudioEditClips(clips, sourceDurationSec)) return data
  const planDurationSec = resolveAudioEditPlanDuration(clips)
  if (!(planDurationSec > AUDIO_EDIT_EPSILON_SEC)) return data
  const rate = Math.max(1, Number(data.rate) || 1)
  const sourceFrames = Math.max(1, Number(data.frames) || data.minLeft.length || 1)
  const outFrames = Math.max(1, Math.round(planDurationSec * rate))
  const sourceIndexByOut = buildAudioEditRawSourceIndexMap(clips, rate, sourceFrames, outFrames)
  const emptyPeaks = () => new Float32Array(outFrames)
  return {
    ...data,
    duration: planDurationSec,
    frames: outFrames,
    startSec: 0,
    loadedFrames: outFrames,
    compactColorStartFrame: 0,
    minLeft: remapWaveformSamples(data.minLeft, sourceFrames, sourceIndexByOut) || emptyPeaks(),
    maxLeft: remapWaveformSamples(data.maxLeft, sourceFrames, sourceIndexByOut) || emptyPeaks(),
    minRight: remapWaveformSamples(data.minRight, sourceFrames, sourceIndexByOut) || emptyPeaks(),
    maxRight: remapWaveformSamples(data.maxRight, sourceFrames, sourceIndexByOut) || emptyPeaks(),
    meanLeft: remapWaveformSamples(data.meanLeft, sourceFrames, sourceIndexByOut),
    meanRight: remapWaveformSamples(data.meanRight, sourceFrames, sourceIndexByOut),
    rmsLeft: remapWaveformSamples(data.rmsLeft, sourceFrames, sourceIndexByOut),
    rmsRight: remapWaveformSamples(data.rmsRight, sourceFrames, sourceIndexByOut),
    compactColorIndex: remapWaveformSamples(data.compactColorIndex, sourceFrames, sourceIndexByOut),
    compactColorLow: remapWaveformSamples(data.compactColorLow, sourceFrames, sourceIndexByOut),
    compactColorMid: remapWaveformSamples(data.compactColorMid, sourceFrames, sourceIndexByOut),
    compactColorHigh: remapWaveformSamples(data.compactColorHigh, sourceFrames, sourceIndexByOut),
    compactColorRed: remapWaveformSamples(data.compactColorRed, sourceFrames, sourceIndexByOut),
    compactColorGreen: remapWaveformSamples(data.compactColorGreen, sourceFrames, sourceIndexByOut),
    compactColorBlue: remapWaveformSamples(data.compactColorBlue, sourceFrames, sourceIndexByOut)
  }
}
