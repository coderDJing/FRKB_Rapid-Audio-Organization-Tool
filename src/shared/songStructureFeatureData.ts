export const SONG_STRUCTURE_FEATURE_CACHE_VERSION = 1
export const SONG_STRUCTURE_FEATURE_EXTRACTOR_VERSION = 1
export const SONG_STRUCTURE_FEATURE_DEFAULT_FRAME_RATE = 16

export const SONG_STRUCTURE_FEATURE_BAND_KEYS = ['low', 'mid', 'high', 'all'] as const

const MIXXX_HIGH_SCALE_EXPONENT = 0.632

export type SongStructureFeatureBandKey = (typeof SONG_STRUCTURE_FEATURE_BAND_KEYS)[number]

export type SongStructureFeatureBandData = {
  body: Uint8Array
  peak: Uint8Array
  onset: Uint8Array
}

export type SongStructureFeatureData = {
  cacheVersion: number
  extractorVersion: number
  durationSec: number
  frameRate: number
  frameCount: number
  bands: Record<SongStructureFeatureBandKey, SongStructureFeatureBandData>
}

type SongStructureFeatureSourceBand = {
  left: Uint8Array
  right: Uint8Array
  peakLeft: Uint8Array
  peakRight: Uint8Array
}

export type SongStructureFeatureSource = {
  duration: number
  sampleRate: number
  step: number
  bands: Record<SongStructureFeatureBandKey, SongStructureFeatureSourceBand>
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value))

const toByte = (value: number) => clamp(Math.round(value), 0, 255)

const decodeMixxxBandByte = (key: SongStructureFeatureBandKey, value: number) => {
  const ratio = clamp(value, 0, 255) / 255
  return key === 'high' ? ratio ** (1 / MIXXX_HIGH_SCALE_EXPONENT) * 255 : ratio * 255
}

const resolveSourceFrameCount = (source: SongStructureFeatureSource) => {
  const lengths: number[] = []
  for (const key of SONG_STRUCTURE_FEATURE_BAND_KEYS) {
    const band = source.bands?.[key]
    lengths.push(
      band?.left?.length || 0,
      band?.right?.length || 0,
      band?.peakLeft?.length || 0,
      band?.peakRight?.length || 0
    )
  }
  return Math.min(...lengths)
}

const readRobustPeak = (
  key: SongStructureFeatureBandKey,
  band: SongStructureFeatureSourceBand,
  startFrame: number,
  endFrame: number,
  histogram: Uint32Array
) => {
  histogram.fill(0)
  let count = 0
  for (let frame = startFrame; frame < endFrame; frame += 1) {
    const peak = toByte(
      decodeMixxxBandByte(key, Math.max(band.peakLeft[frame] ?? 0, band.peakRight[frame] ?? 0))
    )
    histogram[peak] = (histogram[peak] ?? 0) + 1
    count += 1
  }
  if (count <= 0) return 0
  const target = Math.max(1, Math.ceil(count * 0.9))
  let accumulated = 0
  for (let value = 0; value < histogram.length; value += 1) {
    accumulated += histogram[value] ?? 0
    if (accumulated >= target) return value
  }
  return 255
}

const aggregateBand = (
  key: SongStructureFeatureBandKey,
  band: SongStructureFeatureSourceBand,
  sourceFrameCount: number,
  sourceRate: number,
  targetFrameRate: number,
  targetFrameCount: number
): SongStructureFeatureBandData => {
  const body = new Uint8Array(targetFrameCount)
  const peak = new Uint8Array(targetFrameCount)
  const onset = new Uint8Array(targetFrameCount)
  const histogram = new Uint32Array(256)
  for (let targetFrame = 0; targetFrame < targetFrameCount; targetFrame += 1) {
    const startFrame = clamp(
      Math.floor((targetFrame / targetFrameRate) * sourceRate),
      0,
      sourceFrameCount - 1
    )
    const endFrame = clamp(
      Math.max(startFrame + 1, Math.ceil(((targetFrame + 1) / targetFrameRate) * sourceRate)),
      startFrame + 1,
      sourceFrameCount
    )
    let bodySum = 0
    for (let frame = startFrame; frame < endFrame; frame += 1) {
      bodySum +=
        (decodeMixxxBandByte(key, band.left[frame] ?? 0) +
          decodeMixxxBandByte(key, band.right[frame] ?? 0)) *
        0.5
    }
    body[targetFrame] = toByte(bodySum / Math.max(1, endFrame - startFrame))
    peak[targetFrame] = readRobustPeak(key, band, startFrame, endFrame, histogram)
  }
  const fastAlpha = 1 - Math.exp(-1 / Math.max(1, sourceRate * 0.008))
  const slowAlpha = 1 - Math.exp(-1 / Math.max(1, sourceRate * 0.08))
  const initial = decodeMixxxBandByte(key, Math.max(band.left[0] ?? 0, band.right[0] ?? 0))
  let fast = initial
  let slow = initial
  for (let sourceFrame = 0; sourceFrame < sourceFrameCount; sourceFrame += 1) {
    const value = decodeMixxxBandByte(
      key,
      Math.max(band.left[sourceFrame] ?? 0, band.right[sourceFrame] ?? 0)
    )
    fast += (value - fast) * fastAlpha
    slow += (value - slow) * slowAlpha
    const targetFrame = clamp(
      Math.floor((sourceFrame / sourceRate) * targetFrameRate),
      0,
      targetFrameCount - 1
    )
    onset[targetFrame] = Math.max(onset[targetFrame] ?? 0, toByte(Math.max(0, fast - slow)))
  }
  return { body, peak, onset }
}

export const isValidSongStructureFeatureData = (
  value: SongStructureFeatureData | null | undefined
): value is SongStructureFeatureData => {
  if (!value) return false
  if (
    value.cacheVersion !== SONG_STRUCTURE_FEATURE_CACHE_VERSION ||
    value.extractorVersion !== SONG_STRUCTURE_FEATURE_EXTRACTOR_VERSION ||
    !Number.isFinite(value.durationSec) ||
    value.durationSec <= 0 ||
    !Number.isFinite(value.frameRate) ||
    value.frameRate <= 0 ||
    !Number.isInteger(value.frameCount) ||
    value.frameCount <= 0
  ) {
    return false
  }
  return SONG_STRUCTURE_FEATURE_BAND_KEYS.every((key) => {
    const band = value.bands?.[key]
    return (
      band?.body instanceof Uint8Array &&
      band.peak instanceof Uint8Array &&
      band.onset instanceof Uint8Array &&
      band.body.length === value.frameCount &&
      band.peak.length === value.frameCount &&
      band.onset.length === value.frameCount
    )
  })
}

export const buildSongStructureFeatureDataFromMixxx = (
  source: SongStructureFeatureSource,
  frameRate = SONG_STRUCTURE_FEATURE_DEFAULT_FRAME_RATE
): SongStructureFeatureData | null => {
  const durationSec = Number(source?.duration)
  const sampleRate = Number(source?.sampleRate)
  const step = Number(source?.step)
  const safeFrameRate = Number(frameRate)
  const sourceFrameCount = resolveSourceFrameCount(source)
  const sourceRate = sampleRate / step
  if (
    !Number.isFinite(durationSec) ||
    durationSec <= 0 ||
    !Number.isFinite(sourceRate) ||
    sourceRate <= 0 ||
    !Number.isFinite(safeFrameRate) ||
    safeFrameRate < 4 ||
    safeFrameRate > 64 ||
    sourceFrameCount <= 0
  ) {
    return null
  }
  const frameCount = Math.max(1, Math.ceil(durationSec * safeFrameRate))
  const bands = {} as Record<SongStructureFeatureBandKey, SongStructureFeatureBandData>
  for (const key of SONG_STRUCTURE_FEATURE_BAND_KEYS) {
    const band = source.bands?.[key]
    if (!band) return null
    bands[key] = aggregateBand(key, band, sourceFrameCount, sourceRate, safeFrameRate, frameCount)
  }
  return {
    cacheVersion: SONG_STRUCTURE_FEATURE_CACHE_VERSION,
    extractorVersion: SONG_STRUCTURE_FEATURE_EXTRACTOR_VERSION,
    durationSec,
    frameRate: safeFrameRate,
    frameCount,
    bands
  }
}

export const getSongStructureFeaturePayloadBytes = (data: SongStructureFeatureData) =>
  SONG_STRUCTURE_FEATURE_BAND_KEYS.reduce((total, key) => {
    const band = data.bands[key]
    return total + band.body.byteLength + band.peak.byteLength + band.onset.byteLength
  }, 0)
