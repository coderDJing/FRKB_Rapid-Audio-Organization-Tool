import {
  toFloat32Array,
  type HorizontalBrowseRawWaveformStreamChunkPayload,
  type PendingRawStreamChunkWork
} from '@renderer/components/horizontalBrowseRawWaveformStreamTypes'

export const buildPendingRawStreamChunkWork = (
  payload: HorizontalBrowseRawWaveformStreamChunkPayload,
  fallbackStartSec: number
): PendingRawStreamChunkWork | null => {
  const totalFrames = Math.max(0, Number(payload.totalFrames) || 0)
  const duration = Math.max(0, Number(payload.duration) || 0)
  const sampleRate = Math.max(0, Number(payload.sampleRate) || 0)
  const rate = Math.max(0, Number(payload.rate) || 0)
  const startSec = Math.max(0, Number(payload.startSec) || fallbackStartSec)
  const startFrame = Math.max(0, Number(payload.startFrame) || 0)
  const frames = Math.max(0, Number(payload.frames) || 0)
  if (!totalFrames || !duration || !sampleRate || !rate || !frames) return null

  const minLeft = toFloat32Array(payload.minLeft)
  const maxLeft = toFloat32Array(payload.maxLeft)
  const minRight = toFloat32Array(payload.minRight)
  const maxRight = toFloat32Array(payload.maxRight)
  const meanLeft = toFloat32Array(payload.meanLeft)
  const meanRight = toFloat32Array(payload.meanRight)
  const rmsLeft = toFloat32Array(payload.rmsLeft)
  const rmsRight = toFloat32Array(payload.rmsRight)
  const chunkFrames = Math.min(
    frames,
    minLeft.length,
    maxLeft.length,
    minRight.length,
    maxRight.length
  )
  if (!chunkFrames) return null

  return {
    payload,
    startFrame,
    chunkFrames,
    totalFrames,
    duration,
    sampleRate,
    rate,
    startSec,
    minLeft,
    maxLeft,
    minRight,
    maxRight,
    meanLeft: meanLeft.length >= chunkFrames ? meanLeft : undefined,
    meanRight: meanRight.length >= chunkFrames ? meanRight : undefined,
    rmsLeft: rmsLeft.length >= chunkFrames ? rmsLeft : undefined,
    rmsRight: rmsRight.length >= chunkFrames ? rmsRight : undefined,
    appliedFrames: 0
  }
}
