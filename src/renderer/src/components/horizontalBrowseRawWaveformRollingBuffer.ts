import type { RawWaveformData } from '@renderer/composables/mixtape/types'

type RawWaveformWindowMeta = {
  duration: number
  sampleRate: number
  rate: number
}

const RAW_WAVEFORM_META_EPSILON = 0.0001

export const isRawWaveformWindowFormatCompatible = (
  current: RawWaveformData | null,
  meta: RawWaveformWindowMeta
) => {
  if (!current) return false
  const currentDuration = Number(current.duration) || 0
  const nextDuration = Number(meta.duration) || 0
  const durationMatches =
    currentDuration <= 0 ||
    nextDuration <= 0 ||
    Math.abs(currentDuration - nextDuration) <= RAW_WAVEFORM_META_EPSILON
  return (
    durationMatches &&
    current.sampleRate === meta.sampleRate &&
    current.rate === meta.rate &&
    meta.rate > 0
  )
}

const growFloat32Array = (source: Float32Array, frames: number) => {
  if (source.length >= frames) return source
  const target = new Float32Array(frames)
  target.set(source.subarray(0, Math.min(source.length, frames)))
  return target
}

const growOptionalFloat32Array = (source: Float32Array | undefined, frames: number) =>
  source ? growFloat32Array(source, frames) : undefined

const trimFloat32Array = (source: Float32Array, dropFrames: number, frames: number) => {
  if (source.length === 0) return source
  const target = new Float32Array(frames)
  const copyFrames = Math.min(frames, Math.max(0, source.length - dropFrames))
  if (copyFrames > 0) {
    target.set(source.subarray(dropFrames, dropFrames + copyFrames))
  }
  return target
}

const trimOptionalFloat32Array = (
  source: Float32Array | undefined,
  dropFrames: number,
  frames: number
) => (source ? trimFloat32Array(source, dropFrames, frames) : undefined)

export const ensureRawWaveformWindowCapacity = (
  rawData: RawWaveformData,
  requiredFrames: number,
  keepArrays: boolean
) => {
  const nextFrames = Math.max(0, Math.floor(Number(requiredFrames) || 0))
  if (!nextFrames) return false
  const currentFrames = Math.max(0, Math.floor(Number(rawData.frames) || 0))
  const arrayFrames = keepArrays ? nextFrames : rawData.minLeft.length
  if (currentFrames >= nextFrames && (!keepArrays || rawData.minLeft.length >= nextFrames)) {
    return false
  }

  rawData.frames = Math.max(currentFrames, nextFrames)
  rawData.minLeft = growFloat32Array(rawData.minLeft, arrayFrames)
  rawData.maxLeft = growFloat32Array(rawData.maxLeft, arrayFrames)
  rawData.minRight = growFloat32Array(rawData.minRight, arrayFrames)
  rawData.maxRight = growFloat32Array(rawData.maxRight, arrayFrames)
  rawData.meanLeft = growOptionalFloat32Array(rawData.meanLeft, arrayFrames)
  rawData.meanRight = growOptionalFloat32Array(rawData.meanRight, arrayFrames)
  rawData.rmsLeft = growOptionalFloat32Array(rawData.rmsLeft, arrayFrames)
  rawData.rmsRight = growOptionalFloat32Array(rawData.rmsRight, arrayFrames)
  return true
}

export const trimRawWaveformWindowStart = (rawData: RawWaveformData, nextStartSec: number) => {
  const rate = Math.max(0, Number(rawData.rate) || 0)
  if (!rate) return 0

  const currentStartSec = Math.max(0, Number(rawData.startSec) || 0)
  const safeNextStartSec = Math.max(0, Number(nextStartSec) || 0)
  if (safeNextStartSec <= currentStartSec + RAW_WAVEFORM_META_EPSILON) return 0

  const currentFrames = Math.max(0, Math.floor(Number(rawData.frames) || 0))
  const loadedFrames = Math.max(0, Math.floor(Number(rawData.loadedFrames ?? currentFrames) || 0))
  const requestedDropFrames = Math.floor((safeNextStartSec - currentStartSec) * rate)
  const maxDropFrames = Math.max(0, Math.min(currentFrames, loadedFrames) - 1)
  const dropFrames = Math.min(Math.max(0, requestedDropFrames), maxDropFrames)
  if (!dropFrames) return 0

  const nextFrames = Math.max(0, currentFrames - dropFrames)
  rawData.startSec = currentStartSec + dropFrames / rate
  rawData.frames = nextFrames
  rawData.loadedFrames = Math.max(0, loadedFrames - dropFrames)
  rawData.minLeft = trimFloat32Array(rawData.minLeft, dropFrames, nextFrames)
  rawData.maxLeft = trimFloat32Array(rawData.maxLeft, dropFrames, nextFrames)
  rawData.minRight = trimFloat32Array(rawData.minRight, dropFrames, nextFrames)
  rawData.maxRight = trimFloat32Array(rawData.maxRight, dropFrames, nextFrames)
  rawData.meanLeft = trimOptionalFloat32Array(rawData.meanLeft, dropFrames, nextFrames)
  rawData.meanRight = trimOptionalFloat32Array(rawData.meanRight, dropFrames, nextFrames)
  rawData.rmsLeft = trimOptionalFloat32Array(rawData.rmsLeft, dropFrames, nextFrames)
  rawData.rmsRight = trimOptionalFloat32Array(rawData.rmsRight, dropFrames, nextFrames)
  return dropFrames
}

export const resolveRawWaveformWindowFrame = (rawData: RawWaveformData, audioSec: number) => {
  const rate = Math.max(1, Number(rawData.rate) || 1)
  const startSec = Math.max(0, Number(rawData.startSec) || 0)
  return Math.max(0, Math.round((Math.max(0, audioSec) - startSec) * rate))
}
