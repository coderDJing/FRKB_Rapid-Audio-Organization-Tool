import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import type { WaveformRgbColor } from '@renderer/components/beatGridRawWaveformShape'

export type RawCurveWaveformColumn = {
  color: WaveformRgbColor
}

export type RawCurveWaveformLayout = 'full' | 'top-half' | 'bottom-half'

export type RawCurveCanvasContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

type DrawRawCurveWaveformOptions = {
  ctx: RawCurveCanvasContext
  width: number
  height: number
  columns: Array<RawCurveWaveformColumn | null | undefined>
  rawData: RawWaveformData | null
  rangeStartSec: number
  rangeDurationSec: number
  maxSamplesPerPixel?: number
  timeBasisOffsetMs?: number
  waveformLayout: RawCurveWaveformLayout
  waveformGain: number
}

const RAW_CURVE_VERTICAL_SCALE = 0.82
const RAW_CURVE_FALLBACK_COLOR: WaveformRgbColor = { r: 235, g: 242, b: 248 }

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const isValidRawWaveformData = (data: RawWaveformData | null): data is RawWaveformData => {
  if (!data) return false
  const frames = Math.min(
    data.minLeft?.length || 0,
    data.maxLeft?.length || 0,
    data.minRight?.length || 0,
    data.maxRight?.length || 0
  )
  return frames > 0 && Number(data.rate) > 0
}

const resolveRawCurvePeaksByRange = (
  rawData: RawWaveformData,
  startFrame: number,
  endFrame: number,
  maxSamplesPerPixel?: number
) => {
  const span = endFrame - startFrame + 1
  const sampleCap = Number(maxSamplesPerPixel)
  const step =
    Number.isFinite(sampleCap) && sampleCap > 0
      ? Math.max(1, Math.floor(span / Math.max(1, Math.floor(sampleCap))))
      : 1
  let minPeak = 1
  let maxPeak = -1
  let lastFrame = startFrame
  const applyFrame = (frame: number) => {
    const minValue = ((rawData.minLeft[frame] || 0) + (rawData.minRight[frame] || 0)) * 0.5
    const maxValue = ((rawData.maxLeft[frame] || 0) + (rawData.maxRight[frame] || 0)) * 0.5
    if (minValue < minPeak) minPeak = minValue
    if (maxValue > maxPeak) maxPeak = maxValue
  }
  for (let frame = startFrame; frame <= endFrame; frame += step) {
    applyFrame(frame)
    lastFrame = frame
  }
  if (lastFrame !== endFrame) applyFrame(endFrame)
  return {
    min: clamp(minPeak === 1 ? 0 : minPeak, -1, 1),
    max: clamp(maxPeak === -1 ? 0 : maxPeak, -1, 1)
  }
}

const resolveRawCurveMeanByRange = (
  rawData: RawWaveformData,
  startFrame: number,
  endFrame: number,
  maxSamplesPerPixel?: number
) => {
  if (
    !rawData.meanLeft ||
    !rawData.meanRight ||
    rawData.meanLeft.length <= endFrame ||
    rawData.meanRight.length <= endFrame
  ) {
    return null
  }
  const span = endFrame - startFrame + 1
  const sampleCap = Number(maxSamplesPerPixel)
  const step =
    Number.isFinite(sampleCap) && sampleCap > 0
      ? Math.max(1, Math.floor(span / Math.max(1, Math.floor(sampleCap))))
      : 1
  let sum = 0
  let count = 0
  let lastFrame = startFrame
  const applyFrame = (frame: number) => {
    sum += ((rawData.meanLeft?.[frame] || 0) + (rawData.meanRight?.[frame] || 0)) * 0.5
    count += 1
  }
  for (let frame = startFrame; frame <= endFrame; frame += step) {
    applyFrame(frame)
    lastFrame = frame
  }
  if (lastFrame !== endFrame) applyFrame(endFrame)
  return clamp(count > 0 ? sum / count : 0, -1, 1)
}

const clipValueSegment = (
  startValue: number,
  endValue: number,
  minValue: number,
  maxValue: number
) => {
  const delta = endValue - startValue
  let startT = 0
  let endT = 1
  const clipLower = (limit: number) => {
    if (delta === 0) return startValue >= limit
    const t = (limit - startValue) / delta
    if (delta > 0) startT = Math.max(startT, t)
    else endT = Math.min(endT, t)
    return startT <= endT
  }
  const clipUpper = (limit: number) => {
    if (delta === 0) return startValue <= limit
    const t = (limit - startValue) / delta
    if (delta > 0) endT = Math.min(endT, t)
    else startT = Math.max(startT, t)
    return startT <= endT
  }
  if (!clipLower(minValue) || !clipUpper(maxValue)) return null
  return {
    startT,
    endT,
    startValue: startValue + delta * startT,
    endValue: startValue + delta * endT
  }
}

const resolveYFactory = (height: number, waveformLayout: RawCurveWaveformLayout) => {
  const centerY = height * 0.5
  const fullScale = Math.max(1, centerY - 1)
  const halfScale = Math.max(1, height - 2)
  return (value: number) => {
    const safeValue = clamp(value, -1, 1) * RAW_CURVE_VERTICAL_SCALE
    if (waveformLayout === 'top-half') return height - 1 - clamp(safeValue, 0, 1) * halfScale
    if (waveformLayout === 'bottom-half') return 1 + clamp(-safeValue, 0, 1) * halfScale
    return centerY - safeValue * fullScale
  }
}

const drawMeanSegment = (
  ctx: RawCurveCanvasContext,
  layout: RawCurveWaveformLayout,
  resolveY: (value: number) => number,
  previousX: number,
  previousValue: number,
  nextX: number,
  nextValue: number
) => {
  if (layout === 'full') {
    ctx.moveTo(previousX, resolveY(previousValue))
    ctx.lineTo(nextX, resolveY(nextValue))
    return true
  }
  const clipped = clipValueSegment(
    previousValue,
    nextValue,
    layout === 'top-half' ? 0 : -1,
    layout === 'top-half' ? 1 : 0
  )
  if (!clipped) return false
  const deltaX = nextX - previousX
  ctx.moveTo(previousX + deltaX * clipped.startT, resolveY(clipped.startValue))
  ctx.lineTo(previousX + deltaX * clipped.endT, resolveY(clipped.endValue))
  return true
}

export const drawRawCurveWaveform = (options: DrawRawCurveWaveformOptions) => {
  const {
    ctx,
    width,
    height,
    columns,
    rawData,
    rangeStartSec,
    rangeDurationSec,
    maxSamplesPerPixel,
    timeBasisOffsetMs,
    waveformLayout,
    waveformGain
  } = options
  if (!isValidRawWaveformData(rawData) || rangeDurationSec <= 0) return false
  const rawFrames = Math.max(
    1,
    Math.min(
      Math.floor(Number(rawData.loadedFrames ?? rawData.frames) || 0),
      Math.floor(Number(rawData.frames) || 0)
    )
  )
  const rawRate = Math.max(1, Number(rawData.rate) || 1)
  const rawStartSec =
    Math.max(0, Number(rawData.startSec) || 0) + Math.max(0, Number(timeBasisOffsetMs) || 0) / 1000
  const rawEndSec = rawStartSec + rawFrames / rawRate
  const visibleStartSec = Math.max(rangeStartSec, rawStartSec)
  const visibleEndSec = Math.min(rangeStartSec + rangeDurationSec, rawEndSec)
  if (visibleEndSec <= visibleStartSec) return false

  const resolveY = resolveYFactory(height, waveformLayout)
  ctx.imageSmoothingEnabled = true
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 1.35

  let hasDrawn = false
  let previousMeanX = 0
  let previousMeanValue = 0
  let hasPreviousMean = false
  for (let x = 0; x < width; x += 1) {
    const startTime = rangeStartSec + (x / width) * rangeDurationSec
    const endTime = rangeStartSec + ((x + 1) / width) * rangeDurationSec
    if (endTime <= rawStartSec || startTime >= rawEndSec) continue
    const localStart = clamp(startTime - rawStartSec, 0, rawEndSec - rawStartSec)
    const localEnd = clamp(endTime - rawStartSec, localStart, rawEndSec - rawStartSec)
    const startFrame = clamp(Math.floor(localStart * rawRate), 0, rawFrames - 1)
    const endFrame = clamp(Math.ceil(localEnd * rawRate), startFrame, rawFrames - 1)
    const color = columns[x]?.color || RAW_CURVE_FALLBACK_COLOR
    const meanValue = resolveRawCurveMeanByRange(rawData, startFrame, endFrame, maxSamplesPerPixel)
    ctx.strokeStyle = `rgb(${color.r}, ${color.g}, ${color.b})`
    ctx.beginPath()
    if (meanValue !== null) {
      const nextX = x + 0.5
      const nextValue = clamp(meanValue * waveformGain, -1, 1)
      const drawn =
        hasPreviousMean &&
        drawMeanSegment(
          ctx,
          waveformLayout,
          resolveY,
          previousMeanX,
          previousMeanValue,
          nextX,
          nextValue
        )
      previousMeanX = nextX
      previousMeanValue = nextValue
      hasPreviousMean = true
      if (!drawn) continue
    } else {
      const peaks = resolveRawCurvePeaksByRange(rawData, startFrame, endFrame, maxSamplesPerPixel)
      const firstY = resolveY(peaks.max * waveformGain)
      const secondY = resolveY(peaks.min * waveformGain)
      const firstX = x + 0.25
      const secondX = x + 0.75
      ctx.moveTo(firstX, firstY)
      ctx.lineTo(secondX, secondY)
      previousMeanX = secondX
      previousMeanValue = peaks.min
      hasPreviousMean = false
    }
    ctx.stroke()
    hasDrawn = true
  }
  return hasDrawn
}
