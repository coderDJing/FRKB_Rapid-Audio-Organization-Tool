import type { RawWaveformData } from '@renderer/composables/mixtape/types'

type RawWaveformAmps = {
  ampTop: number
  ampBottom: number
}

type RawEnergyProfile = RawWaveformAmps & {
  base: number
  peak: number
  shape: RawEnergyShapeParams
}

export type RawEnergyShapeParams = {
  peakBlendWeight: number
  outputGamma: number
  attackWeight: number
}

type RawEnergyScaleCacheEntry = {
  loadedFrames: number
  scale: number
}

const RAW_ENERGY_SCALE_PERCENTILE = 0.9999
const RAW_ENERGY_SCALE_SAMPLE_CAP = 65536
const RAW_ENERGY_MIN_SCALE = 0.04
const RAW_ENERGY_EPSILON = 1e-6
const RAW_ENERGY_PEAK_BLEND_WEIGHT = 0.55
const RAW_ENERGY_OUTPUT_GAMMA = 1.74
const RAW_ENERGY_GATE = 0.02
const RAW_ENERGY_ATTACK_WEIGHT = 0.78
const RAW_ENERGY_ATTACK_RISE = 0.105
const RAW_ENERGY_FULL_TRACK_START_SEC = 20
const RAW_ENERGY_FULL_TRACK_TARGET_SEC = 45
const RAW_ENERGY_FULL_TRACK_PEAK_BLEND_WEIGHT = 1
const RAW_ENERGY_FULL_TRACK_OUTPUT_GAMMA = 1.5
const RAW_ENERGY_FULL_TRACK_ATTACK_WEIGHT = 0

const rawEnergyScaleCache = new WeakMap<RawWaveformData, RawEnergyScaleCacheEntry>()

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const lerp = (start: number, end: number, ratio: number) => start + (end - start) * ratio

const resolveLoadedFrames = (rawData: RawWaveformData) =>
  Math.max(
    0,
    Math.min(
      Math.floor(Number(rawData.loadedFrames ?? rawData.frames) || 0),
      Math.floor(Number(rawData.frames) || 0),
      rawData.minLeft.length,
      rawData.maxLeft.length,
      rawData.minRight.length,
      rawData.maxRight.length
    )
  )

const resolveFrameEnergy = (rawData: RawWaveformData, frame: number) => {
  const rmsLeft = rawData.rmsLeft?.[frame]
  const rmsRight = rawData.rmsRight?.[frame]
  if (
    typeof rmsLeft === 'number' &&
    typeof rmsRight === 'number' &&
    Number.isFinite(rmsLeft) &&
    Number.isFinite(rmsRight)
  ) {
    return Math.sqrt((rmsLeft * rmsLeft + rmsRight * rmsRight) / 2)
  }

  const minLeft = rawData.minLeft[frame] || 0
  const maxLeft = rawData.maxLeft[frame] || 0
  const minRight = rawData.minRight[frame] || 0
  const maxRight = rawData.maxRight[frame] || 0
  return Math.sqrt(
    (minLeft * minLeft + maxLeft * maxLeft + minRight * minRight + maxRight * maxRight) / 4
  )
}

const resolveRawEnergyScale = (rawData: RawWaveformData) => {
  const loadedFrames = resolveLoadedFrames(rawData)
  const cached = rawEnergyScaleCache.get(rawData)
  if (cached && cached.loadedFrames === loadedFrames) return cached.scale

  const values: number[] = []
  const step = Math.max(1, Math.floor(loadedFrames / RAW_ENERGY_SCALE_SAMPLE_CAP))
  for (let frame = 0; frame < loadedFrames; frame += step) {
    const energy = resolveFrameEnergy(rawData, frame)
    if (energy > RAW_ENERGY_EPSILON) values.push(energy)
  }
  values.sort((a, b) => a - b)
  const index = Math.floor((values.length - 1) * RAW_ENERGY_SCALE_PERCENTILE)
  const percentile = index >= 0 ? values[index] || 0 : 0
  const scale = clamp(percentile || 1, RAW_ENERGY_MIN_SCALE, 1)
  rawEnergyScaleCache.set(rawData, { loadedFrames, scale })
  return scale
}

const resolveRawEnergyShapeParams = (rawData: RawWaveformData): RawEnergyShapeParams => {
  const loadedFrames = resolveLoadedFrames(rawData)
  const rate = Number(rawData.rate) || 0
  const rawDurationSec = Number(rawData.duration)
  const durationSec =
    Number.isFinite(rawDurationSec) && rawDurationSec > 0
      ? rawDurationSec
      : rate > 0
        ? loadedFrames / rate
        : 0
  const fullTrackRatio = clamp(
    (durationSec - RAW_ENERGY_FULL_TRACK_START_SEC) /
      (RAW_ENERGY_FULL_TRACK_TARGET_SEC - RAW_ENERGY_FULL_TRACK_START_SEC),
    0,
    1
  )
  return {
    peakBlendWeight: lerp(
      RAW_ENERGY_PEAK_BLEND_WEIGHT,
      RAW_ENERGY_FULL_TRACK_PEAK_BLEND_WEIGHT,
      fullTrackRatio
    ),
    outputGamma: lerp(RAW_ENERGY_OUTPUT_GAMMA, RAW_ENERGY_FULL_TRACK_OUTPUT_GAMMA, fullTrackRatio),
    attackWeight: lerp(
      RAW_ENERGY_ATTACK_WEIGHT,
      RAW_ENERGY_FULL_TRACK_ATTACK_WEIGHT,
      fullTrackRatio
    )
  }
}

const shapeEnergyAmp = (value: number, outputGamma = RAW_ENERGY_OUTPUT_GAMMA) => {
  const amp = value > 0 ? Math.pow(clamp(value, 0, 1), outputGamma) : 0
  return amp < RAW_ENERGY_GATE ? 0 : amp
}

export const resolveRawEnergyAttackAmp = (
  base: number | undefined,
  peak: number | undefined,
  previousBase: number | undefined,
  shapeParams?: RawEnergyShapeParams
) => {
  if (
    typeof base !== 'number' ||
    typeof peak !== 'number' ||
    typeof previousBase !== 'number' ||
    base - previousBase < RAW_ENERGY_ATTACK_RISE ||
    peak <= base
  ) {
    return null
  }
  const attackWeight = shapeParams?.attackWeight ?? RAW_ENERGY_ATTACK_WEIGHT
  return shapeEnergyAmp(
    base * (1 - attackWeight) + peak * attackWeight,
    shapeParams?.outputGamma
  )
}

export const resolveRawEnergyProfileByRange = (
  rawData: RawWaveformData,
  startFrame: number,
  endFrame: number,
  maxSamplesPerPixel?: number
): RawEnergyProfile => {
  const span = endFrame - startFrame + 1
  const sampleCap = Number(maxSamplesPerPixel)
  const step =
    Number.isFinite(sampleCap) && sampleCap > 0
      ? Math.max(1, Math.floor(span / Math.max(1, Math.floor(sampleCap))))
      : 1
  let sum = 0
  let peak = 0
  let count = 0
  let lastFrame = startFrame
  const addFrame = (frame: number) => {
    const energy = resolveFrameEnergy(rawData, frame)
    sum += energy
    if (energy > peak) peak = energy
    count += 1
  }
  for (let frame = startFrame; frame <= endFrame; frame += step) {
    addFrame(frame)
    lastFrame = frame
  }
  if (lastFrame !== endFrame) addFrame(endFrame)

  const scale = resolveRawEnergyScale(rawData)
  const shapeParams = resolveRawEnergyShapeParams(rawData)
  const mean = count > 0 ? clamp(sum / count / scale, 0, 1) : 0
  const normalizedPeak = clamp(peak / scale, 0, 1)
  const base =
    mean * (1 - shapeParams.peakBlendWeight) + normalizedPeak * shapeParams.peakBlendWeight
  const amp = shapeEnergyAmp(base, shapeParams.outputGamma)
  return { ampTop: amp, ampBottom: amp, base, peak: normalizedPeak, shape: shapeParams }
}

export const resolveRawEnergyByRange = (
  rawData: RawWaveformData,
  startFrame: number,
  endFrame: number,
  maxSamplesPerPixel?: number
): RawWaveformAmps =>
  resolveRawEnergyProfileByRange(rawData, startFrame, endFrame, maxSamplesPerPixel)
