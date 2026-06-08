import { drawCompactVisualWaveform } from '@renderer/components/compactVisualWaveformRenderer'
import type { CompactVisualWaveformData } from '@shared/compactVisualWaveform'

type ResizeCanvas = (
  targetCanvas: HTMLCanvasElement,
  targetCtx: CanvasRenderingContext2D,
  width: number,
  height: number,
  pixelRatio: number
) => void

type DrawPlayerCompactVisualWaveformParams = {
  width: number
  height: number
  data: CompactVisualWaveformData
  useHalfWaveform: boolean
  baseCanvas: HTMLCanvasElement
  progressCanvas: HTMLCanvasElement
  baseCtx: CanvasRenderingContext2D
  progressCtx: CanvasRenderingContext2D
  pixelRatio: number
  resizeCanvas: ResizeCanvas
}

export const drawPlayerCompactVisualWaveform = ({
  width,
  height,
  data,
  useHalfWaveform,
  baseCanvas,
  progressCanvas,
  baseCtx,
  progressCtx,
  pixelRatio,
  resizeCanvas
}: DrawPlayerCompactVisualWaveformParams) => {
  resizeCanvas(baseCanvas, baseCtx, width, height, pixelRatio)
  resizeCanvas(progressCanvas, progressCtx, width, height, pixelRatio)

  const options = {
    width,
    height,
    data,
    rangeStartSec: 0,
    rangeDurationSec: Math.max(0.0001, Number(data.duration) || 0),
    showDetailHighlights: false,
    showCenterLine: false,
    waveformLayout: useHalfWaveform ? 'top-half' : 'full'
  } as const

  drawCompactVisualWaveform(baseCtx, options)
  drawCompactVisualWaveform(progressCtx, options)
}
