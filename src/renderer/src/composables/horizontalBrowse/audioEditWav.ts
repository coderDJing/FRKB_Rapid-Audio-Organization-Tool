import type { AudioEditClip } from '@shared/audioEditTimeline'
import {
  encodeInterleavedPcmToWavBytes,
  renderAudioEditClipsToInterleavedPcm
} from '@shared/audioEditPcm'

const audioBufferToInterleavedPcm = (source: AudioBuffer) => {
  const channels = Math.max(1, source.numberOfChannels)
  const frames = source.length
  const pcm = new Float32Array(frames * channels)
  for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
    const data = source.getChannelData(channelIndex)
    for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
      pcm[frameIndex * channels + channelIndex] = data[frameIndex] || 0
    }
  }
  return { pcm, frames, channels, sampleRate: source.sampleRate }
}

export const renderAudioEditClipsToBuffer = (
  source: AudioBuffer,
  clips: readonly AudioEditClip[],
  ctx: BaseAudioContext
) => {
  const planar = audioBufferToInterleavedPcm(source)
  const rendered = renderAudioEditClipsToInterleavedPcm(
    planar.pcm,
    planar.frames,
    planar.channels,
    planar.sampleRate,
    clips
  )
  const output = ctx.createBuffer(
    rendered.channels,
    Math.max(1, rendered.frameCount),
    rendered.sampleRate
  )
  for (let channelIndex = 0; channelIndex < rendered.channels; channelIndex += 1) {
    const channel = output.getChannelData(channelIndex)
    for (let frameIndex = 0; frameIndex < rendered.frameCount; frameIndex += 1) {
      channel[frameIndex] = rendered.pcm[frameIndex * rendered.channels + channelIndex] || 0
    }
  }
  return output
}

export const encodeAudioBufferToWavBytes = (audioBuffer: AudioBuffer) => {
  const planar = audioBufferToInterleavedPcm(audioBuffer)
  return encodeInterleavedPcmToWavBytes(planar.pcm, planar.sampleRate, planar.channels)
}
