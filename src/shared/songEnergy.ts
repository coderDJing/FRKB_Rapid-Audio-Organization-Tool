import type { UnifiedDisplayWaveformDetailData } from './unifiedDisplayWaveform'
import {
  buildWaveformSurfaceCacheDataFromUnifiedDisplay,
  type WaveformSurfaceData
} from './waveformSurfaceCache'

export const CURRENT_SONG_ENERGY_ALGORITHM_VERSION = 3

export type SongEnergyScorePayload = {
  energyScore: number
  energyAlgorithmVersion: number
}

type ByteReader = (index: number) => number
type SongEnergyPcmInput = {
  pcmData: ArrayBuffer | ArrayBufferView | null | undefined
  sampleRate: number
  channels: number
  bpm?: unknown
}

const BYTE_MAX = 255

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const clamp01 = (value: number) => (Number.isFinite(value) ? clamp(value, 0, 1) : 0)

export const normalizeSongEnergyScore = (value: unknown): number | undefined => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return undefined
  return clamp(Math.round(numeric), 0, 100)
}

export const hasCurrentSongEnergyAnalysis = (
  info: { energyScore?: unknown; energyAlgorithmVersion?: unknown } | null | undefined
) =>
  normalizeSongEnergyScore(info?.energyScore) !== undefined &&
  Number(info?.energyAlgorithmVersion) === CURRENT_SONG_ENERGY_ALGORITHM_VERSION

const readByte = (values: Uint8Array | undefined, index: number, fallback = 0) => {
  if (!values?.length) return fallback
  return clamp(values[clamp(index, 0, values.length - 1)] ?? fallback, 0, BYTE_MAX)
}

const buildHistogram = (length: number, reader: ByteReader) => {
  const histogram = new Uint32Array(BYTE_MAX + 1)
  let count = 0
  let sum = 0
  for (let index = 0; index < length; index += 1) {
    const value = clamp(Math.round(reader(index)), 0, BYTE_MAX)
    histogram[value] += 1
    count += 1
    sum += value
  }
  return { histogram, count, sum }
}

const percentileFromHistogram = (histogram: Uint32Array, count: number, percentile: number) => {
  if (count <= 0) return 0
  const target = Math.max(1, Math.ceil(count * clamp01(percentile)))
  let seen = 0
  for (let value = 0; value < histogram.length; value += 1) {
    seen += histogram[value] || 0
    if (seen >= target) return value
  }
  return 0
}

const summarizeBytes = (length: number, reader: ByteReader) => {
  if (length <= 0) {
    return { mean: 0, p50: 0, p75: 0, p90: 0, p95: 0 }
  }
  const { histogram, count, sum } = buildHistogram(length, reader)
  return {
    mean: count > 0 ? sum / count : 0,
    p50: percentileFromHistogram(histogram, count, 0.5),
    p75: percentileFromHistogram(histogram, count, 0.75),
    p90: percentileFromHistogram(histogram, count, 0.9),
    p95: percentileFromHistogram(histogram, count, 0.95)
  }
}

const ratioAtOrAbove = (length: number, reader: ByteReader, threshold: number) => {
  if (length <= 0) return 0
  let count = 0
  for (let index = 0; index < length; index += 1) {
    if (reader(index) >= threshold) count += 1
  }
  return clamp01(count / length)
}

const summarizeRiseBytes = (length: number, reader: ByteReader) =>
  summarizeBytes(length, (index) => {
    if (index <= 0) return 0
    return Math.max(0, reader(index) - reader(index - 1))
  })

const riseRatioAtOrAbove = (length: number, reader: ByteReader, threshold: number) =>
  ratioAtOrAbove(
    length,
    (index) => {
      if (index <= 0) return 0
      return Math.max(0, reader(index) - reader(index - 1))
    },
    threshold
  )

const ramp01 = (value: number, min: number, max: number) => {
  if (max <= min) return value >= max ? 1 : 0
  return clamp01((value - min) / (max - min))
}

const normalizeDb = (valueDb: number, minDb: number, maxDb: number) => ramp01(valueDb, minDb, maxDb)

const amplitudeToDb = (value: number) => 20 * Math.log10(Math.max(0.000001, value))

const resolveTempoFactor = (bpm: unknown) => {
  let value = Number(bpm)
  if (!Number.isFinite(value) || value <= 0) return 0.5
  while (value < 70) value *= 2
  while (value > 180) value /= 2
  return clamp01((value - 70) / 110)
}

const toFloat32Samples = (value: SongEnergyPcmInput['pcmData']): Float32Array | null => {
  if (!value) return null
  if (value instanceof Float32Array) return value
  if (value instanceof ArrayBuffer) return new Float32Array(value)
  if (!ArrayBuffer.isView(value)) return null
  const view = value as ArrayBufferView
  const usableBytes = Math.floor(view.byteLength / 4) * 4
  if (usableBytes <= 0) return null
  if (view.byteOffset % 4 === 0 && usableBytes === view.byteLength) {
    return new Float32Array(view.buffer, view.byteOffset, usableBytes / 4)
  }
  const copy = new Uint8Array(usableBytes)
  copy.set(new Uint8Array(view.buffer, view.byteOffset, usableBytes))
  return new Float32Array(copy.buffer)
}

export const calculateSongEnergyScoreFromPcm = (
  params: SongEnergyPcmInput
): SongEnergyScorePayload | null => {
  const pcm = toFloat32Samples(params.pcmData)
  const sampleRate = Math.max(1, Math.floor(Number(params.sampleRate) || 0))
  const channels = Math.max(1, Math.floor(Number(params.channels) || 0))
  const totalFrames = pcm ? Math.floor(pcm.length / channels) : 0
  if (!pcm || totalFrames <= sampleRate) return null

  const frameSize = Math.max(256, Math.floor(sampleRate * 0.05))
  const frameCount = Math.max(1, Math.floor(totalFrames / frameSize))
  const rmsValues = new Float64Array(frameCount)
  const lowRmsValues = new Float64Array(frameCount)
  const highRmsValues = new Float64Array(frameCount)
  const peakValues = new Float64Array(frameCount)

  const lowAlpha = 1 - Math.exp((-2 * Math.PI * 160) / sampleRate)
  const highLowAlpha = 1 - Math.exp((-2 * Math.PI * 2500) / sampleRate)
  let lowState = 0
  let highLowState = 0

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const start = frameIndex * frameSize
    const end = Math.min(totalFrames, start + frameSize)
    let sumSq = 0
    let lowSumSq = 0
    let highSumSq = 0
    let peak = 0
    let count = 0
    for (let frame = start; frame < end; frame += 1) {
      const sampleOffset = frame * channels
      let mono = 0
      for (let channel = 0; channel < channels; channel += 1) {
        mono += pcm[sampleOffset + channel] || 0
      }
      mono /= channels
      if (!Number.isFinite(mono)) mono = 0
      mono = clamp(mono, -1, 1)
      lowState += lowAlpha * (mono - lowState)
      highLowState += highLowAlpha * (mono - highLowState)
      const high = mono - highLowState
      const abs = Math.abs(mono)
      peak = Math.max(peak, abs)
      sumSq += mono * mono
      lowSumSq += lowState * lowState
      highSumSq += high * high
      count += 1
    }
    const divisor = Math.max(1, count)
    rmsValues[frameIndex] = Math.sqrt(sumSq / divisor)
    lowRmsValues[frameIndex] = Math.sqrt(lowSumSq / divisor)
    highRmsValues[frameIndex] = Math.sqrt(highSumSq / divisor)
    peakValues[frameIndex] = peak
  }

  const summarizeFloat = (values: Float64Array) => {
    const sorted = Array.from(values).sort((a, b) => a - b)
    const count = sorted.length
    const sum = sorted.reduce((acc, value) => acc + value, 0)
    const percentile = (value: number) =>
      sorted[clamp(Math.ceil(count * value) - 1, 0, Math.max(0, count - 1))] || 0
    return {
      mean: count > 0 ? sum / count : 0,
      p50: percentile(0.5),
      p75: percentile(0.75),
      p90: percentile(0.9),
      p95: percentile(0.95)
    }
  }

  const buildPositiveRiseValues = (values: Float64Array) => {
    const rises = new Float64Array(values.length)
    for (let index = 1; index < values.length; index += 1) {
      rises[index] = Math.max(0, values[index] - values[index - 1])
    }
    return rises
  }

  const summarizePositiveRise = (values: Float64Array) =>
    summarizeFloat(buildPositiveRiseValues(values))

  const ratioAbove = (values: Float64Array, threshold: number) => {
    if (values.length <= 0) return 0
    let count = 0
    for (const value of values) {
      if (value >= threshold) count += 1
    }
    return clamp01(count / values.length)
  }

  const rms = summarizeFloat(rmsValues)
  if (rms.p90 <= 0 && rms.mean <= 0) return null
  const low = summarizeFloat(lowRmsValues)
  const high = summarizeFloat(highRmsValues)
  const peak = summarizeFloat(peakValues)
  const rmsRiseValues = buildPositiveRiseValues(rmsValues)
  const rmsRise = summarizeFloat(rmsRiseValues)
  const lowRise = summarizePositiveRise(lowRmsValues)

  const loudnessPresence =
    0.45 * normalizeDb(amplitudeToDb(rms.mean), -32, -7) +
    0.4 * normalizeDb(amplitudeToDb(rms.p75), -26, -5) +
    0.15 * normalizeDb(amplitudeToDb(peak.p90), -12, -0.5)
  const sustainedDensity =
    0.45 * ratioAbove(rmsValues, Math.max(0.018, rms.p90 * 0.45)) +
    0.35 * ramp01(rms.mean / Math.max(0.000001, rms.p95), 0.35, 0.82) +
    0.2 * ramp01(rms.p50 / Math.max(0.000001, rms.p90), 0.25, 0.72)
  const rhythmActivity =
    0.45 * ramp01(rmsRise.p90 / Math.max(0.000001, rms.p90), 0.12, 0.5) +
    0.25 * ramp01(rmsRise.p95 / Math.max(0.000001, rms.p95), 0.25, 0.75) +
    0.3 * ramp01(ratioAbove(rmsRiseValues, Math.max(0.012, rms.p90 * 0.11)), 0.16, 0.42)
  const bassDrive =
    0.45 * ramp01(low.p75 / Math.max(0.000001, rms.p75), 0.55, 0.98) +
    0.35 * ramp01(lowRise.p90 / Math.max(0.000001, low.p90), 0.1, 0.55) +
    0.2 * ramp01(ratioAbove(lowRmsValues, Math.max(0.018, low.p90 * 0.58)), 0.25, 0.65)
  const timbreBrightness =
    0.55 * ramp01(high.p75 / Math.max(0.000001, rms.p75), 0.12, 0.38) +
    0.45 * ramp01(high.p90 / Math.max(0.000001, rms.p90), 0.16, 0.48)
  const dynamicControl =
    0.55 * ramp01(rms.p50 / Math.max(0.000001, peak.p95), 0.12, 0.5) +
    0.45 * ramp01(rms.p75 / Math.max(0.000001, peak.p95), 0.18, 0.62)
  const tempoFactor = resolveTempoFactor(params.bpm)

  const rawScore =
    0.14 * loudnessPresence +
    0.25 * rhythmActivity +
    0.2 * bassDrive +
    0.17 * sustainedDensity +
    0.08 * dynamicControl +
    0.08 * tempoFactor +
    0.08 * timbreBrightness

  return {
    energyScore: clamp(Math.round(10 + clamp01(rawScore) * 125), 0, 100),
    energyAlgorithmVersion: CURRENT_SONG_ENERGY_ALGORITHM_VERSION
  }
}

const calculateEnergyScore = (params: {
  heightLength: number
  readHeight: ByteReader
  readAttack: ByteReader
  readLow: ByteReader
  readHigh: ByteReader
  bpm?: unknown
}): SongEnergyScorePayload | null => {
  const length = Math.max(0, Math.floor(params.heightLength))
  if (length <= 0) return null

  const height = summarizeBytes(length, params.readHeight)
  if (height.p90 <= 0 && height.mean <= 0) return null
  const attack = summarizeBytes(length, params.readAttack)
  const high = summarizeBytes(length, params.readHigh)
  const lowRise = summarizeRiseBytes(length, params.readLow)

  const loudnessPresence =
    0.55 * ramp01(height.mean / BYTE_MAX, 0.38, 0.9) +
    0.3 * ramp01(ratioAtOrAbove(length, params.readHeight, 180), 0.25, 0.86) +
    0.15 * ramp01(height.p50 / BYTE_MAX, 0.45, 0.95)
  const sustainedDensity =
    0.6 * ramp01(ratioAtOrAbove(length, params.readHeight, 200), 0.2, 0.82) +
    0.4 * ramp01(height.mean / Math.max(1, height.p95), 0.42, 0.88)
  const rhythmActivity =
    0.45 * ramp01(attack.p90 / BYTE_MAX, 0.08, 0.34) +
    0.25 * ramp01(attack.p95 / BYTE_MAX, 0.16, 0.48) +
    0.3 * ramp01(ratioAtOrAbove(length, params.readAttack, 20), 0.08, 0.28)
  const bassDrive =
    0.5 * ramp01(lowRise.p90 / BYTE_MAX, 0.05, 0.34) +
    0.3 * ramp01(riseRatioAtOrAbove(length, params.readLow, 35), 0.05, 0.19) +
    0.2 * ramp01(riseRatioAtOrAbove(length, params.readLow, 20), 0.07, 0.24)
  const timbreBrightness =
    0.55 * ramp01(high.p90 / BYTE_MAX, 0.25, 0.98) +
    0.45 * ramp01(ratioAtOrAbove(length, params.readHigh, 150), 0.02, 0.28)
  const tempoFactor = resolveTempoFactor(params.bpm)

  const rawScore =
    0.29 * loudnessPresence +
    0.23 * rhythmActivity +
    0.18 * bassDrive +
    0.14 * sustainedDensity +
    0.1 * tempoFactor +
    0.06 * timbreBrightness

  return {
    energyScore: clamp(Math.round(12 + clamp01(rawScore) * 105), 0, 100),
    energyAlgorithmVersion: CURRENT_SONG_ENERGY_ALGORITHM_VERSION
  }
}

export const calculateSongEnergyScoreFromUnifiedDisplay = (
  data: UnifiedDisplayWaveformDetailData | null | undefined,
  bpm?: unknown
): SongEnergyScorePayload | null => {
  const surface = buildWaveformSurfaceCacheDataFromUnifiedDisplay(data)?.globalOverview
  return calculateSongEnergyScoreFromWaveformSurface(surface, bpm)
}

export const calculateSongEnergyScoreFromWaveformSurface = (
  data: WaveformSurfaceData | null | undefined,
  bpm?: unknown
): SongEnergyScorePayload | null => {
  const length = data?.detailBody?.length || 0
  if (!data || length <= 0) return null
  return calculateEnergyScore({
    heightLength: length,
    readHeight: (index) =>
      Math.max(readByte(data.detailPeakTop, index), readByte(data.detailPeakBottom, index)),
    readAttack: (index) => {
      if (index <= 0) return 0
      const current = readByte(data.detailBody, index)
      const previous = readByte(data.detailBody, index - 1)
      return Math.max(0, current - previous)
    },
    readLow: (index) => readByte(data.colorLow, index),
    readHigh: (index) => readByte(data.colorHigh, index),
    bpm
  })
}
