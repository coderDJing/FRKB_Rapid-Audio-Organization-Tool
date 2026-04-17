import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import type { WaveformStyle } from './webAudioPlayer'

type DrawRawWaveformParams = {
  waveformData: RawWaveformData
  width: number
  height: number
  style: WaveformStyle
  useHalfWaveform: boolean
  baseCanvas: HTMLCanvasElement
  progressCanvas: HTMLCanvasElement
  baseCtx: CanvasRenderingContext2D
  progressCtx: CanvasRenderingContext2D
  pixelRatio: number
  barWidth: number
  barGap: number
  resizeCanvas: (
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    pixelRatio: number
  ) => void
}

type RawColumnMetric = {
  min: number
  max: number
}

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const resolveLoadedFrames = (waveformData: RawWaveformData) => {
  const totalFrames = Math.max(0, Math.floor(Number(waveformData.frames) || 0))
  const loadedFrames = Math.max(0, Math.floor(Number(waveformData.loadedFrames) || 0))
  if (!loadedFrames) return totalFrames
  return Math.min(totalFrames, loadedFrames)
}

const computeRawColumnMetrics = (
  columnCount: number,
  waveformData: RawWaveformData
): Array<RawColumnMetric | null> => {
  const totalFrames = Math.max(1, Math.floor(Number(waveformData.frames) || 0))
  const loadedFrames = resolveLoadedFrames(waveformData)
  if (!loadedFrames || columnCount <= 0) return []

  const columns = new Array<RawColumnMetric | null>(columnCount)
  const framesPerColumn = totalFrames / columnCount

  for (let index = 0; index < columnCount; index++) {
    const start = Math.floor(index * framesPerColumn)
    const end = Math.min(
      totalFrames,
      Math.max(start + 1, Math.floor((index + 1) * framesPerColumn))
    )
    if (start >= loadedFrames) {
      columns[index] = null
      continue
    }

    const effectiveEnd = Math.min(end, loadedFrames)
    let peakMin = 0
    let peakMax = 0

    for (let frame = start; frame < effectiveEnd; frame++) {
      const leftAmplitude = Math.max(
        Math.abs(waveformData.minLeft[frame] || 0),
        Math.abs(waveformData.maxLeft[frame] || 0)
      )
      const rightAmplitude = Math.max(
        Math.abs(waveformData.minRight[frame] || 0),
        Math.abs(waveformData.maxRight[frame] || 0)
      )
      peakMin = Math.min(peakMin, -Math.min(1, rightAmplitude))
      peakMax = Math.max(peakMax, Math.min(1, leftAmplitude))
    }

    columns[index] = { min: peakMin, max: peakMax }
  }

  return columns
}

export const drawBufferedRawWaveform = ({
  waveformData,
  width,
  height,
  style,
  useHalfWaveform,
  baseCanvas,
  progressCanvas,
  baseCtx,
  progressCtx,
  pixelRatio,
  barWidth,
  barGap,
  resizeCanvas
}: DrawRawWaveformParams) => {
  resizeCanvas(baseCanvas, baseCtx, width, height, pixelRatio)
  resizeCanvas(progressCanvas, progressCtx, width, height, pixelRatio)

  const targetColumnCount =
    style === 'Fine'
      ? Math.max(1, Math.floor(width))
      : Math.max(1, Math.floor(width / (barWidth + barGap)))
  const columns = computeRawColumnMetrics(targetColumnCount, waveformData)
  if (!columns.length) return

  const spacing = width / targetColumnCount
  const gap = style === 'Fine' ? Math.min(barGap, spacing * 0.25) : Math.min(barGap, spacing * 0.4)
  const drawWidth = clampNumber(
    style === 'Fine'
      ? Math.max(1, spacing - gap)
      : Math.max(0.2, Math.min(barWidth, spacing - gap)),
    0.2,
    Math.max(1, spacing)
  )
  const offset = spacing > drawWidth ? (spacing - drawWidth) / 2 : 0
  const midY = height / 2
  const baselineY = useHalfWaveform ? height : midY
  const scaleY = useHalfWaveform ? baselineY * 0.98 : midY * 0.96

  baseCtx.fillStyle = '#cccccc'
  progressCtx.fillStyle = '#0078d4'

  for (let index = 0; index < columns.length; index++) {
    const metric = columns[index]
    if (!metric) continue
    const x = Math.max(0, Math.min(width - drawWidth, index * spacing + offset))

    if (useHalfWaveform) {
      const amplitude = Math.max(Math.abs(metric.min), Math.abs(metric.max))
      const rectHeight = Math.max(1, amplitude * scaleY)
      const y = baselineY - rectHeight
      baseCtx.fillRect(x, y, drawWidth, rectHeight)
      progressCtx.fillRect(x, y, drawWidth, rectHeight)
      continue
    }

    const barMin = midY + metric.min * scaleY
    const barMax = midY + metric.max * scaleY
    const rectHeight = Math.max(1, barMax - barMin)
    baseCtx.fillRect(x, barMin, drawWidth, rectHeight)
    progressCtx.fillRect(x, barMin, drawWidth, rectHeight)
  }
}
