import type { TransportPlaybackSequence } from './timelineTransportPlaybackSequence'

const resolveSequenceFrames = (buffer: AudioBuffer, sequence: TransportPlaybackSequence) =>
  sequence.segments
    .map((segment) => {
      const startFrame = Math.max(
        0,
        Math.min(
          buffer.length,
          Math.floor((Number(segment.sourceStartSec) || 0) * buffer.sampleRate)
        )
      )
      const endFrame = Math.max(
        startFrame,
        Math.min(buffer.length, Math.ceil((Number(segment.sourceEndSec) || 0) * buffer.sampleRate))
      )
      return { startFrame, endFrame }
    })
    .filter((segment) => segment.endFrame > segment.startFrame)

export const createTransportPlanBuffer = (
  audioCtx: Pick<BaseAudioContext, 'createBuffer'>,
  buffer: AudioBuffer,
  sequence?: TransportPlaybackSequence
) => {
  if (!sequence || sequence.segments.length <= 1) return buffer
  const segments = resolveSequenceFrames(buffer, sequence)
  const frameCount = segments.reduce(
    (total, segment) => total + segment.endFrame - segment.startFrame,
    0
  )
  if (frameCount <= 0) return buffer
  const channels = Math.max(1, Math.min(2, buffer.numberOfChannels || 1))
  const planBuffer = audioCtx.createBuffer(channels, frameCount, buffer.sampleRate)
  for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
    const sourceChannel = buffer.getChannelData(Math.min(buffer.numberOfChannels - 1, channelIndex))
    const targetChannel = planBuffer.getChannelData(channelIndex)
    let targetOffset = 0
    for (const segment of segments) {
      targetChannel.set(sourceChannel.subarray(segment.startFrame, segment.endFrame), targetOffset)
      targetOffset += segment.endFrame - segment.startFrame
    }
  }
  return planBuffer
}
