import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'

type DrawWaveformOptions = {
  width: number
  height: number
  bpm: number
  firstBeatMs: number
  barBeatOffset?: number
  rangeStartSec: number
  rangeDurationSec: number
  mixxxData: MixxxWaveformData | null
  rawData?: RawWaveformData | null
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
const BAR_BEAT_INTERVAL = 32
const BEAT4_INTERVAL = 4
const BAR_LINE_COLOR = 'rgba(0, 110, 220, 0.98)'
const RAW_FFT_MIN_SIZE = 128
const RAW_FFT_MAX_SIZE = 512
const RAW_FFT_LOW_RATIO = 0.18
const RAW_FFT_MID_RATIO = 0.62
const RAW_FFT_ENERGY_EPSILON = 1e-9
const MIXXX_RGB_COMPONENTS = {
  low: { r: 1, g: 0, b: 0 },
  mid: { r: 0, g: 1, b: 0 },
  high: { r: 0, g: 0, b: 1 }
}

type RawFftScratch = {
  real: Float64Array
  imag: Float64Array
  hann: Float64Array
  bitRev: Uint32Array
  cosTable: Float64Array
  sinTable: Float64Array
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const toColorChannel = (value: number) => clamp(Math.round(value), 0, 255)
const normalizeBeatOffset = (value: number, interval: number) => {
  const safeInterval = Math.max(1, Math.floor(Number(interval) || 1))
  const numeric = Number(value)
  const rounded = Number.isFinite(numeric) ? Math.round(numeric) : 0
  return ((rounded % safeInterval) + safeInterval) % safeInterval
}

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
  barBeatOffset: number,
  rangeStartSec: number,
  rangeDurationSec: number
) => {
  if (!Number.isFinite(bpm) || bpm <= 0 || rangeDurationSec <= 0) return
  const beatSec = 60 / bpm
  if (!Number.isFinite(beatSec) || beatSec <= 0) return

  const firstBeatSec = (Number(firstBeatMs) || 0) / 1000
  const normalizedBarOffset = normalizeBeatOffset(barBeatOffset, BAR_BEAT_INTERVAL)
  const rangeEndSec = rangeStartSec + rangeDurationSec
  const startIndex = Math.floor((rangeStartSec - firstBeatSec) / beatSec) - 2
  const endIndex = Math.ceil((rangeEndSec - firstBeatSec) / beatSec) + 2

  for (let i = startIndex; i <= endIndex; i += 1) {
    const beatTime = firstBeatSec + i * beatSec
    if (beatTime < 0) continue
    if (beatTime < rangeStartSec - beatSec || beatTime > rangeEndSec + beatSec) continue
    const x = Math.round(((beatTime - rangeStartSec) / rangeDurationSec) * width)
    const shiftedIndex = i - normalizedBarOffset
    const modBar = ((shiftedIndex % BAR_BEAT_INTERVAL) + BAR_BEAT_INTERVAL) % BAR_BEAT_INTERVAL
    const mod4 = ((shiftedIndex % BEAT4_INTERVAL) + BEAT4_INTERVAL) % BEAT4_INTERVAL
    if (modBar === 0) {
      ctx.fillStyle = BAR_LINE_COLOR
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

const isValidRawWaveformData = (data: RawWaveformData | null): data is RawWaveformData => {
  if (!data) return false
  const frames = Math.max(
    0,
    Math.min(
      Number(data.frames) || Number.POSITIVE_INFINITY,
      data.minLeft.length,
      data.maxLeft.length,
      data.minRight.length,
      data.maxRight.length
    )
  )
  if (!Number.isFinite(data.rate) || data.rate <= 0) return false
  if (!Number.isFinite(data.duration) || data.duration <= 0) return false
  return frames > 0
}

const rawFftScratchCache = new Map<number, RawFftScratch>()

const nextPowerOfTwo = (value: number) => {
  let target = Math.max(2, Math.floor(value))
  target -= 1
  target |= target >> 1
  target |= target >> 2
  target |= target >> 4
  target |= target >> 8
  target |= target >> 16
  target += 1
  return target
}

const resolveRawFftSize = (span: number, maxSamplesPerPixel?: number) => {
  const sampleCap = Number(maxSamplesPerPixel)
  const preferredSpan =
    Number.isFinite(sampleCap) && sampleCap > 0
      ? Math.max(span, Math.floor(sampleCap) * 2)
      : Math.max(span, RAW_FFT_MIN_SIZE)
  const safe = clamp(preferredSpan, RAW_FFT_MIN_SIZE, RAW_FFT_MAX_SIZE)
  return nextPowerOfTwo(safe)
}

const resolveBitReverseIndex = (value: number, bitCount: number) => {
  let source = value
  let reversed = 0
  for (let bit = 0; bit < bitCount; bit += 1) {
    reversed = (reversed << 1) | (source & 1)
    source >>= 1
  }
  return reversed
}

const createRawFftScratch = (size: number): RawFftScratch => {
  const safeSize = nextPowerOfTwo(Math.max(2, size))
  const half = safeSize >> 1
  const bitCount = Math.round(Math.log2(safeSize))
  const bitRev = new Uint32Array(safeSize)
  for (let i = 0; i < safeSize; i += 1) {
    bitRev[i] = resolveBitReverseIndex(i, bitCount)
  }
  const hann = new Float64Array(safeSize)
  if (safeSize === 1) {
    hann[0] = 1
  } else {
    for (let i = 0; i < safeSize; i += 1) {
      hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (safeSize - 1)))
    }
  }
  const cosTable = new Float64Array(half)
  const sinTable = new Float64Array(half)
  for (let i = 0; i < half; i += 1) {
    const angle = (-2 * Math.PI * i) / safeSize
    cosTable[i] = Math.cos(angle)
    sinTable[i] = Math.sin(angle)
  }
  return {
    real: new Float64Array(safeSize),
    imag: new Float64Array(safeSize),
    hann,
    bitRev,
    cosTable,
    sinTable
  }
}

const resolveRawFftScratch = (size: number) => {
  const safeSize = nextPowerOfTwo(Math.max(2, size))
  const cached = rawFftScratchCache.get(safeSize)
  if (cached) return cached
  const created = createRawFftScratch(safeSize)
  rawFftScratchCache.set(safeSize, created)
  return created
}

const resolveRawMonoSampleAtFrame = (rawData: RawWaveformData, frameIndex: number) => {
  if (frameIndex < 0 || frameIndex >= rawData.frames) return 0
  const left =
    ((Number(rawData.minLeft[frameIndex]) || 0) + (Number(rawData.maxLeft[frameIndex]) || 0)) * 0.5
  const right =
    ((Number(rawData.minRight[frameIndex]) || 0) + (Number(rawData.maxRight[frameIndex]) || 0)) *
    0.5
  return (left + right) * 0.5
}

const resolveRawPeaksByRange = (
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
  let peakLeft = 0
  let peakRight = 0
  let lastFrame = startFrame
  for (let frame = startFrame; frame <= endFrame; frame += step) {
    const minLeft = Math.abs(rawData.minLeft[frame] || 0)
    const maxLeft = Math.abs(rawData.maxLeft[frame] || 0)
    const minRight = Math.abs(rawData.minRight[frame] || 0)
    const maxRight = Math.abs(rawData.maxRight[frame] || 0)
    peakLeft = Math.max(peakLeft, minLeft, maxLeft)
    peakRight = Math.max(peakRight, minRight, maxRight)
    lastFrame = frame
  }
  if (lastFrame !== endFrame) {
    const minLeft = Math.abs(rawData.minLeft[endFrame] || 0)
    const maxLeft = Math.abs(rawData.maxLeft[endFrame] || 0)
    const minRight = Math.abs(rawData.minRight[endFrame] || 0)
    const maxRight = Math.abs(rawData.maxRight[endFrame] || 0)
    peakLeft = Math.max(peakLeft, minLeft, maxLeft)
    peakRight = Math.max(peakRight, minRight, maxRight)
  }
  return {
    ampTop: Math.max(0, Math.min(1, peakLeft)),
    ampBottom: Math.max(0, Math.min(1, peakRight))
  }
}

const resolveRawFftRgbColor = (
  rawData: RawWaveformData,
  startFrame: number,
  endFrame: number,
  maxSamplesPerPixel?: number
) => {
  const span = Math.max(1, endFrame - startFrame + 1)
  const fftSize = resolveRawFftSize(span, maxSamplesPerPixel)
  const scratch = resolveRawFftScratch(fftSize)
  const { real, imag, hann, bitRev, cosTable, sinTable } = scratch
  real.fill(0)
  imag.fill(0)

  const center = Math.floor((startFrame + endFrame) * 0.5)
  const half = fftSize >> 1
  for (let i = 0; i < fftSize; i += 1) {
    const frame = center - half + i
    const sample = resolveRawMonoSampleAtFrame(rawData, frame)
    const dest = bitRev[i]
    real[dest] = sample * hann[i]
  }

  for (let size = 2; size <= fftSize; size <<= 1) {
    const halfSize = size >> 1
    const tableStep = fftSize / size
    for (let offset = 0; offset < fftSize; offset += size) {
      for (let i = 0; i < halfSize; i += 1) {
        const tableIndex = i * tableStep
        const cos = cosTable[tableIndex]
        const sin = sinTable[tableIndex]
        const left = offset + i
        const right = left + halfSize
        const tr = real[right] * cos - imag[right] * sin
        const ti = real[right] * sin + imag[right] * cos
        const ur = real[left]
        const ui = imag[left]
        real[left] = ur + tr
        imag[left] = ui + ti
        real[right] = ur - tr
        imag[right] = ui - ti
      }
    }
  }

  const sampleRate = Math.max(1, Number(rawData.rate) || 1)
  const nyquist = sampleRate * 0.5
  const lowUpperHz = Math.max(80, nyquist * RAW_FFT_LOW_RATIO)
  const midUpperHz = Math.max(lowUpperHz + 60, nyquist * RAW_FFT_MID_RATIO)
  const binCount = fftSize >> 1
  let lowEnergy = 0
  let midEnergy = 0
  let highEnergy = 0
  for (let bin = 1; bin < binCount; bin += 1) {
    const frequency = (bin * sampleRate) / fftSize
    if (!Number.isFinite(frequency) || frequency <= 0) continue
    const magnitudeSq = real[bin] * real[bin] + imag[bin] * imag[bin]
    if (!Number.isFinite(magnitudeSq) || magnitudeSq <= 0) continue
    if (frequency <= lowUpperHz) {
      lowEnergy += magnitudeSq
    } else if (frequency <= midUpperHz) {
      midEnergy += magnitudeSq
    } else {
      highEnergy += magnitudeSq
    }
  }

  const totalEnergy = lowEnergy + midEnergy + highEnergy
  if (!Number.isFinite(totalEnergy) || totalEnergy <= RAW_FFT_ENERGY_EPSILON) return null
  const low = Math.sqrt(Math.max(0, lowEnergy))
  const mid = Math.sqrt(Math.max(0, midEnergy))
  const high = Math.sqrt(Math.max(0, highEnergy))
  const maxEnergy = Math.max(low, mid, high, RAW_FFT_ENERGY_EPSILON)
  return {
    r: toColorChannel((low / maxEnergy) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE),
    g: toColorChannel((mid / maxEnergy) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE),
    b: toColorChannel((high / maxEnergy) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE)
  }
}

const buildWaveformColumns = (
  width: number,
  mixxxData: MixxxWaveformData,
  rawData: RawWaveformData | null,
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
  const hasRaw = isValidRawWaveformData(rawData)
  const rawFrames = hasRaw ? Math.max(1, Math.floor(rawData.frames)) : 0
  const rawRate = hasRaw ? Number(rawData.rate) : 0

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

    if (hasRaw && rawData && rawFrames > 0 && rawRate > 0) {
      const rawDuration = Number(rawData.duration)
      const safeRawDuration =
        Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : duration
      const rawStartTime = clamp(startTime, 0, safeRawDuration)
      const rawEndTime = clamp(endTime, rawStartTime, safeRawDuration)
      if (rawEndTime <= rawStartTime) continue
      const rawStartFrame = clamp(Math.floor(rawStartTime * rawRate), 0, rawFrames - 1)
      const rawEndFrame = clamp(Math.ceil(rawEndTime * rawRate), rawStartFrame, rawFrames - 1)
      const color = resolveRawFftRgbColor(rawData, rawStartFrame, rawEndFrame, maxSamplesPerPixel)
      if (!color) continue
      const rawPeaks = resolveRawPeaksByRange(
        rawData,
        rawStartFrame,
        rawEndFrame,
        maxSamplesPerPixel
      )
      if (rawPeaks.ampTop <= 0 && rawPeaks.ampBottom <= 0) continue
      columns[x] = {
        ampTop: rawPeaks.ampTop,
        ampBottom: rawPeaks.ampBottom,
        color
      }
      continue
    }

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
    barBeatOffset,
    rangeStartSec,
    rangeDurationSec,
    mixxxData,
    rawData,
    showBackground,
    maxSamplesPerPixel,
    showDetailHighlights,
    showCenterLine
  } = options
  if (width <= 0 || height <= 0) return false

  if (showBackground !== false) {
    drawBackground(ctx, width, height)
  }
  drawBeatGrid(
    ctx,
    width,
    height,
    bpm,
    firstBeatMs,
    Number(barBeatOffset) || 0,
    rangeStartSec,
    rangeDurationSec
  )

  if (!isValidMixxxWaveformData(mixxxData)) return false
  const columns = buildWaveformColumns(
    width,
    mixxxData,
    rawData || null,
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
