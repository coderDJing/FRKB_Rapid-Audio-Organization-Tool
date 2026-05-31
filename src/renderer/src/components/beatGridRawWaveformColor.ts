import type { RawWaveformData } from '@renderer/composables/mixtape/types'

type RawWaveformRgbColor = {
  r: number
  g: number
  b: number
}

type RawFftBandAmps = {
  low: number
  mid: number
  high: number
}

export type RawFftBandProfile = {
  bands: RawFftBandAmps
  color: RawWaveformRgbColor
}

type RawFftScratch = {
  real: Float64Array
  imag: Float64Array
  hann: Float64Array
  bitRev: Uint32Array
  cosTable: Float64Array
  sinTable: Float64Array
}

type RawMonoSampleCacheEntry = {
  loadedFrames: number
  usesMean: boolean
  samples: Float32Array
}

const RAW_FFT_MIN_SIZE = 128
const RAW_FFT_MAX_SIZE = 512
const RAW_FFT_LOW_RATIO = 0.05
const RAW_FFT_MID_RATIO = 0.5
const RAW_FFT_ENERGY_EPSILON = 1e-9
const MIXXX_RGB_BRIGHTNESS_SCALE = 0.95
const REKORDBOX_LIKE_COLOR_POST_SCALE = { r: 1.325, g: 1.175, b: 1.55 }
const REKORDBOX_LIKE_COLOR_POST_BIAS = { r: -0.15 * 255, g: -0.04 * 255, b: -0.19 * 255 }
const REKORDBOX_LIKE_RAW_COLOR_MATRIX = {
  red: {
    bias: 0.024414379853462606,
    low: 1.3636302364020418,
    mid: 0.2989517565735422,
    high: -0.3884425100136458,
    low2: -0.35741143012885634,
    mid2: 0.008116662915967665,
    high2: 0.3361939675898044,
    lowMid: -0.250935778789153,
    lowHigh: -0.725448776843492,
    midHigh: -0.3195350634886557
  },
  green: {
    bias: -0.14293297157393708,
    low: 0.36715035356422454,
    mid: 0.6807664576342686,
    high: 0.9935343561143009,
    low2: -0.23351820697954215,
    mid2: 0.0965735433048458,
    high2: -0.5783088220953909,
    lowMid: -0.38132003981655993,
    lowHigh: 0.11861979929562144,
    midHigh: -0.7978326242039837
  },
  blue: {
    bias: -0.07339664560521961,
    low: 0.4463074073131864,
    mid: 0.38938560328908056,
    high: 3.3819092381294453,
    low2: -0.30625297330072865,
    mid2: -0.0075926875815697705,
    high2: -2.1912640541959587,
    lowMid: -0.26423814319873595,
    lowHigh: 0.04164532971471235,
    midHigh: -0.661780296917216
  }
}
type RekordboxLikeColorChannel =
  (typeof REKORDBOX_LIKE_RAW_COLOR_MATRIX)[keyof typeof REKORDBOX_LIKE_RAW_COLOR_MATRIX]

const rawMonoSampleCache = new WeakMap<RawWaveformData, RawMonoSampleCacheEntry>()
const rawFftScratchCache = new Map<number, RawFftScratch>()

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const toColorChannel = (value: number) => clamp(Math.round(value), 0, 255)

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

const resolveRawMonoSamples = (rawData: RawWaveformData) => {
  const loadedFrames = Math.max(
    0,
    Math.min(
      Math.floor(Number(rawData.loadedFrames ?? rawData.frames) || 0),
      Math.floor(Number(rawData.frames) || 0)
    )
  )
  const { meanLeft, meanRight, minLeft, maxLeft, minRight, maxRight } = rawData
  const hasMean =
    !!meanLeft && !!meanRight && meanLeft.length >= loadedFrames && meanRight.length >= loadedFrames
  const cached = rawMonoSampleCache.get(rawData)
  if (cached && cached.loadedFrames === loadedFrames && cached.usesMean === hasMean) {
    return cached.samples
  }

  const frames = Math.max(
    0,
    Math.min(
      loadedFrames,
      rawData.minLeft.length,
      rawData.maxLeft.length,
      rawData.minRight.length,
      rawData.maxRight.length
    )
  )
  const monoSamples = new Float32Array(frames)
  if (hasMean) {
    for (let index = 0; index < frames; index += 1) {
      monoSamples[index] = ((meanLeft[index] || 0) + (meanRight[index] || 0)) * 0.5
    }
  } else {
    for (let index = 0; index < frames; index += 1) {
      monoSamples[index] =
        (minLeft[index] + maxLeft[index] + minRight[index] + maxRight[index]) * 0.25
    }
  }
  rawMonoSampleCache.set(rawData, { loadedFrames, usesMean: hasMean, samples: monoSamples })
  return monoSamples
}

const applyRekordboxLikeRawColorChannel = (
  channel: RekordboxLikeColorChannel,
  lowRatio: number,
  midRatio: number,
  highRatio: number
) =>
  toColorChannel(
    (channel.bias +
      channel.low * lowRatio +
      channel.mid * midRatio +
      channel.high * highRatio +
      channel.low2 * lowRatio * lowRatio +
      channel.mid2 * midRatio * midRatio +
      channel.high2 * highRatio * highRatio +
      channel.lowMid * lowRatio * midRatio +
      channel.lowHigh * lowRatio * highRatio +
      channel.midHigh * midRatio * highRatio) *
      255
  )

const resolveRekordboxLikeRawColor = (
  lowRatio: number,
  midRatio: number,
  highRatio: number
): RawWaveformRgbColor => {
  const color = {
    r: applyRekordboxLikeRawColorChannel(
      REKORDBOX_LIKE_RAW_COLOR_MATRIX.red,
      lowRatio,
      midRatio,
      highRatio
    ),
    g: applyRekordboxLikeRawColorChannel(
      REKORDBOX_LIKE_RAW_COLOR_MATRIX.green,
      lowRatio,
      midRatio,
      highRatio
    ),
    b: applyRekordboxLikeRawColorChannel(
      REKORDBOX_LIKE_RAW_COLOR_MATRIX.blue,
      lowRatio,
      midRatio,
      highRatio
    )
  }
  return {
    r: toColorChannel(
      color.r * REKORDBOX_LIKE_COLOR_POST_SCALE.r + REKORDBOX_LIKE_COLOR_POST_BIAS.r
    ),
    g: toColorChannel(
      color.g * REKORDBOX_LIKE_COLOR_POST_SCALE.g + REKORDBOX_LIKE_COLOR_POST_BIAS.g
    ),
    b: toColorChannel(
      color.b * REKORDBOX_LIKE_COLOR_POST_SCALE.b + REKORDBOX_LIKE_COLOR_POST_BIAS.b
    )
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
  const span = Math.max(1, endFrame - startFrame + 1)
  const fftSize = resolveRawFftSize(span, maxSamplesPerPixel)
  const scratch = resolveRawFftScratch(fftSize)
  const { real, imag, hann, bitRev, cosTable, sinTable } = scratch
  const monoSamples = resolveRawMonoSamples(rawData)
  real.fill(0)
  imag.fill(0)

  const center = Math.floor((startFrame + endFrame) * 0.5)
  const half = fftSize >> 1
  for (let i = 0; i < fftSize; i += 1) {
    const frame = center - half + i
    const sample = frame >= 0 && frame < monoSamples.length ? monoSamples[frame] : 0
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
  const lowRatio = low / maxEnergy
  const midRatio = mid / maxEnergy
  const highRatio = high / maxEnergy
  const bands = {
    low: lowRatio,
    mid: midRatio,
    high: highRatio
  }
  if (useRekordboxLikeColor) {
    return {
      bands,
      color: resolveRekordboxLikeRawColor(lowRatio, midRatio, highRatio)
    }
  }
  return {
    bands,
    color: {
      r: toColorChannel(lowRatio * 255 * MIXXX_RGB_BRIGHTNESS_SCALE),
      g: toColorChannel(midRatio * 255 * MIXXX_RGB_BRIGHTNESS_SCALE),
      b: toColorChannel(highRatio * 255 * MIXXX_RGB_BRIGHTNESS_SCALE)
    }
  }
}
