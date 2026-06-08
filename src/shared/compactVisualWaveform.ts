import type { UnifiedDisplayWaveformDetailData } from './unifiedDisplayWaveform'

export const COMPACT_VISUAL_WAVEFORM_CACHE_VERSION = 1
export const COMPACT_VISUAL_WAVEFORM_PARAMETER_VERSION = 5
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

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export const compactVisualWaveformToPreviewData = (
  data: CompactVisualWaveformData
): CompactVisualWaveformPreviewData | null => {
  const detailFrames = Math.min(data.detailPeakTop?.length || 0, data.detailPeakBottom?.length || 0)
  const colorFrames = Math.min(
    data.colorIndex?.length || 0,
    data.colorLow?.length || 0,
    data.colorMid?.length || 0,
    data.colorHigh?.length || 0,
    data.colorRed?.length || 0,
    data.colorGreen?.length || 0,
    data.colorBlue?.length || 0
  )
  if (!detailFrames || !colorFrames || !data.duration || !data.sampleRate || !data.detailRate) {
    return null
  }
  return data
}

export const unifiedDisplayWaveformToCompactVisualOverviewData = (
  data: UnifiedDisplayWaveformDetailData
): CompactVisualWaveformPreviewData | null => {
  if (!data || !data.duration || !data.sampleRate) return null
  const sourceHeight = data.overviewHeight?.length ? data.overviewHeight : data.height
  const frames = sourceHeight?.length || 0
  if (!frames || !data.colorIndex?.length) return null

  const detailPeakTop = new Uint8Array(sourceHeight)
  const detailPeakBottom = new Uint8Array(sourceHeight)
  const detailBody = new Uint8Array(sourceHeight)
  const colorIndex = new Uint8Array(frames)
  const colorLow = new Uint8Array(frames)
  const colorMid = new Uint8Array(frames)
  const colorHigh = new Uint8Array(frames)
  const colorRed = new Uint8Array(frames)
  const colorGreen = new Uint8Array(frames)
  const colorBlue = new Uint8Array(frames)

  for (let index = 0; index < frames; index += 1) {
    const sourceColorFrame =
      frames <= 1 ? 0 : Math.floor((index / frames) * Math.max(1, data.colorIndex.length))
    const color = data.colorIndex[clamp(sourceColorFrame, 0, data.colorIndex.length - 1)] ?? 3
    const colorFrame = clamp(sourceColorFrame, 0, data.colorIndex.length - 1)
    colorIndex[index] = color
    colorLow[index] = data.colorLow[colorFrame] ?? 0
    colorMid[index] = data.colorMid[colorFrame] ?? 0
    colorHigh[index] = data.colorHigh[colorFrame] ?? 0
    colorRed[index] = data.colorRed[colorFrame] ?? 235
    colorGreen[index] = data.colorGreen[colorFrame] ?? 242
    colorBlue[index] = data.colorBlue[colorFrame] ?? 248
  }

  const overviewRate = Math.max(
    1,
    Number(data.overviewRate) || frames / Math.max(0.0001, data.duration)
  )

  return {
    version: COMPACT_VISUAL_WAVEFORM_CACHE_VERSION,
    parameterVersion: COMPACT_VISUAL_WAVEFORM_PARAMETER_VERSION,
    duration: data.duration,
    sampleRate: data.sampleRate,
    detailRate: overviewRate,
    overviewRate,
    bodyRateDivisor: 1,
    colorRateDivisor: 1,
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
    overviewTop: new Uint8Array(sourceHeight),
    overviewBottom: new Uint8Array(sourceHeight)
  }
}
