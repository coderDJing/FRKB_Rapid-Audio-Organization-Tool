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

// Raw buffers are normalized PCM amplitudes; 1.0 is the fixed 0 dBFS visual reference.
const RAW_ENERGY_FIXED_REFERENCE_AMPLITUDE = 1
const RAW_ENERGY_FIXED_VISUAL_GAIN = 1
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

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const lerp = (start: number, end: number, ratio: number) => start + (end - start) * ratio
const normalizeWaveformGain = (value?: number) => {
  if (typeof value === 'undefined') return 1
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 1
  return clamp(numeric, 0, 16)
}

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

export const resolveRawEnergyShapeParamsByDuration = (
  durationSec: number
): RawEnergyShapeParams => {
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
  return resolveRawEnergyShapeParamsByDuration(durationSec)
}

export const shapeRawEnergyAmpValue = (value: number, outputGamma = RAW_ENERGY_OUTPUT_GAMMA) => {
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
  return shapeRawEnergyAmpValue(
    base * (1 - attackWeight) + peak * attackWeight,
    shapeParams?.outputGamma
  )
}

export const resolveRawEnergyProfileByRange = (
  rawData: RawWaveformData,
  startFrame: number,
  endFrame: number,
  maxSamplesPerPixel?: number,
  waveformGain?: number
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

  const scale =
    RAW_ENERGY_FIXED_REFERENCE_AMPLITUDE /
    Math.max(0.000001, RAW_ENERGY_FIXED_VISUAL_GAIN * normalizeWaveformGain(waveformGain))
  const shapeParams = resolveRawEnergyShapeParams(rawData)
  const mean = count > 0 ? clamp(sum / count / scale, 0, 1) : 0
  const normalizedPeak = clamp(peak / scale, 0, 1)
  const base =
    mean * (1 - shapeParams.peakBlendWeight) + normalizedPeak * shapeParams.peakBlendWeight
  const amp = shapeRawEnergyAmpValue(base, shapeParams.outputGamma)
  return { ampTop: amp, ampBottom: amp, base, peak: normalizedPeak, shape: shapeParams }
}
