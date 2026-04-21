import type { IPioneerPreviewWaveformData } from 'src/types/globals'
import type {
  MixxxWaveformData,
  RGBWaveformBandKey,
  WaveformStyle
} from '@renderer/pages/modules/songPlayer/webAudioPlayer'

export type SongListWaveformCanvasContext =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D

type MinMaxSample = {
  min: number
  max: number
}

type MixxxColumnMetrics = {
  amplitudeLeft: number
  amplitudeRight: number
  color: { r: number; g: number; b: number }
  progressColor: { r: number; g: number; b: number }
}

export type SongListWaveformMinMaxCacheEntry = {
  source: MixxxWaveformData
  samples: MinMaxSample[]
}

export type SongListWaveformRgbMetricsCacheEntry = {
  source: MixxxWaveformData
  columnCount: number
  metrics: MixxxColumnMetrics[]
}

const WAVEFORM_STYLE_SOUND_CLOUD: WaveformStyle = 'SoundCloud'
const WAVEFORM_STYLE_FINE: WaveformStyle = 'Fine'
const WAVEFORM_STYLE_RGB: WaveformStyle = 'RGB'
const MIXXX_MAX_RGB_ENERGY = Math.sqrt(255 * 255 * 3)
const MIXXX_RGB_BRIGHTNESS_SCALE = 0.95
const MIXXX_RGB_PROGRESS_BRIGHTNESS_SCALE = 0.6
const MIXXX_RGB_COMPONENTS: Record<RGBWaveformBandKey, { r: number; g: number; b: number }> = {
  low: { r: 1, g: 0, b: 0 },
  mid: { r: 0, g: 1, b: 0 },
  high: { r: 0, g: 0, b: 1 }
}

const toColorChannel = (value: number) => Math.max(0, Math.min(255, Math.round(value)))
const clamp01 = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0)

export const normalizeSongListWaveformStyle = (
  style?: WaveformStyle | 'RekordboxMini' | 'Mixxx'
): WaveformStyle => {
  if (style === 'RekordboxMini' || style === 'Mixxx') return WAVEFORM_STYLE_RGB
  if (
    style === WAVEFORM_STYLE_RGB ||
    style === WAVEFORM_STYLE_FINE ||
    style === WAVEFORM_STYLE_SOUND_CLOUD
  ) {
    return style
  }
  return WAVEFORM_STYLE_RGB
}

const buildMinMaxDataFromMixxx = (waveformData: MixxxWaveformData): MinMaxSample[] => {
  const low = waveformData.bands.low
  const mid = waveformData.bands.mid
  const high = waveformData.bands.high
  const frameCount = Math.min(
    low.left.length,
    low.right.length,
    mid.left.length,
    mid.right.length,
    high.left.length,
    high.right.length
  )
  if (!frameCount) return []
  const data = new Array<MinMaxSample>(frameCount)
  for (let i = 0; i < frameCount; i++) {
    const lowLeft = low.peakLeft ? low.peakLeft[i] : low.left[i]
    const lowRight = low.peakRight ? low.peakRight[i] : low.right[i]
    const midLeft = mid.peakLeft ? mid.peakLeft[i] : mid.left[i]
    const midRight = mid.peakRight ? mid.peakRight[i] : mid.right[i]
    const highLeft = high.peakLeft ? high.peakLeft[i] : high.left[i]
    const highRight = high.peakRight ? high.peakRight[i] : high.right[i]
    const leftEnergy = Math.sqrt(lowLeft * lowLeft + midLeft * midLeft + highLeft * highLeft)
    const rightEnergy = Math.sqrt(lowRight * lowRight + midRight * midRight + highRight * highRight)
    const leftAmplitude = Math.min(1, leftEnergy / MIXXX_MAX_RGB_ENERGY)
    const rightAmplitude = Math.min(1, rightEnergy / MIXXX_MAX_RGB_ENERGY)
    data[i] = {
      min: -rightAmplitude,
      max: leftAmplitude
    }
  }
  return data
}

const getSongListWaveformMinMaxSamples = (
  filePath: string,
  data: MixxxWaveformData,
  minMaxCache: Map<string, SongListWaveformMinMaxCacheEntry>
): MinMaxSample[] => {
  const cached = minMaxCache.get(filePath)
  if (cached && cached.source === data) return cached.samples
  const samples = buildMinMaxDataFromMixxx(data)
  minMaxCache.set(filePath, { source: data, samples })
  return samples
}

const computeSongListMixxxColumnMetrics = (
  filePath: string,
  columnCount: number,
  waveformData: MixxxWaveformData | null,
  rgbMetricsCache: Map<string, SongListWaveformRgbMetricsCacheEntry>
): MixxxColumnMetrics[] => {
  if (!waveformData || columnCount <= 0) return []
  const cached = rgbMetricsCache.get(filePath)
  if (cached && cached.source === waveformData && cached.columnCount === columnCount) {
    return cached.metrics
  }
  const low = waveformData.bands.low
  const mid = waveformData.bands.mid
  const high = waveformData.bands.high
  const frameCount = Math.min(
    low.left.length,
    low.right.length,
    mid.left.length,
    mid.right.length,
    high.left.length,
    high.right.length
  )
  if (frameCount === 0) return []
  const columns: MixxxColumnMetrics[] = new Array(columnCount)
  const dataSize = frameCount * 2
  const gain = dataSize / Math.max(1, columnCount)
  const lastVisualFrame = frameCount - 1
  for (let x = 0; x < columnCount; x++) {
    const xSampleWidth = gain * x
    const xVisualSampleIndex = xSampleWidth
    const maxSamplingRange = gain / 2
    let visualFrameStart = Math.floor(xVisualSampleIndex / 2 - maxSamplingRange + 0.5)
    let visualFrameStop = Math.floor(xVisualSampleIndex / 2 + maxSamplingRange + 0.5)
    if (visualFrameStart < 0) visualFrameStart = 0
    if (visualFrameStop > lastVisualFrame) visualFrameStop = lastVisualFrame
    if (visualFrameStop < visualFrameStart) {
      visualFrameStop = visualFrameStart
    }
    let maxLow = 0
    let maxMid = 0
    let maxHigh = 0
    let maxAllLeft = 0
    let maxAllRight = 0
    for (let i = visualFrameStart; i <= visualFrameStop; i++) {
      const lowLeft = low.left[i]
      const lowRight = low.right[i]
      const midLeft = mid.left[i]
      const midRight = mid.right[i]
      const highLeft = high.left[i]
      const highRight = high.right[i]
      const lowLeftAmp = low.peakLeft ? low.peakLeft[i] : lowLeft
      const lowRightAmp = low.peakRight ? low.peakRight[i] : lowRight
      const midLeftAmp = mid.peakLeft ? mid.peakLeft[i] : midLeft
      const midRightAmp = mid.peakRight ? mid.peakRight[i] : midRight
      const highLeftAmp = high.peakLeft ? high.peakLeft[i] : highLeft
      const highRightAmp = high.peakRight ? high.peakRight[i] : highRight
      if (lowLeft > maxLow) maxLow = lowLeft
      if (lowRight > maxLow) maxLow = lowRight
      if (midLeft > maxMid) maxMid = midLeft
      if (midRight > maxMid) maxMid = midRight
      if (highLeft > maxHigh) maxHigh = highLeft
      if (highRight > maxHigh) maxHigh = highRight
      const allLeft = lowLeftAmp * lowLeftAmp + midLeftAmp * midLeftAmp + highLeftAmp * highLeftAmp
      const allRight =
        lowRightAmp * lowRightAmp + midRightAmp * midRightAmp + highRightAmp * highRightAmp
      if (allLeft > maxAllLeft) maxAllLeft = allLeft
      if (allRight > maxAllRight) maxAllRight = allRight
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
    const color =
      maxColor > 0
        ? {
            r: toColorChannel((red / maxColor) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE),
            g: toColorChannel((green / maxColor) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE),
            b: toColorChannel((blue / maxColor) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE)
          }
        : { r: 0, g: 0, b: 0 }
    const progressColor =
      maxColor > 0
        ? {
            r: toColorChannel((red / maxColor) * 255 * MIXXX_RGB_PROGRESS_BRIGHTNESS_SCALE),
            g: toColorChannel((green / maxColor) * 255 * MIXXX_RGB_PROGRESS_BRIGHTNESS_SCALE),
            b: toColorChannel((blue / maxColor) * 255 * MIXXX_RGB_PROGRESS_BRIGHTNESS_SCALE)
          }
        : { r: 0, g: 0, b: 0 }
    const amplitudeLeft = Math.min(1, Math.sqrt(maxAllLeft) / MIXXX_MAX_RGB_ENERGY)
    const amplitudeRight = Math.min(1, Math.sqrt(maxAllRight) / MIXXX_MAX_RGB_ENERGY)
    columns[x] = {
      amplitudeLeft,
      amplitudeRight,
      color,
      progressColor
    }
  }
  rgbMetricsCache.set(filePath, { source: waveformData, columnCount, metrics: columns })
  return columns
}

export const drawSongListPioneerPreviewWaveform = (
  ctx: SongListWaveformCanvasContext,
  width: number,
  height: number,
  waveformData: IPioneerPreviewWaveformData,
  playedPercent: number,
  progressColor: string
) => {
  const columns = Array.isArray(waveformData?.columns) ? waveformData.columns : []
  const maxHeight = Math.max(
    1,
    Number(waveformData?.maxHeight) ||
      columns.reduce((value, column) => Math.max(value, Number(column?.backHeight) || 0), 0)
  )
  if (!columns.length || width <= 0 || height <= 0 || maxHeight <= 0) return
  const columnCount = Math.max(1, Math.floor(width))
  const samplesPerColumn = columns.length / columnCount
  const spacing = width / columnCount
  const drawWidth = Math.max(1, spacing)
  const scaleY = height / maxHeight
  for (let index = 0; index < columnCount; index++) {
    const start = Math.floor(index * samplesPerColumn)
    const end = Math.min(
      columns.length,
      Math.max(start + 1, Math.floor((index + 1) * samplesPerColumn))
    )
    let selected = columns[start] || null
    for (let i = start; i < end; i++) {
      const candidate = columns[i]
      if (!candidate) continue
      if (!selected || (candidate.backHeight || 0) >= (selected.backHeight || 0)) {
        selected = candidate
      }
    }
    if (!selected) continue
    const backHeight = Math.max(0, Number(selected.backHeight) || 0)
    const frontHeight = Math.max(0, Number(selected.frontHeight) || 0)
    const x = Math.min(width - drawWidth, index * spacing)
    if (backHeight > 0) {
      const backPixelHeight = Math.max(1, backHeight * scaleY)
      ctx.fillStyle = `rgb(${selected.backColorR || 0}, ${selected.backColorG || 0}, ${selected.backColorB || 0})`
      ctx.fillRect(x, height - backPixelHeight, drawWidth, backPixelHeight)
    }
    if (frontHeight > 0) {
      const frontPixelHeight = Math.max(1, frontHeight * scaleY)
      ctx.fillStyle = `rgb(${selected.frontColorR || 0}, ${selected.frontColorG || 0}, ${selected.frontColorB || 0})`
      ctx.fillRect(x, height - frontPixelHeight, drawWidth, frontPixelHeight)
    }
  }
  const clampedPlayed = clamp01(playedPercent)
  if (clampedPlayed <= 0) return
  ctx.save()
  ctx.globalCompositeOperation = 'source-atop'
  ctx.globalAlpha = 0.32
  ctx.fillStyle = progressColor
  ctx.fillRect(0, 0, width * clampedPlayed, height)
  ctx.restore()
}

const drawSongListMinMaxWaveform = (
  ctx: SongListWaveformCanvasContext,
  width: number,
  height: number,
  samples: MinMaxSample[],
  style: WaveformStyle,
  isHalf: boolean,
  baseColor: string,
  progressColor: string,
  playedPercent: number
) => {
  if (!samples.length || width <= 0 || height <= 0) return
  const barWidth = style === WAVEFORM_STYLE_SOUND_CLOUD ? 2 : 1
  const gap = style === WAVEFORM_STYLE_SOUND_CLOUD ? 1 : 0
  const columnCount = Math.max(1, Math.floor(width / (barWidth + gap)))
  const totalBars = samples.length
  const samplesPerColumn = totalBars / columnCount
  const spacing = width / columnCount
  const drawWidth = Math.max(0.5, Math.min(barWidth, spacing))
  const offset = spacing > drawWidth ? (spacing - drawWidth) / 2 : 0
  const midY = height / 2
  const baselineY = isHalf ? height : midY
  const scaleY = isHalf ? baselineY : midY
  const rects: Array<{ x: number; y: number; width: number; height: number }> = []
  for (let index = 0; index < columnCount; index++) {
    const start = Math.floor(index * samplesPerColumn)
    const end = Math.min(totalBars, Math.max(start + 1, Math.floor((index + 1) * samplesPerColumn)))
    let peak = 0
    for (let i = start; i < end; i++) {
      const { min, max } = samples[i]
      const amplitude = Math.max(Math.abs(min), Math.abs(max))
      if (amplitude > peak) peak = amplitude
    }
    const amplitudePx = Math.max(1, peak * scaleY)
    const rectHeight = isHalf ? Math.max(1, amplitudePx) : Math.max(1, amplitudePx * 2)
    const y = isHalf ? baselineY - rectHeight : baselineY - amplitudePx
    const x = Math.max(0, Math.min(width - drawWidth, index * spacing + offset))
    rects.push({ x, y, width: drawWidth, height: rectHeight })
  }
  const paintRects = (fillStyle: string) => {
    ctx.fillStyle = fillStyle || '#999999'
    for (const rect of rects) {
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
    }
  }
  paintRects(baseColor)
  const clampedPlayed = clamp01(playedPercent)
  if (clampedPlayed > 0) {
    const playedWidth = width * clampedPlayed
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, playedWidth, height)
    ctx.clip()
    paintRects(progressColor)
    ctx.restore()
  }
}

const drawSongListRgbWaveform = (
  ctx: SongListWaveformCanvasContext,
  width: number,
  height: number,
  filePath: string,
  waveformData: MixxxWaveformData,
  isHalf: boolean,
  playedPercent: number,
  rgbMetricsCache: Map<string, SongListWaveformRgbMetricsCacheEntry>
) => {
  const columns = computeSongListMixxxColumnMetrics(
    filePath,
    Math.max(1, Math.floor(width)),
    waveformData,
    rgbMetricsCache
  )
  if (!columns.length) return
  const centerY = height / 2
  const maxAmplitude = isHalf ? height : centerY
  const playedColumns = Math.min(
    columns.length,
    Math.max(0, Math.floor(columns.length * playedPercent))
  )
  for (let x = 0; x < columns.length; x++) {
    const column = columns[x]
    const { r, g, b } = x < playedColumns ? column.progressColor : column.color
    if (!r && !g && !b) continue
    const amplitudeTop = Math.max(1, column.amplitudeLeft * maxAmplitude)
    const amplitudeBottom = Math.max(1, column.amplitudeRight * maxAmplitude)
    const rectHeight = isHalf
      ? Math.max(amplitudeTop, amplitudeBottom)
      : amplitudeTop + amplitudeBottom
    const yTop = isHalf ? height - rectHeight : centerY - amplitudeTop
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`
    ctx.fillRect(x, yTop, 1, rectHeight)
  }
}

export const drawSongListMixxxWaveform = (
  ctx: SongListWaveformCanvasContext,
  width: number,
  height: number,
  filePath: string,
  waveformData: MixxxWaveformData,
  options: {
    waveformStyle?: WaveformStyle | 'RekordboxMini' | 'Mixxx'
    isHalf: boolean
    baseColor: string
    progressColor: string
    playedPercent: number
    minMaxCache: Map<string, SongListWaveformMinMaxCacheEntry>
    rgbMetricsCache: Map<string, SongListWaveformRgbMetricsCacheEntry>
  }
) => {
  const style = normalizeSongListWaveformStyle(options.waveformStyle)
  if (style === WAVEFORM_STYLE_RGB) {
    drawSongListRgbWaveform(
      ctx,
      width,
      height,
      filePath,
      waveformData,
      options.isHalf,
      options.playedPercent,
      options.rgbMetricsCache
    )
    return
  }
  const samples = getSongListWaveformMinMaxSamples(filePath, waveformData, options.minMaxCache)
  drawSongListMinMaxWaveform(
    ctx,
    width,
    height,
    samples,
    style,
    options.isHalf,
    options.baseColor,
    options.progressColor,
    options.playedPercent
  )
}
