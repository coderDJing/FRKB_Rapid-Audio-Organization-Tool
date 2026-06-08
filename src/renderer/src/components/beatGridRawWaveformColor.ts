import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import {
  resolveRawFftBandProfile as resolveSharedRawFftBandProfile,
  type RawFftBandProfile,
  type RawWaveformRgbColor
} from '@shared/rawWaveformColor'
import { resolveSaturatedWaveformColor } from '@shared/waveformDisplayColor'

export type { RawFftBandProfile, RawWaveformRgbColor }

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const resolveCompactColorBandProfile = (
  rawData: RawWaveformData,
  startFrame: number,
  endFrame: number
): RawFftBandProfile | null => {
  const colorIndex = rawData.compactColorIndex
  const colorRed = rawData.compactColorRed
  const colorGreen = rawData.compactColorGreen
  const colorBlue = rawData.compactColorBlue
  if (!colorIndex?.length || !colorRed?.length || !colorGreen?.length || !colorBlue?.length) {
    return null
  }

  const rate = Math.max(1, Number(rawData.rate) || 1)
  const startSec = Math.max(0, Number(rawData.startSec) || 0)
  const globalStartFrame = Math.floor(startSec * rate)
  const divisor = Math.max(1, Math.floor(Number(rawData.compactColorRateDivisor) || 1))
  const colorStartFrame = Math.max(0, Math.floor(Number(rawData.compactColorStartFrame) || 0))
  const firstColorFrame = Math.floor((globalStartFrame + startFrame) / divisor) - colorStartFrame
  const lastColorFrame = Math.floor((globalStartFrame + endFrame) / divisor) - colorStartFrame
  const first = clamp(firstColorFrame, 0, colorIndex.length - 1)
  const last = clamp(lastColorFrame, first, colorIndex.length - 1)

  let low = 0
  let mid = 0
  let high = 0
  let red = 0
  let green = 0
  let blue = 0
  for (let index = first; index <= last; index += 1) {
    low = Math.max(low, rawData.compactColorLow?.[index] || 0)
    mid = Math.max(mid, rawData.compactColorMid?.[index] || 0)
    high = Math.max(high, rawData.compactColorHigh?.[index] || 0)
    red = Math.max(red, colorRed[index] || 0)
    green = Math.max(green, colorGreen[index] || 0)
    blue = Math.max(blue, colorBlue[index] || 0)
  }

  const maxBand = Math.max(low, mid, high)
  if (maxBand <= 0 && red <= 0 && green <= 0 && blue <= 0) return null
  return {
    bands: {
      low: maxBand > 0 ? low / maxBand : 0,
      mid: maxBand > 0 ? mid / maxBand : 0,
      high: maxBand > 0 ? high / maxBand : 0
    },
    color: {
      r: clamp(red, 0, 255),
      g: clamp(green, 0, 255),
      b: clamp(blue, 0, 255)
    }
  }
}

export const resolveRawFftRgbColor = (
  rawData: RawWaveformData,
  startFrame: number,
  endFrame: number,
  maxSamplesPerPixel?: number,
  useRekordboxLikeColor = false
): RawWaveformRgbColor | null =>
  resolveRawFftBandProfile(rawData, startFrame, endFrame, maxSamplesPerPixel, useRekordboxLikeColor)
    ?.color ?? null

export const resolveRawFftBandProfile = (
  rawData: RawWaveformData,
  startFrame: number,
  endFrame: number,
  maxSamplesPerPixel?: number,
  useRekordboxLikeColor = false
): RawFftBandProfile | null => {
  const profile =
    resolveCompactColorBandProfile(rawData, startFrame, endFrame) ??
    resolveSharedRawFftBandProfile(
      rawData,
      startFrame,
      endFrame,
      maxSamplesPerPixel,
      useRekordboxLikeColor
    )
  if (!profile) return null
  return {
    bands: profile.bands,
    color: resolveSaturatedWaveformColor(profile.color)
  }
}
