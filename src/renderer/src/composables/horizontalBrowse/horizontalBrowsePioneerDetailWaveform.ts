import type { RawWaveformData } from '@renderer/composables/mixtape/types'

type PioneerDetailWaveformColumn = {
  height?: number
  bandLow?: number
  band_low?: number
  bandMid?: number
  band_mid?: number
  bandHigh?: number
  band_high?: number
  colorR?: number
  color_r?: number
  colorG?: number
  color_g?: number
  colorB?: number
  color_b?: number
}

export type PioneerDetailWaveformData = {
  style?: string
  detailRate?: number
  detail_rate?: number
  columns?: PioneerDetailWaveformColumn[]
}

export const createPioneerDetailRawWaveform = (
  columns: PioneerDetailWaveformColumn[],
  trackDuration: number,
  detailRate: number | undefined,
  style?: string
): RawWaveformData | null => {
  if (!columns.length || !Number.isFinite(trackDuration) || trackDuration <= 0) return null
  const frames = columns.length
  const nativeDetailRate = Number(detailRate)
  const rate =
    Number.isFinite(nativeDetailRate) && nativeDetailRate > 0
      ? nativeDetailRate
      : frames / trackDuration
  const duration = frames / rate
  const minLeft = new Float32Array(frames)
  const maxLeft = new Float32Array(frames)
  const minRight = new Float32Array(frames)
  const maxRight = new Float32Array(frames)
  const colorRed = new Uint8Array(frames)
  const colorGreen = new Uint8Array(frames)
  const colorBlue = new Uint8Array(frames)
  const colorLow = new Uint8Array(frames)
  const colorMid = new Uint8Array(frames)
  const colorHigh = new Uint8Array(frames)
  const colorIndex = new Uint8Array(frames)
  const isNativeTriBand = style === 'triband-detail' || style === 'triband-preview'
  const isNativeRekordbox = isNativeTriBand || style === 'rgb' || style === 'blue'
  const nativeAmplitudeMax = isNativeTriBand ? 127 : 255
  const nativeColorMax = isNativeTriBand ? 127 : 255
  for (let index = 0; index < frames; index += 1) {
    const column = columns[index]
    const height = Math.max(0, Math.min(1, Number(column?.height) / nativeAmplitudeMax || 0))
    minLeft[index] = -height
    maxLeft[index] = height
    minRight[index] = -height
    maxRight[index] = height
    if (isNativeTriBand) {
      colorLow[index] = Math.round(
        Math.max(
          0,
          Math.min(1, Number(column?.bandLow ?? column?.band_low) / nativeColorMax || 0)
        ) * 255
      )
      colorMid[index] = Math.round(
        Math.max(
          0,
          Math.min(1, Number(column?.bandMid ?? column?.band_mid) / nativeColorMax || 0)
        ) * 255
      )
      colorHigh[index] = Math.round(
        Math.max(
          0,
          Math.min(1, Number(column?.bandHigh ?? column?.band_high) / nativeColorMax || 0)
        ) * 255
      )
    } else {
      colorRed[index] = Math.round(
        Math.max(0, Math.min(1, Number(column?.colorR ?? column?.color_r) / nativeColorMax || 0)) *
          255
      )
      colorGreen[index] = Math.round(
        Math.max(0, Math.min(1, Number(column?.colorG ?? column?.color_g) / nativeColorMax || 0)) *
          255
      )
      colorBlue[index] = Math.round(
        Math.max(0, Math.min(1, Number(column?.colorB ?? column?.color_b) / nativeColorMax || 0)) *
          255
      )
    }
    colorIndex[index] = 1
  }
  return {
    duration,
    sampleRate: Math.max(1, Math.round(rate)),
    rate,
    frames,
    startSec: 0,
    loadedFrames: frames,
    minLeft,
    maxLeft,
    minRight,
    maxRight,
    compactColorIndex: colorIndex,
    compactColorLow: colorLow,
    compactColorMid: colorMid,
    compactColorHigh: colorHigh,
    compactColorRed: colorRed,
    compactColorGreen: colorGreen,
    compactColorBlue: colorBlue,
    compactColorRateDivisor: 1,
    compactColorStartFrame: 0,
    nativeWaveformKind: isNativeRekordbox
      ? isNativeTriBand
        ? 'rekordbox-triband'
        : 'rekordbox-rgb'
      : undefined
  }
}
