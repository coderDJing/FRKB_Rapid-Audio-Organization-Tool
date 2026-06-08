export type WaveformDisplayRgbColor = {
  r: number
  g: number
  b: number
}

const WAVEFORM_DISPLAY_SATURATION = 1.42
const WAVEFORM_DISPLAY_VALUE_GAIN = 1.04

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const toColorChannel = (value: number) => clamp(Math.round(value), 0, 255)
const normalizeChannel = (value: number) => clamp(Number(value) || 0, 0, 255)

export const resolveSaturatedWaveformColor = (
  color: WaveformDisplayRgbColor,
  options?: {
    saturation?: number
    valueGain?: number
  }
): WaveformDisplayRgbColor => {
  const saturation = Math.max(0, Number(options?.saturation ?? WAVEFORM_DISPLAY_SATURATION) || 0)
  const valueGain = Math.max(0, Number(options?.valueGain ?? WAVEFORM_DISPLAY_VALUE_GAIN) || 0)
  const r = normalizeChannel(color.r)
  const g = normalizeChannel(color.g)
  const b = normalizeChannel(color.b)
  const luma = r * 0.2126 + g * 0.7152 + b * 0.0722

  return {
    r: toColorChannel((luma + (r - luma) * saturation) * valueGain),
    g: toColorChannel((luma + (g - luma) * saturation) * valueGain),
    b: toColorChannel((luma + (b - luma) * saturation) * valueGain)
  }
}

export const formatSaturatedWaveformRgb = (
  color: WaveformDisplayRgbColor,
  options?: {
    saturation?: number
    valueGain?: number
  }
) => {
  const displayColor = resolveSaturatedWaveformColor(color, options)
  return `rgb(${displayColor.r}, ${displayColor.g}, ${displayColor.b})`
}
