import {
  AUDIO_EDIT_MAX_DURATION_SEC,
  buildAudioEditPlaybackSequence,
  type AudioEditClip
} from './audioEditTimeline'

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export const resolveAudioEditCopyFrames = (
  sourceStartSec: number,
  sourceEndSec: number,
  sampleRate: number,
  sourceFrames: number
) => {
  const startFrame = clamp(Math.floor(sourceStartSec * sampleRate), 0, sourceFrames)
  const endFrame = clamp(Math.ceil(sourceEndSec * sampleRate), startFrame, sourceFrames)
  return {
    startFrame,
    endFrame,
    copyFrames: endFrame - startFrame
  }
}

export const renderAudioEditClipsToInterleavedPcm = (
  sourcePcm: Float32Array,
  sourceFrames: number,
  channels: number,
  sampleRate: number,
  clips: readonly AudioEditClip[]
) => {
  const channelCount = Math.max(1, Math.floor(channels) || 1)
  const safeSourceFrames = Math.max(
    0,
    Math.min(sourceFrames, Math.floor(sourcePcm.length / channelCount))
  )
  const sequence = buildAudioEditPlaybackSequence(clips)
  const ranges: Array<{ startFrame: number; copyFrames: number }> = []
  let neededFrames = 0
  for (const segment of sequence.segments) {
    const copied = resolveAudioEditCopyFrames(
      segment.sourceStartSec,
      segment.sourceEndSec,
      sampleRate,
      safeSourceFrames
    )
    if (copied.copyFrames <= 0) continue
    ranges.push({ startFrame: copied.startFrame, copyFrames: copied.copyFrames })
    neededFrames += copied.copyFrames
  }
  if (neededFrames <= 0) {
    throw new Error('empty-render')
  }
  const maxFrames = Math.max(
    1,
    Math.floor(AUDIO_EDIT_MAX_DURATION_SEC * sampleRate) + ranges.length
  )
  if (neededFrames > maxFrames) {
    throw new Error('duration')
  }
  const output = new Float32Array(neededFrames * channelCount)
  let writeFrame = 0
  for (const range of ranges) {
    const srcStart = range.startFrame * channelCount
    const srcEnd = srcStart + range.copyFrames * channelCount
    output.set(sourcePcm.subarray(srcStart, srcEnd), writeFrame * channelCount)
    writeFrame += range.copyFrames
  }
  return {
    pcm: output,
    frameCount: neededFrames,
    channels: channelCount,
    sampleRate: Math.max(1, Math.floor(sampleRate) || 44100)
  }
}

export const encodeInterleavedPcmToWavBytes = (
  pcm: Float32Array,
  sampleRate: number,
  channels: number
) => {
  const channelCount = Math.max(1, Math.min(2, Math.floor(channels) || 1))
  const frameCount = Math.max(0, Math.floor(pcm.length / Math.max(1, Math.floor(channels) || 1)))
  const safeSampleRate = Math.max(1, Math.floor(sampleRate) || 44100)
  const dataSize = frameCount * channelCount * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index))
    }
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channelCount, true)
  view.setUint32(24, safeSampleRate, true)
  view.setUint32(28, safeSampleRate * channelCount * 2, true)
  view.setUint16(32, channelCount * 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, dataSize, true)
  const sourceChannels = Math.max(1, Math.floor(channels) || 1)
  let offset = 44
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const base = frameIndex * sourceChannels
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      const sample = pcm[base + Math.min(channelIndex, sourceChannels - 1)] ?? 0
      const clamped = clamp(sample, -1, 1)
      view.setInt16(
        offset,
        clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff),
        true
      )
      offset += 2
    }
  }
  return new Uint8Array(buffer)
}
