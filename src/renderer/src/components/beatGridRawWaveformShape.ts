export type WaveformRgbColor = {
  r: number
  g: number
  b: number
}

export type WaveformFrequencyRatios = {
  low: number
  mid: number
  high: number
}

const REKORDBOX_RGB_HEIGHT_BLEND = 0.7
const REKORDBOX_RGB_HEIGHT_MIN = 0.65
const REKORDBOX_RGB_HEIGHT_MAX = 1.45
const REKORDBOX_RGB_HEIGHT_MODEL = {
  bias: -0.20727584881057212,
  low: -1.1089910180387275,
  mid: -0.80612393020295,
  high: 1.3458833113691815,
  low2: 0.48550939516603503,
  mid2: 0.1675900273481133,
  high2: -0.9171718984789596,
  lowMid: 0.5689150178041793,
  lowHigh: 0.14729608628360905,
  midHigh: 0.2411855818375205,
  amp: 1.4148689280909756,
  amp2: -0.6614876294854295
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export const resolveRekordboxRgbHeightAmp = (amp: number, ratios: WaveformFrequencyRatios) => {
  if (!Number.isFinite(amp) || amp <= 0) return 0
  const low = clamp(ratios.low, 0, 1)
  const mid = clamp(ratios.mid, 0, 1)
  const high = clamp(ratios.high, 0, 1)
  const safeAmp = clamp(amp, 0, 1)
  const modelValue =
    REKORDBOX_RGB_HEIGHT_MODEL.bias +
    REKORDBOX_RGB_HEIGHT_MODEL.low * low +
    REKORDBOX_RGB_HEIGHT_MODEL.mid * mid +
    REKORDBOX_RGB_HEIGHT_MODEL.high * high +
    REKORDBOX_RGB_HEIGHT_MODEL.low2 * low * low +
    REKORDBOX_RGB_HEIGHT_MODEL.mid2 * mid * mid +
    REKORDBOX_RGB_HEIGHT_MODEL.high2 * high * high +
    REKORDBOX_RGB_HEIGHT_MODEL.lowMid * low * mid +
    REKORDBOX_RGB_HEIGHT_MODEL.lowHigh * low * high +
    REKORDBOX_RGB_HEIGHT_MODEL.midHigh * mid * high +
    REKORDBOX_RGB_HEIGHT_MODEL.amp * safeAmp +
    REKORDBOX_RGB_HEIGHT_MODEL.amp2 * safeAmp * safeAmp
  const multiplier = clamp(
    Math.exp(modelValue),
    REKORDBOX_RGB_HEIGHT_MIN,
    REKORDBOX_RGB_HEIGHT_MAX
  )
  const adjusted = clamp(safeAmp * multiplier, 0, 1)
  return clamp(
    safeAmp * (1 - REKORDBOX_RGB_HEIGHT_BLEND) + adjusted * REKORDBOX_RGB_HEIGHT_BLEND,
    0,
    1
  )
}
