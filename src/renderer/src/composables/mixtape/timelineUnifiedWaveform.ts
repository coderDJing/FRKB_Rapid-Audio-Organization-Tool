import { drawCompactVisualWaveform } from '@renderer/components/compactVisualWaveformRenderer'
import type { CompactVisualWaveformData } from '@shared/compactVisualWaveform'
import type { UnifiedDisplayWaveformDetailData } from '@shared/unifiedDisplayWaveform'

type DrawUnifiedTimelineWaveformParams = {
  ctx: CanvasRenderingContext2D
  width: number
  height: number
  data: UnifiedDisplayWaveformDetailData
  startTime: number
  endTime: number
  isHalf: boolean
}

const MIXTAPE_EQ_UNIFIED_WAVEFORM_GAIN = 1
const renderableCache = new WeakMap<UnifiedDisplayWaveformDetailData, CompactVisualWaveformData>()

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const readByte = (values: Uint8Array | undefined, index: number, fallback = 0) => {
  if (!values?.length) return fallback
  return values[clamp(Math.floor(index), 0, values.length - 1)] ?? fallback
}

const buildEditModeAlignedBody = (data: UnifiedDisplayWaveformDetailData): Uint8Array => {
  const frames = Math.max(0, data.height?.length || 0)
  const body = new Uint8Array(frames)
  const bodyRateDivisor = Math.max(1, Math.floor(Number(data.bodyRateDivisor) || 1))
  for (let index = 0; index < frames; index += 1) {
    const height = clamp((data.height[index] || 0) / 255, 0, 1)
    const attack = clamp((data.attack?.[index] || 0) / 255, 0, 1)
    const sourceBody = readByte(
      data.body,
      Math.floor(index / bodyRateDivisor),
      Math.round(height * 255)
    )
    const bodyAmp = clamp(sourceBody / 255, 0, 1)
    body[index] = Math.round(
      clamp(Math.max(bodyAmp * 0.86, height * 0.94, attack * 0.68), 0, 1) * 255
    )
  }
  return body
}

const toCompactVisualRenderable = (
  data: UnifiedDisplayWaveformDetailData
): CompactVisualWaveformData => {
  const cached = renderableCache.get(data)
  if (cached) return cached
  const renderable: CompactVisualWaveformData = {
    version: data.version,
    parameterVersion: data.parameterVersion,
    duration: data.duration,
    sampleRate: data.sampleRate,
    detailRate: data.detailRate,
    overviewRate: data.overviewRate,
    bodyRateDivisor: 1,
    colorRateDivisor: 1,
    detailPeakTop: data.height,
    detailPeakBottom: data.height,
    detailBody: buildEditModeAlignedBody(data),
    colorIndex: data.colorIndex,
    colorLow: data.colorLow,
    colorMid: data.colorMid,
    colorHigh: data.colorHigh,
    colorRed: data.colorRed,
    colorGreen: data.colorGreen,
    colorBlue: data.colorBlue,
    overviewTop: data.overviewHeight,
    overviewBottom: data.overviewHeight
  }
  renderableCache.set(data, renderable)
  return renderable
}

export const drawUnifiedTimelineWaveform = ({
  ctx,
  width,
  height,
  data,
  startTime,
  endTime,
  isHalf
}: DrawUnifiedTimelineWaveformParams) => {
  const rangeStartSec = Math.max(0, Number(startTime) || 0)
  const rangeEndSec = Math.max(rangeStartSec, Number(endTime) || rangeStartSec)
  return drawCompactVisualWaveform(ctx, {
    width,
    height,
    data: toCompactVisualRenderable(data),
    rangeStartSec,
    rangeDurationSec: Math.max(0.0001, rangeEndSec - rangeStartSec),
    waveformLayout: isHalf ? 'top-half' : 'full',
    waveformGain: MIXTAPE_EQ_UNIFIED_WAVEFORM_GAIN,
    showDetailHighlights: false,
    showCenterLine: false
  })
}
