import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { isRawPlaceholderMixxxData } from '@renderer/components/beatGridWaveformData'
import {
  resolveRawEnergyAttackAmp,
  resolveRawEnergyProfileByRange,
  type RawEnergyShapeParams
} from '@renderer/components/beatGridRawWaveformEnvelope'
import { resolveRawFftBandProfile } from '@renderer/components/beatGridRawWaveformColor'
import {
  resolveRekordboxRgbHeightAmp,
  type WaveformFrequencyRatios,
  type WaveformRgbColor
} from '@renderer/components/beatGridRawWaveformShape'

type DrawWaveformOptions = {
  width: number
  height: number
  bpm: number
  firstBeatMs: number
  barBeatOffset?: number
  timeBasisOffsetMs?: number
  rangeStartSec: number
  rangeDurationSec: number
  mixxxData: MixxxWaveformData | null
  rawData?: RawWaveformData | null
  showBackground?: boolean
  maxSamplesPerPixel?: number
  showDetailHighlights?: boolean
  showCenterLine?: boolean
  showBeatGrid?: boolean
  waveformLayout?: 'full' | 'top-half' | 'bottom-half'
  waveformRenderStyle?: WaveformRenderStyle
  themeVariant?: 'light' | 'dark'
  preferRawPeaksOnly?: boolean
  smoothColumns?: boolean
  waveformGain?: number
}

type WaveformColumn = {
  ampTop: number
  ampBottom: number
  rawEnergyBase?: number
  rawEnergyPeak?: number
  rawEnergyShape?: RawEnergyShapeParams
  frequencyRatios?: WaveformFrequencyRatios
  color: WaveformRgbColor
}

type WaveformRenderStyle = 'columns' | 'raw-curve'
type WaveformLayout = 'full' | 'top-half' | 'bottom-half'

const MIXXX_MAX_RGB_ENERGY = Math.sqrt(255 * 255 * 3)
const MIXXX_RGB_BRIGHTNESS_SCALE = 0.95
const BAR_BEAT_INTERVAL = 32
const BEAT4_INTERVAL = 4
const BAR_GRID_LINE_WIDTH = 2.4
const MAJOR_GRID_LINE_WIDTH = 1.5
const MINOR_GRID_LINE_WIDTH = 1.15
const GRID_LINE_VERTICAL_OVERSCAN = 2
const HALF_WAVEFORM_AMPLITUDE_RATIO = 0.8
const REKORDBOX_RGB_DETAIL_RATE = 150
const COLUMN_DECAY_SMOOTH_PREV2_WEIGHT = 0.04
const COLUMN_DECAY_SMOOTH_PREV1_WEIGHT = 0.16
const COLUMN_DECAY_SMOOTH_CURRENT_WEIGHT = 0.8
const COLUMN_TAIL_RELEASE = 0.42
const COLUMN_ATTACK_MIN_AMP = 0.06
const COLUMN_ATTACK_MIN_RISE = 0.04
const COLUMN_ATTACK_RELATIVE_RISE = 0.65
const RAW_CURVE_VERTICAL_SCALE = 0.82
const RAW_PEAKS_ONLY_FALLBACK_COLOR: WaveformRgbColor = { r: 235, g: 242, b: 248 }
const MIXXX_RGB_COMPONENTS = {
  low: { r: 1, g: 0, b: 0 },
  mid: { r: 0, g: 1, b: 0 },
  high: { r: 0, g: 0, b: 1 }
}

type BeatAlignWaveformPalette = {
  backgroundStart: string
  backgroundEnd: string
  backgroundStripe: string
  barLine: string
  majorGrid: string
  minorGrid: string
  detailHighlightBase: string
  centerLine: string
}

type BeatAlignCanvasContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

const DARK_WAVEFORM_PALETTE: BeatAlignWaveformPalette = {
  backgroundStart: '#151515',
  backgroundEnd: '#1c1c1c',
  backgroundStripe: 'rgba(255, 255, 255, 0.03)',
  barLine: '#8fd6ff',
  majorGrid: '#ffdf94',
  minorGrid: '#ffffff',
  detailHighlightBase: '255, 255, 255',
  centerLine: 'rgba(210, 236, 255, 0.28)'
}

const LIGHT_WAVEFORM_PALETTE: BeatAlignWaveformPalette = {
  backgroundStart: '#d9dee6',
  backgroundEnd: '#cfd6df',
  backgroundStripe: 'rgba(15, 23, 42, 0.03)',
  barLine: '#003f96',
  majorGrid: '#7c4300',
  minorGrid: '#202b3a',
  detailHighlightBase: '15, 23, 42',
  centerLine: 'rgba(43, 102, 217, 0.18)'
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const toColorChannel = (value: number) => clamp(Math.round(value), 0, 255)
const normalizeWaveformGain = (value?: number) => {
  if (typeof value === 'undefined') return 1
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 1
  return clamp(numeric, 0, 16)
}
const resolveColumnEnergy = (column: WaveformColumn | null | undefined) =>
  column ? Math.max(column.ampTop, column.ampBottom) : 0

const isColumnAttack = (column: WaveformColumn | null, previousColumn: WaveformColumn | null) => {
  const energy = resolveColumnEnergy(column)
  if (energy < COLUMN_ATTACK_MIN_AMP) return false
  const previousEnergy = resolveColumnEnergy(previousColumn)
  const rise = energy - previousEnergy
  return rise >= Math.max(COLUMN_ATTACK_MIN_RISE, previousEnergy * COLUMN_ATTACK_RELATIVE_RISE)
}

const normalizeBeatOffset = (value: number, interval: number) => {
  const safeInterval = Math.max(1, Math.floor(Number(interval) || 1))
  const numeric = Number(value)
  const rounded = Number.isFinite(numeric) ? Math.round(numeric) : 0
  return ((rounded % safeInterval) + safeInterval) % safeInterval
}

const resolveWaveformPalette = (
  ctx: BeatAlignCanvasContext,
  themeVariant?: 'light' | 'dark'
): BeatAlignWaveformPalette => {
  if (themeVariant === 'light') return LIGHT_WAVEFORM_PALETTE
  if (themeVariant === 'dark') return DARK_WAVEFORM_PALETTE
  const canvas = ctx.canvas as HTMLCanvasElement | OffscreenCanvas | undefined
  const doc = canvas && 'ownerDocument' in canvas ? canvas.ownerDocument : null
  const htmlEl = doc?.documentElement
  const bodyEl = doc?.body
  const isLight =
    !!htmlEl?.classList.contains('theme-light') || !!bodyEl?.classList.contains('theme-light')
  return isLight ? LIGHT_WAVEFORM_PALETTE : DARK_WAVEFORM_PALETTE
}

const drawBackground = (
  ctx: BeatAlignCanvasContext,
  width: number,
  height: number,
  palette: BeatAlignWaveformPalette
) => {
  const gradient = ctx.createLinearGradient(0, 0, 0, height)
  gradient.addColorStop(0, palette.backgroundStart)
  gradient.addColorStop(1, palette.backgroundEnd)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)

  ctx.fillStyle = palette.backgroundStripe
  for (let y = 0; y < height; y += 4) {
    ctx.fillRect(0, y, width, 1)
  }
}

const drawBeatGrid = (
  ctx: BeatAlignCanvasContext,
  width: number,
  height: number,
  bpm: number,
  firstBeatMs: number,
  barBeatOffset: number,
  rangeStartSec: number,
  rangeDurationSec: number,
  palette: BeatAlignWaveformPalette
) => {
  if (!Number.isFinite(bpm) || bpm <= 0 || rangeDurationSec <= 0) return
  const beatSec = 60 / bpm
  if (!Number.isFinite(beatSec) || beatSec <= 0) return

  const drawVerticalLine = (x: number, lineWidth: number, color: string) => {
    const safeWidth = Math.max(1, lineWidth)
    const halfWidth = safeWidth * 0.5
    if (x < -halfWidth || x > width + halfWidth) return
    // 网格线必须跟着波形做连续位移，不能再把 x 强行 round 到整 CSS 像素。
    // 否则波形已经亚像素平滑滚动了，grid 还在 1px 台阶上跳，视觉上就像两层速度不一样。
    const rawLeft = x - halfWidth
    const rawRight = rawLeft + safeWidth
    const left = Math.max(0, rawLeft)
    const right = Math.min(width, rawRight)
    if (right <= left) return
    ctx.fillStyle = color
    ctx.fillRect(
      left,
      -GRID_LINE_VERTICAL_OVERSCAN,
      right - left,
      height + GRID_LINE_VERTICAL_OVERSCAN * 2
    )
  }

  const firstBeatSec = (Number(firstBeatMs) || 0) / 1000
  const normalizedBarOffset = normalizeBeatOffset(barBeatOffset, BAR_BEAT_INTERVAL)
  const rangeEndSec = rangeStartSec + rangeDurationSec
  const startIndex = Math.floor((rangeStartSec - firstBeatSec) / beatSec) - 2
  const endIndex = Math.ceil((rangeEndSec - firstBeatSec) / beatSec) + 2

  for (let i = startIndex; i <= endIndex; i += 1) {
    const beatTime = firstBeatSec + i * beatSec
    if (beatTime < 0) continue
    if (beatTime < rangeStartSec - beatSec || beatTime > rangeEndSec + beatSec) continue
    const x = ((beatTime - rangeStartSec) / rangeDurationSec) * width
    const shiftedIndex = i - normalizedBarOffset
    const modBar = ((shiftedIndex % BAR_BEAT_INTERVAL) + BAR_BEAT_INTERVAL) % BAR_BEAT_INTERVAL
    const mod4 = ((shiftedIndex % BEAT4_INTERVAL) + BEAT4_INTERVAL) % BEAT4_INTERVAL
    if (modBar === 0) {
      drawVerticalLine(x, BAR_GRID_LINE_WIDTH, palette.barLine)
      continue
    }
    if (mod4 === 0) {
      drawVerticalLine(x, MAJOR_GRID_LINE_WIDTH, palette.majorGrid)
      continue
    }
    drawVerticalLine(x, MINOR_GRID_LINE_WIDTH, palette.minorGrid)
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

const resolveRawColumnByTimeRange = (
  rawData: RawWaveformData,
  rawFrames: number,
  rawRate: number,
  rawStartSec: number,
  startTime: number,
  endTime: number,
  maxSamplesPerPixel: number | undefined,
  preferRawPeaksOnly: boolean,
  useRawEnergyEnvelope: boolean,
  waveformGain: number
): WaveformColumn | null => {
  const rawDuration = rawFrames / rawRate
  const safeRawDuration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0
  const rawEndSec = rawStartSec + safeRawDuration
  if (!safeRawDuration || endTime <= rawStartSec || startTime >= rawEndSec) return null
  const rawLocalStartTime = clamp(startTime - rawStartSec, 0, safeRawDuration)
  const rawLocalEndTime = clamp(endTime - rawStartSec, rawLocalStartTime, safeRawDuration)
  if (rawLocalEndTime <= rawLocalStartTime) return null
  const rawStartFrame = clamp(Math.floor(rawLocalStartTime * rawRate), 0, rawFrames - 1)
  const rawEndFrame = clamp(Math.ceil(rawLocalEndTime * rawRate), rawStartFrame, rawFrames - 1)
  const rawEnergyProfile = useRawEnergyEnvelope
    ? resolveRawEnergyProfileByRange(
        rawData,
        rawStartFrame,
        rawEndFrame,
        maxSamplesPerPixel,
        waveformGain
      )
    : null
  const rawPeaks = rawEnergyProfile
    ? null
    : resolveRawPeaksByRange(rawData, rawStartFrame, rawEndFrame, maxSamplesPerPixel)
  const rawAmps = rawEnergyProfile || {
    ampTop: clamp((rawPeaks?.ampTop ?? 0) * waveformGain, 0, 1),
    ampBottom: clamp((rawPeaks?.ampBottom ?? 0) * waveformGain, 0, 1)
  }
  if (rawAmps.ampTop <= 0 && rawAmps.ampBottom <= 0) return null
  const rawColorUsesEnergyShape = preferRawPeaksOnly ? false : useRawEnergyEnvelope
  const rawFftProfile = resolveRawFftBandProfile(
    rawData,
    rawStartFrame,
    rawEndFrame,
    maxSamplesPerPixel,
    rawColorUsesEnergyShape
  )
  const color = rawFftProfile?.color ?? (preferRawPeaksOnly ? RAW_PEAKS_ONLY_FALLBACK_COLOR : null)
  if (!color) return null
  return {
    ampTop: rawAmps.ampTop,
    ampBottom: rawAmps.ampBottom,
    rawEnergyBase: rawEnergyProfile?.base,
    rawEnergyPeak: rawEnergyProfile?.peak,
    rawEnergyShape: rawEnergyProfile?.shape,
    frequencyRatios: rawFftProfile?.bands,
    color
  }
}

const buildWaveformColumns = (
  width: number,
  mixxxData: MixxxWaveformData,
  rawData: RawWaveformData | null,
  rangeStartSec: number,
  rangeDurationSec: number,
  maxSamplesPerPixel?: number,
  timeBasisOffsetMs?: number,
  preferRawPeaksOnly = false,
  smoothColumns = false,
  useRawEnergyEnvelope = false,
  waveformGain = 1
): WaveformColumn[] => {
  const low = mixxxData.bands.low
  const mid = mixxxData.bands.mid
  const high = mixxxData.bands.high
  const mixxxIsPlaceholder = isRawPlaceholderMixxxData(mixxxData)
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
  const rawFrames = hasRaw
    ? Math.max(
        1,
        Math.min(
          Math.floor(Number(rawData.loadedFrames ?? rawData.frames) || 0),
          Math.floor(Number(rawData.frames) || 0)
        )
      )
    : 0
  const rawRate = hasRaw ? Number(rawData.rate) : 0
  const timeBasisOffsetSec = Math.max(0, Number(timeBasisOffsetMs) || 0) / 1000
  const rawStartSec = hasRaw ? Math.max(0, Number(rawData.startSec) || 0) + timeBasisOffsetSec : 0
  const rawColumnDurationSec = rangeDurationSec / Math.max(1, width)
  const safeWaveformGain = normalizeWaveformGain(waveformGain)
  const rawPeaksOnly = preferRawPeaksOnly === true
  const shouldSmoothRawColumns = smoothColumns && !rawPeaksOnly
  const shouldUseRawEnergyEnvelope = useRawEnergyEnvelope && !rawPeaksOnly
  const rawDetailColumnDurationSec = Math.max(rawColumnDurationSec, 1 / REKORDBOX_RGB_DETAIL_RATE)
  const rawTimelineColumnCache = new Map<number, WaveformColumn | null>()
  const resolveRawTimelineColumn = (timelineColumnIndex: number) => {
    if (!hasRaw || !rawData || rawFrames <= 0 || rawRate <= 0 || rawDetailColumnDurationSec <= 0) {
      return null
    }
    if (rawTimelineColumnCache.has(timelineColumnIndex)) {
      return rawTimelineColumnCache.get(timelineColumnIndex) ?? null
    }
    const startTime = timelineColumnIndex * rawDetailColumnDurationSec
    const column = resolveRawColumnByTimeRange(
      rawData,
      rawFrames,
      rawRate,
      rawStartSec,
      startTime,
      startTime + rawDetailColumnDurationSec,
      maxSamplesPerPixel,
      rawPeaksOnly,
      shouldUseRawEnergyEnvelope,
      safeWaveformGain
    )
    rawTimelineColumnCache.set(timelineColumnIndex, column)
    return column
  }
  const resolveSmoothedRawTimelineColumn = (timelineColumnIndex: number): WaveformColumn | null => {
    const currentColumn = resolveRawTimelineColumn(timelineColumnIndex)
    if (!currentColumn) return null
    const previousColumn = resolveRawTimelineColumn(timelineColumnIndex - 1)
    let shapedCurrentColumn = currentColumn
    if (shouldUseRawEnergyEnvelope) {
      const attackAmp = resolveRawEnergyAttackAmp(
        currentColumn.rawEnergyBase,
        currentColumn.rawEnergyPeak,
        previousColumn?.rawEnergyBase,
        currentColumn.rawEnergyShape
      )
      if (typeof attackAmp === 'number' && attackAmp > currentColumn.ampTop) {
        shapedCurrentColumn = {
          ...currentColumn,
          ampTop: attackAmp,
          ampBottom: attackAmp
        }
      }
    }
    if (isColumnAttack(shapedCurrentColumn, previousColumn)) {
      return shapedCurrentColumn
    }

    let ampTop = 0
    let ampBottom = 0
    let r = 0
    let g = 0
    let b = 0
    let lowRatio = 0
    let midRatio = 0
    let highRatio = 0
    let totalWeight = 0
    const addColumn = (column: WaveformColumn | null, weight: number) => {
      if (!column) return
      ampTop += column.ampTop * weight
      ampBottom += column.ampBottom * weight
      r += column.color.r * weight
      g += column.color.g * weight
      b += column.color.b * weight
      lowRatio += (column.frequencyRatios?.low ?? 0) * weight
      midRatio += (column.frequencyRatios?.mid ?? 0) * weight
      highRatio += (column.frequencyRatios?.high ?? 0) * weight
      totalWeight += weight
    }

    addColumn(resolveRawTimelineColumn(timelineColumnIndex - 2), COLUMN_DECAY_SMOOTH_PREV2_WEIGHT)
    addColumn(previousColumn, COLUMN_DECAY_SMOOTH_PREV1_WEIGHT)
    addColumn(shapedCurrentColumn, COLUMN_DECAY_SMOOTH_CURRENT_WEIGHT)
    if (totalWeight <= 0 || (ampTop <= 0 && ampBottom <= 0)) return null
    return {
      ampTop: clamp(ampTop / totalWeight, 0, 1),
      ampBottom: clamp(ampBottom / totalWeight, 0, 1),
      color: {
        r: toColorChannel(r / totalWeight),
        g: toColorChannel(g / totalWeight),
        b: toColorChannel(b / totalWeight)
      },
      frequencyRatios:
        lowRatio > 0 || midRatio > 0 || highRatio > 0
          ? {
              low: clamp(lowRatio / totalWeight, 0, 1),
              mid: clamp(midRatio / totalWeight, 0, 1),
              high: clamp(highRatio / totalWeight, 0, 1)
            }
          : undefined
    }
  }
  const applyRawEnergyColumnPostShape = (
    column: WaveformColumn,
    previousColumn: WaveformColumn | null
  ) => {
    const heightShapedColumn =
      shouldUseRawEnergyEnvelope && column.frequencyRatios
        ? {
            ...column,
            ampTop: resolveRekordboxRgbHeightAmp(column.ampTop, column.frequencyRatios),
            ampBottom: resolveRekordboxRgbHeightAmp(column.ampBottom, column.frequencyRatios)
          }
        : column
    if (
      !shouldUseRawEnergyEnvelope ||
      !previousColumn ||
      isColumnAttack(heightShapedColumn, previousColumn)
    ) {
      return heightShapedColumn
    }
    const previousEnergy = resolveColumnEnergy(previousColumn)
    if (previousEnergy <= 0) return heightShapedColumn
    const releasedAmp = previousEnergy * COLUMN_TAIL_RELEASE
    if (releasedAmp <= Math.max(heightShapedColumn.ampTop, heightShapedColumn.ampBottom)) {
      return heightShapedColumn
    }
    return {
      ...heightShapedColumn,
      ampTop: clamp(Math.max(heightShapedColumn.ampTop, releasedAmp), 0, 1),
      ampBottom: clamp(Math.max(heightShapedColumn.ampBottom, releasedAmp), 0, 1)
    }
  }

  const setRawColumn = (x: number, column: WaveformColumn | null) => {
    if (!column) return
    columns[x] = applyRawEnergyColumnPostShape(column, columns[x - 1] ?? null)
  }

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
      const rawTimelineColumnIndex = Math.floor(startTime / rawDetailColumnDurationSec)
      let column: WaveformColumn | null = null
      if (shouldSmoothRawColumns) {
        column = resolveSmoothedRawTimelineColumn(rawTimelineColumnIndex)
      } else if (shouldUseRawEnergyEnvelope) {
        column =
          resolveRawTimelineColumn(rawTimelineColumnIndex) ??
          resolveRawColumnByTimeRange(
            rawData,
            rawFrames,
            rawRate,
            rawStartSec,
            startTime,
            endTime,
            maxSamplesPerPixel,
            rawPeaksOnly,
            shouldUseRawEnergyEnvelope,
            safeWaveformGain
          )
      } else {
        column = resolveRawColumnByTimeRange(
          rawData,
          rawFrames,
          rawRate,
          rawStartSec,
          startTime,
          endTime,
          maxSamplesPerPixel,
          rawPeaksOnly,
          shouldUseRawEnergyEnvelope,
          safeWaveformGain
        )
      }
      setRawColumn(x, column)
      continue
    }

    if (mixxxIsPlaceholder) continue

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
      ampTop: clamp(ampTop * safeWaveformGain, 0, 1),
      ampBottom: clamp(ampBottom * safeWaveformGain, 0, 1),
      color: {
        r: toColorChannel((red / maxColor) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE),
        g: toColorChannel((green / maxColor) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE),
        b: toColorChannel((blue / maxColor) * 255 * MIXXX_RGB_BRIGHTNESS_SCALE)
      }
    }
  }

  return columns
}

const resolveColumnRect = (
  height: number,
  centerY: number,
  ampScale: number,
  waveformLayout: WaveformLayout,
  ampTop: number,
  ampBottom: number
) => {
  const topHeight = Math.max(1, Math.round(ampTop * ampScale))
  const bottomHeight = Math.max(1, Math.round(ampBottom * ampScale))
  const singleHeight = Math.max(topHeight, bottomHeight)
  if (waveformLayout === 'top-half') {
    return {
      y: Math.max(0, height - singleHeight),
      h: singleHeight
    }
  }
  if (waveformLayout === 'bottom-half') {
    return {
      y: 0,
      h: singleHeight
    }
  }
  return {
    y: centerY - topHeight,
    h: topHeight + bottomHeight
  }
}

const drawWaveformColumns = (
  ctx: BeatAlignCanvasContext,
  width: number,
  height: number,
  columns: WaveformColumn[],
  options?: {
    showDetailHighlights?: boolean
    showCenterLine?: boolean
    palette?: BeatAlignWaveformPalette
    waveformLayout?: WaveformLayout
  }
) => {
  const centerY = Math.round(height / 2)
  const showDetailHighlights = options?.showDetailHighlights !== false
  const showCenterLine = options?.showCenterLine !== false
  const palette = options?.palette || DARK_WAVEFORM_PALETTE
  const waveformLayout = options?.waveformLayout || 'full'
  const ampScale =
    waveformLayout === 'full'
      ? Math.max(1, centerY - 2)
      : Math.max(1, Math.floor((height - 2) * HALF_WAVEFORM_AMPLITUDE_RATIO))
  ctx.imageSmoothingEnabled = false

  for (let x = 0; x < width; x += 1) {
    const column = columns[x]
    if (!column) continue
    const ampTop = column.ampTop
    const ampBottom = column.ampBottom
    const rect = resolveColumnRect(height, centerY, ampScale, waveformLayout, ampTop, ampBottom)
    ctx.fillStyle = `rgb(${column.color.r}, ${column.color.g}, ${column.color.b})`
    ctx.fillRect(x, rect.y, 1, rect.h)

    if (showDetailHighlights) {
      const topHighlight = Math.max(0, rect.y)
      const bottomHighlight = Math.min(height - 1, rect.y + rect.h - 1)
      ctx.fillStyle = `rgba(${palette.detailHighlightBase}, ${
        0.14 + Math.max(ampTop, ampBottom) * 0.3
      })`

      if (waveformLayout === 'top-half') {
        ctx.fillRect(x, topHighlight, 1, 1)
      } else if (waveformLayout === 'bottom-half') {
        ctx.fillRect(x, bottomHighlight, 1, 1)
      } else {
        ctx.fillRect(x, topHighlight, 1, 1)
        ctx.fillRect(x, bottomHighlight, 1, 1)
      }
    }
  }

  if (showCenterLine && waveformLayout === 'full') {
    ctx.fillStyle = palette.centerLine
    ctx.fillRect(0, centerY, width, 1)
  }
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
  if (lastFrame !== endFrame) {
    applyFrame(endFrame)
  }
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
  if (lastFrame !== endFrame) {
    applyFrame(endFrame)
  }
  return clamp(count > 0 ? sum / count : 0, -1, 1)
}

const drawRawCurveWaveform = (
  ctx: BeatAlignCanvasContext,
  width: number,
  height: number,
  columns: WaveformColumn[],
  rawData: RawWaveformData | null,
  rangeStartSec: number,
  rangeDurationSec: number,
  maxSamplesPerPixel: number | undefined,
  timeBasisOffsetMs: number | undefined,
  waveformLayout: WaveformLayout,
  waveformGain: number
) => {
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

  const centerY = height * 0.5
  const fullScale = Math.max(1, centerY - 1)
  const halfScale = Math.max(1, height - 2)
  const resolveY = (value: number) => {
    const safeValue = clamp(value, -1, 1) * RAW_CURVE_VERTICAL_SCALE
    if (waveformLayout === 'top-half') return height - 1 - (safeValue + 1) * 0.5 * halfScale
    if (waveformLayout === 'bottom-half') return 1 + (safeValue + 1) * 0.5 * halfScale
    return centerY - safeValue * fullScale
  }

  ctx.imageSmoothingEnabled = true
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 1.35

  let hasDrawn = false
  let previousX = 0
  let previousY = 0
  for (let x = 0; x < width; x += 1) {
    const startTime = rangeStartSec + (x / width) * rangeDurationSec
    const endTime = rangeStartSec + ((x + 1) / width) * rangeDurationSec
    if (endTime <= rawStartSec || startTime >= rawEndSec) continue
    const localStart = clamp(startTime - rawStartSec, 0, rawEndSec - rawStartSec)
    const localEnd = clamp(endTime - rawStartSec, localStart, rawEndSec - rawStartSec)
    const startFrame = clamp(Math.floor(localStart * rawRate), 0, rawFrames - 1)
    const endFrame = clamp(Math.ceil(localEnd * rawRate), startFrame, rawFrames - 1)
    const color = columns[x]?.color || { r: 235, g: 242, b: 248 }
    const meanValue = resolveRawCurveMeanByRange(rawData, startFrame, endFrame, maxSamplesPerPixel)
    ctx.strokeStyle = `rgb(${color.r}, ${color.g}, ${color.b})`
    ctx.beginPath()
    if (meanValue !== null) {
      const nextX = x + 0.5
      const nextY = resolveY(meanValue * waveformGain)
      if (hasDrawn) {
        ctx.moveTo(previousX, previousY)
        ctx.lineTo(nextX, nextY)
      } else {
        ctx.moveTo(nextX, nextY)
      }
      previousX = nextX
      previousY = nextY
    } else {
      const peaks = resolveRawCurvePeaksByRange(rawData, startFrame, endFrame, maxSamplesPerPixel)
      const firstY = resolveY(peaks.max * waveformGain)
      const secondY = resolveY(peaks.min * waveformGain)
      const firstX = x + 0.25
      const secondX = x + 0.75
      if (hasDrawn) {
        ctx.moveTo(previousX, previousY)
        ctx.lineTo(firstX, firstY)
      } else {
        ctx.moveTo(firstX, firstY)
      }
      ctx.lineTo(secondX, secondY)
      previousX = secondX
      previousY = secondY
    }
    ctx.stroke()
    hasDrawn = true
  }
  return hasDrawn
}

export const drawBeatGridWaveform = (ctx: BeatAlignCanvasContext, options: DrawWaveformOptions) => {
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
    showCenterLine,
    showBeatGrid,
    waveformLayout,
    waveformRenderStyle,
    themeVariant,
    timeBasisOffsetMs,
    preferRawPeaksOnly,
    smoothColumns,
    waveformGain
  } = options
  if (width <= 0 || height <= 0) return false
  const palette = resolveWaveformPalette(ctx, themeVariant)
  const resolvedWaveformLayout = waveformLayout || 'full'

  if (showBackground !== false) {
    drawBackground(ctx, width, height, palette)
  }

  if (!isValidMixxxWaveformData(mixxxData)) {
    if (showBeatGrid !== false) {
      drawBeatGrid(
        ctx,
        width,
        height,
        bpm,
        firstBeatMs,
        Number(barBeatOffset) || 0,
        rangeStartSec,
        rangeDurationSec,
        palette
      )
    }
    return false
  }
  const columns = buildWaveformColumns(
    width,
    mixxxData,
    rawData || null,
    rangeStartSec,
    rangeDurationSec,
    maxSamplesPerPixel,
    timeBasisOffsetMs,
    preferRawPeaksOnly,
    smoothColumns,
    waveformRenderStyle === 'columns',
    waveformGain
  )
  const hasColumns = columns.some(Boolean)

  if (
    waveformRenderStyle === 'raw-curve' &&
    drawRawCurveWaveform(
      ctx,
      width,
      height,
      columns,
      rawData || null,
      rangeStartSec,
      rangeDurationSec,
      maxSamplesPerPixel,
      timeBasisOffsetMs,
      resolvedWaveformLayout,
      normalizeWaveformGain(waveformGain)
    )
  ) {
    if (showBeatGrid !== false) {
      drawBeatGrid(
        ctx,
        width,
        height,
        bpm,
        firstBeatMs,
        Number(barBeatOffset) || 0,
        rangeStartSec,
        rangeDurationSec,
        palette
      )
    }
    return true
  }

  if (!hasColumns) {
    if (showBeatGrid !== false) {
      drawBeatGrid(
        ctx,
        width,
        height,
        bpm,
        firstBeatMs,
        Number(barBeatOffset) || 0,
        rangeStartSec,
        rangeDurationSec,
        palette
      )
    }
    return false
  }

  drawWaveformColumns(ctx, width, height, columns, {
    showDetailHighlights,
    showCenterLine,
    palette,
    waveformLayout: resolvedWaveformLayout
  })

  if (showBeatGrid !== false) {
    drawBeatGrid(
      ctx,
      width,
      height,
      bpm,
      firstBeatMs,
      Number(barBeatOffset) || 0,
      rangeStartSec,
      rangeDurationSec,
      palette
    )
  }
  return true
}
