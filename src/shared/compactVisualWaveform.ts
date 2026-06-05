import {
  buildRawWaveformColorProfile,
  resolveRekordboxLikeRawColor,
  type RawWaveformColorSource
} from './rawWaveformColor'

export const COMPACT_VISUAL_WAVEFORM_CACHE_VERSION = 1
export const COMPACT_VISUAL_WAVEFORM_PARAMETER_VERSION = 5
export const COMPACT_VISUAL_WAVEFORM_TARGET_BYTES = 500 * 1024
export const COMPACT_VISUAL_WAVEFORM_OVERVIEW_RATE = 32
export const COMPACT_VISUAL_WAVEFORM_BODY_RATE_DIVISOR = 5
export const COMPACT_VISUAL_WAVEFORM_COLOR_RATE_DIVISOR = 12
export const COMPACT_VISUAL_WAVEFORM_MIN_DETAIL_RATE = 240
export const COMPACT_VISUAL_WAVEFORM_MAX_DETAIL_RATE = 1500
export const COMPACT_VISUAL_WAVEFORM_COLOR_RAW_RATE = 4800

export type CompactVisualWaveformData = {
  version: number
  parameterVersion: number
  duration: number
  sampleRate: number
  detailRate: number
  overviewRate: number
  bodyRateDivisor: number
  colorRateDivisor: number
  detailPeakTop: Uint8Array
  detailPeakBottom: Uint8Array
  detailBody: Uint8Array
  colorIndex: Uint8Array
  colorLow: Uint8Array
  colorMid: Uint8Array
  colorHigh: Uint8Array
  colorRed: Uint8Array
  colorGreen: Uint8Array
  colorBlue: Uint8Array
  overviewTop: Uint8Array
  overviewBottom: Uint8Array
}

export type CompactVisualWaveformPreviewData = CompactVisualWaveformData

export type CompactVisualWaveformBuildSourceBand = {
  left: Uint8Array
  right: Uint8Array
  peakLeft?: Uint8Array
  peakRight?: Uint8Array
}

export type CompactVisualWaveformBuildSource = {
  duration: number
  sampleRate: number
  bands: {
    low: CompactVisualWaveformBuildSourceBand
    mid: CompactVisualWaveformBuildSourceBand
    high: CompactVisualWaveformBuildSourceBand
    all: CompactVisualWaveformBuildSourceBand
  }
}

export type CompactVisualWaveformMixxxData = {
  duration: number
  sampleRate: number
  step: number
  bands: Record<
    'low' | 'mid' | 'high' | 'all',
    {
      left: Uint8Array
      right: Uint8Array
      peakLeft: Uint8Array
      peakRight: Uint8Array
    }
  >
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const toByte = (value: number) => clamp(Math.round(value), 0, 255)

export const compactVisualWaveformToPreviewData = (
  data: CompactVisualWaveformData
): CompactVisualWaveformPreviewData | null => {
  const detailFrames = Math.min(data.detailPeakTop?.length || 0, data.detailPeakBottom?.length || 0)
  const colorFrames = Math.min(
    data.colorIndex?.length || 0,
    data.colorRed?.length || 0,
    data.colorGreen?.length || 0,
    data.colorBlue?.length || 0
  )
  if (!detailFrames || !colorFrames || !data.duration || !data.sampleRate || !data.detailRate) {
    return null
  }
  return data
}

export const resolveCompactVisualWaveformDetailRate = (durationSec: number): number => {
  const duration = Math.max(1, Number(durationSec) || 1)
  const overviewBytes = duration * COMPACT_VISUAL_WAVEFORM_OVERVIEW_RATE * 2
  const headerAndIndexBytes = 8 * 1024
  const reserveBytes = COMPACT_VISUAL_WAVEFORM_TARGET_BYTES * 0.08
  const detailBudget =
    COMPACT_VISUAL_WAVEFORM_TARGET_BYTES - overviewBytes - headerAndIndexBytes - reserveBytes
  const bytesPerDetailFrame = 1.4
  return clamp(
    Math.floor(detailBudget / Math.max(1, duration * bytesPerDetailFrame)),
    COMPACT_VISUAL_WAVEFORM_MIN_DETAIL_RATE,
    COMPACT_VISUAL_WAVEFORM_MAX_DETAIL_RATE
  )
}

const resolveFrame = (sourceFrames: number, targetIndex: number, targetFrames: number) => {
  if (sourceFrames <= 1 || targetFrames <= 1) return 0
  return clamp(Math.floor((targetIndex / targetFrames) * sourceFrames), 0, sourceFrames - 1)
}

const resolveBandPeak = (
  band: CompactVisualWaveformBuildSourceBand,
  frame: number,
  side: 'left' | 'right'
) => {
  const body = side === 'left' ? band.left[frame] : band.right[frame]
  const peak = side === 'left' ? band.peakLeft?.[frame] : band.peakRight?.[frame]
  return Math.max(Number(body) || 0, Number(peak) || 0)
}

export const buildCompactVisualWaveformFromMixxx = (
  source: CompactVisualWaveformBuildSource,
  rawColorSource: RawWaveformColorSource
): CompactVisualWaveformData | null => {
  const duration = Math.max(0, Number(source?.duration) || 0)
  const sampleRate = Math.max(0, Number(source?.sampleRate) || 0)
  const sourceFrames = Math.min(
    source?.bands?.low?.left?.length || 0,
    source?.bands?.low?.right?.length || 0,
    source?.bands?.mid?.left?.length || 0,
    source?.bands?.mid?.right?.length || 0,
    source?.bands?.high?.left?.length || 0,
    source?.bands?.high?.right?.length || 0,
    source?.bands?.all?.left?.length || 0,
    source?.bands?.all?.right?.length || 0
  )
  if (!duration || !sampleRate || sourceFrames <= 0) return null

  const detailRate = resolveCompactVisualWaveformDetailRate(duration)
  const detailFrames = Math.max(1, Math.ceil(duration * detailRate))
  const overviewFrames = Math.max(1, Math.ceil(duration * COMPACT_VISUAL_WAVEFORM_OVERVIEW_RATE))
  const detailPeakTop = new Uint8Array(detailFrames)
  const detailPeakBottom = new Uint8Array(detailFrames)
  const detailBody = new Uint8Array(
    Math.max(1, Math.ceil(detailFrames / COMPACT_VISUAL_WAVEFORM_BODY_RATE_DIVISOR))
  )
  const colorProfile = buildRawWaveformColorProfile(
    rawColorSource,
    detailFrames,
    detailRate,
    COMPACT_VISUAL_WAVEFORM_COLOR_RATE_DIVISOR
  )
  if (!colorProfile) return null
  const { colorIndex, colorLow, colorMid, colorHigh, colorRed, colorGreen, colorBlue } =
    colorProfile
  const overviewTop = new Uint8Array(overviewFrames)
  const overviewBottom = new Uint8Array(overviewFrames)

  for (let index = 0; index < detailFrames; index += 1) {
    const sourceFrame = resolveFrame(sourceFrames, index, detailFrames)
    const top = resolveBandPeak(source.bands.all, sourceFrame, 'left')
    const bottom = resolveBandPeak(source.bands.all, sourceFrame, 'right')
    detailPeakTop[index] = toByte(top)
    detailPeakBottom[index] = toByte(bottom)
  }

  for (let index = 0; index < detailBody.length; index += 1) {
    const start = index * COMPACT_VISUAL_WAVEFORM_BODY_RATE_DIVISOR
    const end = Math.min(detailFrames, start + COMPACT_VISUAL_WAVEFORM_BODY_RATE_DIVISOR)
    let peak = 0
    let sum = 0
    for (let frame = start; frame < end; frame += 1) {
      const value = Math.max(detailPeakTop[frame] || 0, detailPeakBottom[frame] || 0)
      peak = Math.max(peak, value)
      sum += value
    }
    const mean = sum / Math.max(1, end - start)
    detailBody[index] = toByte(mean * 0.62 + peak * 0.38)
  }

  for (let index = 0; index < overviewFrames; index += 1) {
    const start = Math.floor((index / overviewFrames) * detailFrames)
    const end = Math.max(start + 1, Math.ceil(((index + 1) / overviewFrames) * detailFrames))
    let top = 0
    let bottom = 0
    for (let frame = start; frame < Math.min(detailFrames, end); frame += 1) {
      top = Math.max(top, detailPeakTop[frame] || 0)
      bottom = Math.max(bottom, detailPeakBottom[frame] || 0)
    }
    overviewTop[index] = top
    overviewBottom[index] = bottom
  }

  return {
    version: COMPACT_VISUAL_WAVEFORM_CACHE_VERSION,
    parameterVersion: COMPACT_VISUAL_WAVEFORM_PARAMETER_VERSION,
    duration,
    sampleRate,
    detailRate,
    overviewRate: COMPACT_VISUAL_WAVEFORM_OVERVIEW_RATE,
    bodyRateDivisor: COMPACT_VISUAL_WAVEFORM_BODY_RATE_DIVISOR,
    colorRateDivisor: COMPACT_VISUAL_WAVEFORM_COLOR_RATE_DIVISOR,
    detailPeakTop,
    detailPeakBottom,
    detailBody,
    colorIndex,
    colorLow,
    colorMid,
    colorHigh,
    colorRed,
    colorGreen,
    colorBlue,
    overviewTop,
    overviewBottom
  }
}

export const compactVisualWaveformToMixxxOverview = (
  data: CompactVisualWaveformData
): CompactVisualWaveformMixxxData | null => {
  const frames = Math.min(data.overviewTop?.length || 0, data.overviewBottom?.length || 0)
  const detailFrames = Math.min(data.detailPeakTop?.length || 0, data.detailPeakBottom?.length || 0)
  if (!frames || !detailFrames || !data.duration || !data.sampleRate) return null

  const createBand = () => ({
    left: new Uint8Array(frames),
    right: new Uint8Array(frames),
    peakLeft: new Uint8Array(frames),
    peakRight: new Uint8Array(frames)
  })
  const low = createBand()
  const mid = createBand()
  const high = createBand()
  const all = createBand()

  for (let index = 0; index < frames; index += 1) {
    const top = data.overviewTop[index] || 0
    const bottom = data.overviewBottom[index] || 0
    all.left[index] = top
    all.right[index] = bottom
    all.peakLeft[index] = top
    all.peakRight[index] = bottom

    const detailFrame = Math.min(detailFrames - 1, Math.floor((index / frames) * detailFrames))
    const colorFrame = Math.min(
      data.colorIndex.length - 1,
      Math.floor(detailFrame / Math.max(1, data.colorRateDivisor || 1))
    )
    const color = data.colorIndex[colorFrame] ?? 3
    const lowRatio = (data.colorLow[colorFrame] ?? (color === 0 ? 255 : 90)) / 255
    const midRatio = (data.colorMid[colorFrame] ?? (color === 1 || color === 3 ? 255 : 90)) / 255
    const highRatio = (data.colorHigh[colorFrame] ?? (color === 2 ? 255 : 90)) / 255
    const rgb =
      data.colorRed.length > colorFrame &&
      data.colorGreen.length > colorFrame &&
      data.colorBlue.length > colorFrame
        ? {
            r: data.colorRed[colorFrame] || 0,
            g: data.colorGreen[colorFrame] || 0,
            b: data.colorBlue[colorFrame] || 0
          }
        : resolveRekordboxLikeRawColor(lowRatio, midRatio, highRatio)
    const lowValue = Math.round(top * lowRatio)
    const midValue = Math.round(top * midRatio)
    const highValue = Math.round(top * highRatio)
    low.left[index] = low.peakLeft[index] = Math.max(lowValue, Math.round(top * (rgb.r / 255)))
    low.right[index] = low.peakRight[index] = Math.max(
      Math.round(bottom * lowRatio),
      Math.round(bottom * (rgb.r / 255))
    )
    mid.left[index] = mid.peakLeft[index] = Math.max(midValue, Math.round(top * (rgb.g / 255)))
    mid.right[index] = mid.peakRight[index] = Math.max(
      Math.round(bottom * midRatio),
      Math.round(bottom * (rgb.g / 255))
    )
    high.left[index] = high.peakLeft[index] = Math.max(highValue, Math.round(top * (rgb.b / 255)))
    high.right[index] = high.peakRight[index] = Math.max(
      Math.round(bottom * highRatio),
      Math.round(bottom * (rgb.b / 255))
    )
  }

  return {
    duration: data.duration,
    sampleRate: data.sampleRate,
    step: data.sampleRate / Math.max(1, data.overviewRate || COMPACT_VISUAL_WAVEFORM_OVERVIEW_RATE),
    bands: { low, mid, high, all }
  }
}
