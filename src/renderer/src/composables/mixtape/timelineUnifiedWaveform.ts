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

const MIXTAPE_EQ_UNIFIED_WAVEFORM_GAIN = 0.86

const toCompactVisualRenderable = (
  data: UnifiedDisplayWaveformDetailData
): CompactVisualWaveformData => ({
  version: data.version,
  parameterVersion: data.parameterVersion,
  duration: data.duration,
  sampleRate: data.sampleRate,
  detailRate: data.detailRate,
  overviewRate: data.overviewRate,
  bodyRateDivisor: data.bodyRateDivisor,
  colorRateDivisor: 1,
  detailPeakTop: data.height,
  detailPeakBottom: data.height,
  detailBody: data.body,
  colorIndex: data.colorIndex,
  colorLow: data.colorLow,
  colorMid: data.colorMid,
  colorHigh: data.colorHigh,
  colorRed: data.colorRed,
  colorGreen: data.colorGreen,
  colorBlue: data.colorBlue,
  overviewTop: data.overviewHeight,
  overviewBottom: data.overviewHeight
})

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
