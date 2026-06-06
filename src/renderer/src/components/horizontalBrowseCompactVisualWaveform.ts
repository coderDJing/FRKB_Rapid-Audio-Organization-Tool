import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import {
  COMPACT_VISUAL_WAVEFORM_CACHE_VERSION,
  COMPACT_VISUAL_WAVEFORM_PARAMETER_VERSION,
  type CompactVisualWaveformData
} from '@shared/compactVisualWaveform'
import type { UnifiedDisplayWaveformDetailData } from '@shared/unifiedDisplayWaveform'
import { resolveRekordboxLikeRawColor } from '@shared/rawWaveformColor'

type CompactVisualWaveformLoadResponse = {
  status?: 'ready' | 'missing'
  data?: CompactVisualWaveformData | null
}

type UnifiedDisplayWaveformLoadResponse = {
  status?: 'ready' | 'missing'
  data?: UnifiedDisplayWaveformDetailData | null
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const toUint8Array = (value: unknown) => {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  }
  return new Uint8Array(0)
}

export const normalizeCompactVisualWaveformData = (
  value: unknown
): CompactVisualWaveformData | null => {
  const payload =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as CompactVisualWaveformData)
      : null
  if (!payload) return null
  const detailPeakTop = toUint8Array(payload.detailPeakTop)
  const detailPeakBottom = toUint8Array(payload.detailPeakBottom)
  const detailBody = toUint8Array(payload.detailBody)
  const colorIndex = toUint8Array(payload.colorIndex)
  const colorLow = toUint8Array(payload.colorLow)
  const colorMid = toUint8Array(payload.colorMid)
  const colorHigh = toUint8Array(payload.colorHigh)
  const colorRed = toUint8Array(payload.colorRed)
  const colorGreen = toUint8Array(payload.colorGreen)
  const colorBlue = toUint8Array(payload.colorBlue)
  const overviewTop = toUint8Array(payload.overviewTop)
  const overviewBottom = toUint8Array(payload.overviewBottom)
  const frames = Math.min(detailPeakTop.length, detailPeakBottom.length)
  const duration = Math.max(0, Number(payload.duration) || 0)
  const detailRate = Math.max(0, Number(payload.detailRate) || 0)
  const sampleRate = Math.max(0, Number(payload.sampleRate) || 0)
  if (
    !frames ||
    !duration ||
    !detailRate ||
    !sampleRate ||
    !colorIndex.length ||
    !colorRed.length ||
    !colorGreen.length ||
    !colorBlue.length
  ) {
    return null
  }
  return {
    version: Math.max(0, Number(payload.version) || 0),
    parameterVersion: Math.max(0, Number(payload.parameterVersion) || 0),
    duration,
    sampleRate,
    detailRate,
    overviewRate: Math.max(0, Number(payload.overviewRate) || 0),
    bodyRateDivisor: Math.max(1, Number(payload.bodyRateDivisor) || 1),
    colorRateDivisor: Math.max(1, Number(payload.colorRateDivisor) || 1),
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
    overviewTop,
    overviewBottom
  }
}

const resolveColorFrequency = (colorIndex: number, rate: number) => {
  const nyquistLimit = Math.max(8, rate * 0.45)
  if (colorIndex === 0) return Math.min(36, nyquistLimit)
  if (colorIndex === 1) return Math.min(120, nyquistLimit)
  if (colorIndex === 2) return Math.min(220, nyquistLimit)
  return Math.min(76, nyquistLimit)
}

const readClampedByte = (values: Uint8Array, index: number, fallback: number) => {
  if (!values.length) return fallback
  return values[clamp(Math.floor(index), 0, values.length - 1)] ?? fallback
}

export const compactVisualWaveformToRawData = (
  data: CompactVisualWaveformData
): RawWaveformData | null => {
  const normalized = normalizeCompactVisualWaveformData(data)
  if (!normalized) return null
  const frames = Math.min(normalized.detailPeakTop.length, normalized.detailPeakBottom.length)
  const minLeft = new Float32Array(frames)
  const maxLeft = new Float32Array(frames)
  const minRight = new Float32Array(frames)
  const maxRight = new Float32Array(frames)
  const meanLeft = new Float32Array(frames)
  const meanRight = new Float32Array(frames)
  const rmsLeft = new Float32Array(frames)
  const rmsRight = new Float32Array(frames)
  let phase = 0
  for (let index = 0; index < frames; index += 1) {
    const top = clamp((normalized.detailPeakTop[index] || 0) / 255, 0, 1)
    const bottom = clamp((normalized.detailPeakBottom[index] || 0) / 255, 0, 1)
    const body = readClampedByte(
      normalized.detailBody,
      Math.floor(index / normalized.bodyRateDivisor),
      Math.round(Math.max(top, bottom) * 255)
    )
    const color = readClampedByte(
      normalized.colorIndex,
      Math.floor(index / normalized.colorRateDivisor),
      3
    )
    const bodyAmp = clamp(body / 255, 0, 1)
    const rms = clamp(Math.max(bodyAmp, (top + bottom) * 0.32), 0, 1)
    const waveformSample = Math.sin(phase) * rms * 0.82
    phase +=
      (Math.PI * 2 * resolveColorFrequency(color, normalized.detailRate)) / normalized.detailRate
    minLeft[index] = -top
    maxLeft[index] = top
    minRight[index] = -bottom
    maxRight[index] = bottom
    meanLeft[index] = waveformSample
    meanRight[index] = waveformSample
    rmsLeft[index] = rms
    rmsRight[index] = rms
  }
  return {
    duration: normalized.duration,
    sampleRate: normalized.sampleRate,
    rate: normalized.detailRate,
    frames,
    startSec: 0,
    loadedFrames: frames,
    minLeft,
    maxLeft,
    minRight,
    maxRight,
    meanLeft,
    meanRight,
    rmsLeft,
    rmsRight,
    compactColorIndex: normalized.colorIndex,
    compactColorLow: normalized.colorLow,
    compactColorMid: normalized.colorMid,
    compactColorHigh: normalized.colorHigh,
    compactColorRed: normalized.colorRed,
    compactColorGreen: normalized.colorGreen,
    compactColorBlue: normalized.colorBlue,
    compactColorRateDivisor: normalized.colorRateDivisor,
    compactColorStartFrame: 0
  }
}

export const normalizeUnifiedDisplayWaveformData = (
  value: unknown
): UnifiedDisplayWaveformDetailData | null => {
  const payload =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as UnifiedDisplayWaveformDetailData)
      : null
  if (!payload) return null
  const height = toUint8Array(payload.height)
  const attack = toUint8Array(payload.attack)
  const colorIndex = toUint8Array(payload.colorIndex)
  const body = toUint8Array(payload.body)
  const overviewHeight = toUint8Array(payload.overviewHeight)
  const frames = Math.min(height.length, attack.length, colorIndex.length)
  const duration = Math.max(0, Number(payload.duration) || 0)
  const detailRate = Math.max(0, Number(payload.detailRate) || 0)
  const sampleRate = Math.max(0, Number(payload.sampleRate) || 0)
  if (!frames || !duration || !detailRate || !sampleRate || !body.length) return null
  return {
    version: Math.max(0, Number(payload.version) || 0),
    parameterVersion: Math.max(0, Number(payload.parameterVersion) || 0),
    duration,
    sampleRate,
    detailRate,
    overviewRate: Math.max(0, Number(payload.overviewRate) || 0),
    bodyRateDivisor: Math.max(1, Number(payload.bodyRateDivisor) || 1),
    height,
    attack,
    colorIndex,
    body,
    overviewHeight
  }
}

const resolveUnifiedColorBands = (colorIndex: number) => {
  if (colorIndex === 0) return { low: 1, mid: 0.32, high: 0.16 }
  if (colorIndex === 1) return { low: 0.24, mid: 1, high: 0.42 }
  if (colorIndex === 2) return { low: 0.16, mid: 0.46, high: 1 }
  return { low: 0.52, mid: 0.68, high: 0.78 }
}

export const unifiedDisplayWaveformToRawData = (
  data: UnifiedDisplayWaveformDetailData
): RawWaveformData | null => {
  const normalized = normalizeUnifiedDisplayWaveformData(data)
  if (!normalized) return null
  const frames = Math.min(
    normalized.height.length,
    normalized.attack.length,
    normalized.colorIndex.length
  )
  const minLeft = new Float32Array(frames)
  const maxLeft = new Float32Array(frames)
  const minRight = new Float32Array(frames)
  const maxRight = new Float32Array(frames)
  const meanLeft = new Float32Array(frames)
  const meanRight = new Float32Array(frames)
  const rmsLeft = new Float32Array(frames)
  const rmsRight = new Float32Array(frames)
  const colorLow = new Uint8Array(frames)
  const colorMid = new Uint8Array(frames)
  const colorHigh = new Uint8Array(frames)
  const colorRed = new Uint8Array(frames)
  const colorGreen = new Uint8Array(frames)
  const colorBlue = new Uint8Array(frames)
  let phase = 0
  for (let index = 0; index < frames; index += 1) {
    const height = clamp((normalized.height[index] || 0) / 255, 0, 1)
    const attack = clamp((normalized.attack[index] || 0) / 255, 0, 1)
    const body = readClampedByte(
      normalized.body,
      Math.floor(index / normalized.bodyRateDivisor),
      Math.round(height * 255)
    )
    const color = readClampedByte(normalized.colorIndex, index, 3)
    const bodyAmp = clamp(body / 255, 0, 1)
    const rms = clamp(Math.max(bodyAmp, height * 0.42, attack * 0.72), 0, 1)
    const waveformSample = Math.sin(phase) * rms * (0.72 + attack * 0.16)
    const bands = resolveUnifiedColorBands(color)
    const rgb = resolveRekordboxLikeRawColor(bands.low, bands.mid, bands.high)
    phase +=
      (Math.PI * 2 * resolveColorFrequency(color, normalized.detailRate)) / normalized.detailRate
    minLeft[index] = -height
    maxLeft[index] = height
    minRight[index] = -height
    maxRight[index] = height
    meanLeft[index] = waveformSample
    meanRight[index] = waveformSample
    rmsLeft[index] = rms
    rmsRight[index] = rms
    colorLow[index] = Math.round(bands.low * 255)
    colorMid[index] = Math.round(bands.mid * 255)
    colorHigh[index] = Math.round(bands.high * 255)
    colorRed[index] = rgb.r
    colorGreen[index] = rgb.g
    colorBlue[index] = rgb.b
  }
  return {
    duration: normalized.duration,
    sampleRate: normalized.sampleRate,
    rate: normalized.detailRate,
    frames,
    startSec: 0,
    loadedFrames: frames,
    minLeft,
    maxLeft,
    minRight,
    maxRight,
    meanLeft,
    meanRight,
    rmsLeft,
    rmsRight,
    compactColorIndex: normalized.colorIndex,
    compactColorLow: colorLow,
    compactColorMid: colorMid,
    compactColorHigh: colorHigh,
    compactColorRed: colorRed,
    compactColorGreen: colorGreen,
    compactColorBlue: colorBlue,
    compactColorRateDivisor: 1,
    compactColorStartFrame: 0
  }
}

export const unifiedDisplayWaveformToCompactVisualOverviewData = (
  data: UnifiedDisplayWaveformDetailData
): CompactVisualWaveformData | null => {
  const normalized = normalizeUnifiedDisplayWaveformData(data)
  if (!normalized) return null
  const sourceHeight = normalized.overviewHeight.length
    ? normalized.overviewHeight
    : normalized.height
  const frames = sourceHeight.length
  if (!frames) return null

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
      frames <= 1 ? 0 : Math.floor((index / frames) * Math.max(1, normalized.colorIndex.length))
    const color = readClampedByte(normalized.colorIndex, sourceColorFrame, 3)
    const bands = resolveUnifiedColorBands(color)
    const rgb = resolveRekordboxLikeRawColor(bands.low, bands.mid, bands.high)
    colorIndex[index] = color
    colorLow[index] = Math.round(bands.low * 255)
    colorMid[index] = Math.round(bands.mid * 255)
    colorHigh[index] = Math.round(bands.high * 255)
    colorRed[index] = rgb.r
    colorGreen[index] = rgb.g
    colorBlue[index] = rgb.b
  }

  const overviewRate = Math.max(
    1,
    Number(normalized.overviewRate) || frames / Math.max(0.0001, normalized.duration)
  )

  return {
    version: COMPACT_VISUAL_WAVEFORM_CACHE_VERSION,
    parameterVersion: COMPACT_VISUAL_WAVEFORM_PARAMETER_VERSION,
    duration: normalized.duration,
    sampleRate: normalized.sampleRate,
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

export const loadCompactVisualWaveformData = async (
  filePath: string,
  listRoot?: string
): Promise<CompactVisualWaveformData | null> => {
  const response = (await window.electron.ipcRenderer.invoke('compact-visual-waveform-cache:load', {
    filePath,
    listRoot
  })) as CompactVisualWaveformLoadResponse | null
  if (response?.status !== 'ready') return null
  return normalizeCompactVisualWaveformData(response.data)
}

export const loadUnifiedDisplayWaveformData = async (
  filePath: string,
  listRoot?: string
): Promise<UnifiedDisplayWaveformDetailData | null> => {
  const response = (await window.electron.ipcRenderer.invoke(
    'unified-display-waveform-cache:load',
    {
      filePath,
      listRoot
    }
  )) as UnifiedDisplayWaveformLoadResponse | null
  if (response?.status !== 'ready') return null
  return normalizeUnifiedDisplayWaveformData(response.data)
}
