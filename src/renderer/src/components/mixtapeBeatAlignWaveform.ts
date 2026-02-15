import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'

type DrawWaveformOptions = {
  width: number
  height: number
  bpm: number
  firstBeatMs: number
  rangeStartSec: number
  rangeDurationSec: number
  mixxxData: MixxxWaveformData | null
  showBackground?: boolean
  maxSamplesPerPixel?: number
  showDetailHighlights?: boolean
  showCenterLine?: boolean
}

type WaveformColumn = {
  ampTop: number
  ampBottom: number
  color: {
    r: number
    g: number
    b: number
  }
}

const MIXXX_MAX_RGB_ENERGY = Math.sqrt(255 * 255 * 3)
const MIXXX_RGB_BRIGHTNESS_SCALE = 0.95
const MIXXX_RGB_COMPONENTS = {
  low: { r: 1, g: 0, b: 0 },
  mid: { r: 0, g: 1, b: 0 },
  high: { r: 0, g: 0, b: 1 }
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const toColorChannel = (value: number) => clamp(Math.round(value), 0, 255)

const drawBackground = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
  const gradient = ctx.createLinearGradient(0, 0, 0, height)
  gradient.addColorStop(0, '#0f1b2e')
  gradient.addColorStop(1, '#0a1322')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)

  ctx.fillStyle = 'rgba(255, 255, 255, 0.03)'
  for (let y = 0; y < height; y += 4) {
    ctx.fillRect(0, y, width, 1)
  }
}

const drawBeatGrid = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  bpm: number,
  firstBeatMs: number,
  rangeStartSec: number,
  rangeDurationSec: number
) => {
  if (!Number.isFinite(bpm) || bpm <= 0 || rangeDurationSec <= 0) return
  const beatSec = 60 / bpm
  if (!Number.isFinite(beatSec) || beatSec <= 0) return

  const firstBeatSec = (Number(firstBeatMs) || 0) / 1000
  const rangeEndSec = rangeStartSec + rangeDurationSec
  const startIndex = Math.floor((rangeStartSec - firstBeatSec) / beatSec) - 2
  const endIndex = Math.ceil((rangeEndSec - firstBeatSec) / beatSec) + 2

  for (let i = startIndex; i <= endIndex; i += 1) {
    const beatTime = firstBeatSec + i * beatSec
    if (beatTime < 0) continue
    if (beatTime < rangeStartSec - beatSec || beatTime > rangeEndSec + beatSec) continue
    const x = Math.round(((beatTime - rangeStartSec) / rangeDurationSec) * width)
    const mod16 = ((i % 16) + 16) % 16
    const mod4 = ((i % 4) + 4) % 4
    if (mod16 === 0) {
      ctx.fillStyle = 'rgba(145, 205, 255, 0.56)'
      ctx.fillRect(x, 0, 2, height)
      continue
    }
    if (mod4 === 0) {
      ctx.fillStyle = 'rgba(184, 220, 255, 0.34)'
      ctx.fillRect(x, 0, 1, height)
      continue
    }
    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)'
    ctx.fillRect(x, 0, 1, height)
  }
}

const isValidMixxxWaveformData = (data: MixxxWaveformData | null): data is MixxxWaveformData => {
  if (!data) return false
  const low = data.bands?.low
  const mid = data.bands?.mid
  const high = data.bands?.high
  const all = data.bands?.all
  if (!low || !mid || !high || !all) return false
  const frameCount = Math.min(
    low.left.length,
    low.right.length,
    mid.left.length,
    mid.right.length,
    high.left.length,
    high.right.length,
    all.left.length,
    all.right.length
  )
  return frameCount > 0
}

const buildWaveformColumns = (
  width: number,
  mixxxData: MixxxWaveformData,
  rangeStartSec: number,
  rangeDurationSec: number,
  maxSamplesPerPixel?: number
): WaveformColumn[] => {
  const low = mixxxData.bands.low
  const mid = mixxxData.bands.mid
  const high = mixxxData.bands.high
  const frameCount = Math.min(
    low.left.length,
    low.right.length,
    mid.left.length,
    mid.right.length,
    high.left.length,
    high.right.length
  )
  if (!frameCount || width <= 0 || rangeDurationSec <= 0) return []

  const duration = Number(mixxxData.duration)
  if (!Number.isFinite(duration) || duration <= 0) return []

  const columns: WaveformColumn[] = new Array(width)

  for (let x = 0; x < width; x += 1) {
    const startTime = rangeStartSec + (x / width) * rangeDurationSec
    const endTime = rangeStartSec + ((x + 1) / width) * rangeDurationSec
    if (endTime <= 0 || startTime >= duration) continue
    const clampedStartTime = clamp(startTime, 0, duration)
    const clampedEndTime = clamp(endTime, clampedStartTime, duration)
    if (clampedEndTime <= clampedStartTime) continue
    const startFrame = clamp(
      Math.floor((clampedStartTime / duration) * frameCount),
      0,
      frameCount - 1
    )
    const endFrame = clamp(
      Math.ceil((clampedEndTime / duration) * frameCount),
      startFrame,
      frameCount - 1
    )

    let maxLow = 0
    let maxMid = 0
    let maxHigh = 0
    let maxAllTop = 0
    let maxAllBottom = 0

    const span = endFrame - startFrame + 1
    const sampleCap = Number(maxSamplesPerPixel)
    const step =
      Number.isFinite(sampleCap) && sampleCap > 0
        ? Math.max(1, Math.floor(span / Math.max(1, Math.floor(sampleCap))))
        : 1

    const applyFrame = (i: number) => {
      const lowTop = low.left[i]
      const lowBottom = low.right[i]
      const midTop = mid.left[i]
      const midBottom = mid.right[i]
      const highTop = high.left[i]
      const highBottom = high.right[i]

      if (lowTop > maxLow) maxLow = lowTop
      if (lowBottom > maxLow) maxLow = lowBottom
      if (midTop > maxMid) maxMid = midTop
      if (midBottom > maxMid) maxMid = midBottom
      if (highTop > maxHigh) maxHigh = highTop
      if (highBottom > maxHigh) maxHigh = highBottom

      const lowTopPeak = low.peakLeft ? low.peakLeft[i] : lowTop
      const lowBottomPeak = low.peakRight ? low.peakRight[i] : lowBottom
      const midTopPeak = mid.peakLeft ? mid.peakLeft[i] : midTop
      const midBottomPeak = mid.peakRight ? mid.peakRight[i] : midBottom
      const highTopPeak = high.peakLeft ? high.peakLeft[i] : highTop
      const highBottomPeak = high.peakRight ? high.peakRight[i] : highBottom

      const allTop = lowTopPeak * lowTopPeak + midTopPeak * midTopPeak + highTopPeak * highTopPeak
      const allBottom =
        lowBottomPeak * lowBottomPeak +
        midBottomPeak * midBottomPeak +
        highBottomPeak * highBottomPeak
      if (allTop > maxAllTop) maxAllTop = allTop
      if (allBottom > maxAllBottom) maxAllBottom = allBottom
    }
    let lastFrame = startFrame
    for (let i = startFrame; i <= endFrame; i += step) {
      applyFrame(i)
      lastFrame = i
    }
    if (lastFrame !== endFrame) {
      applyFrame(endFrame)
    }

    const red =
      maxLow * MIXXX_RGB_COMPONENTS.low.r +
      maxMid * MIXXX_RGB_COMPONENTS.mid.r +
      maxHigh * MIXXX_RGB_COMPONENTS.high.r
    const green =
      maxLow * MIXXX_RGB_COMPONENTS.low.g +
      maxMid * MIXXX_RGB_COMPONENTS.mid.g +
      maxHigh * MIXXX_RGB_COMPONENTS.high.g
    const blue =
      maxLow * MIXXX_RGB_COMPONENTS.low.b +
      maxMid * MIXXX_RGB_COMPONENTS.mid.b +
      maxHigh * MIXXX_RGB_COMPONENTS.high.b
    const maxColor = Math.max(red, green, blue)
    if (maxColor <= 0) continue

    const ampTop = Math.min(1, Math.sqrt(maxAllTop) / MIXXX_MAX_RGB_ENERGY)
    const ampBottom = Math.min(1, Math.sqrt(maxAllBottom) / MIXXX_MAX_RGB_ENERGY)
    if (ampTop <= 0 && ampBottom <= 0) continue

    columns[x] = {
      ampTop,
      ampBottom,
      color: {
        r: toColorChannel((red / maxColor) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE),
        g: toColorChannel((green / maxColor) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE),
        b: toColorChannel((blue / maxColor) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE)
      }
    }
  }

  return columns
}

const drawWaveformColumns = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  columns: WaveformColumn[],
  options?: {
    showDetailHighlights?: boolean
    showCenterLine?: boolean
  }
) => {
  const centerY = Math.round(height / 2)
  const ampScale = Math.max(1, centerY - 2)
  const showDetailHighlights = options?.showDetailHighlights !== false
  const showCenterLine = options?.showCenterLine !== false
  ctx.imageSmoothingEnabled = false

  for (let x = 0; x < width; x += 1) {
    const column = columns[x]
    if (!column) continue
    const { r, g, b } = column.color
    const topHeight = Math.max(1, Math.round(column.ampTop * ampScale))
    const bottomHeight = Math.max(1, Math.round(column.ampBottom * ampScale))
    const y = centerY - topHeight
    const h = topHeight + bottomHeight

    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`
    ctx.fillRect(x, y, 1, h)

    if (showDetailHighlights) {
      const topHighlight = Math.max(0, y)
      const bottomHighlight = Math.min(height - 1, y + h - 1)
      ctx.fillStyle = `rgba(255, 255, 255, ${0.14 + Math.max(column.ampTop, column.ampBottom) * 0.3})`
      ctx.fillRect(x, topHighlight, 1, 1)
      ctx.fillRect(x, bottomHighlight, 1, 1)
    }
  }

  if (showCenterLine) {
    ctx.fillStyle = 'rgba(210, 236, 255, 0.28)'
    ctx.fillRect(0, centerY, width, 1)
  }
}

export const drawBeatAlignRekordboxWaveform = (
  ctx: CanvasRenderingContext2D,
  options: DrawWaveformOptions
) => {
  const {
    width,
    height,
    bpm,
    firstBeatMs,
    rangeStartSec,
    rangeDurationSec,
    mixxxData,
    showBackground,
    maxSamplesPerPixel,
    showDetailHighlights,
    showCenterLine
  } = options
  if (width <= 0 || height <= 0) return false

  if (showBackground !== false) {
    drawBackground(ctx, width, height)
  }
  drawBeatGrid(ctx, width, height, bpm, firstBeatMs, rangeStartSec, rangeDurationSec)

  if (!isValidMixxxWaveformData(mixxxData)) return false
  const columns = buildWaveformColumns(
    width,
    mixxxData,
    rangeStartSec,
    rangeDurationSec,
    maxSamplesPerPixel
  )
  if (!columns.length) return false

  drawWaveformColumns(ctx, width, height, columns, {
    showDetailHighlights,
    showCenterLine
  })
  return true
}
