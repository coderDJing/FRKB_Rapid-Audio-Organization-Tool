const SOUNDTOUCH_TEMPO_EPSILON = 0.0001

const normalizePcmData = (pcmData: unknown): Float32Array => {
  if (!pcmData) return new Float32Array(0)
  if (pcmData instanceof Float32Array) return pcmData
  if (pcmData instanceof ArrayBuffer) return new Float32Array(pcmData)
  if (ArrayBuffer.isView(pcmData)) {
    const view = pcmData as ArrayBufferView
    return new Float32Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / 4))
  }
  return new Float32Array(0)
}

const fillAudioBufferFromInterleavedPcm = (
  buffer: AudioBuffer,
  pcmData: Float32Array,
  channels: number,
  frameCount: number
) => {
  if (channels <= 1) {
    buffer.getChannelData(0).set(pcmData.subarray(0, frameCount))
    return
  }

  if (channels === 2) {
    const left = buffer.getChannelData(0)
    const right = buffer.getChannelData(1)
    let readIndex = 0
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      left[frameIndex] = pcmData[readIndex]
      right[frameIndex] = pcmData[readIndex + 1]
      readIndex += 2
    }
    return
  }

  for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
    const channelData = buffer.getChannelData(channelIndex)
    let readIndex = channelIndex
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      channelData[frameIndex] = pcmData[readIndex]
      readIndex += channels
    }
  }
}

const interleaveAudioBuffer = (buffer: AudioBuffer) => {
  const channels = Math.max(1, buffer.numberOfChannels || 1)
  const frames = Math.max(0, buffer.length || 0)
  const interleaved = new Float32Array(frames * channels)
  for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
    const channelData = buffer.getChannelData(channelIndex)
    let writeIndex = channelIndex
    for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
      interleaved[writeIndex] = channelData[frameIndex] || 0
      writeIndex += channels
    }
  }
  return interleaved
}

const soundTouchBufferCache = new Map<string, AudioBuffer>()
const soundTouchInflight = new Map<string, Promise<AudioBuffer>>()

export const buildMixtapeSoundTouchCacheKey = (
  filePath: string,
  buffer: AudioBuffer,
  tempoRatio: number
) =>
  `${String(filePath || '').trim()}|${buffer.sampleRate}|${buffer.numberOfChannels}|${Number(
    tempoRatio || 1
  ).toFixed(6)}`

export const processMixtapeAudioBufferWithSoundTouch = async (
  filePath: string,
  buffer: AudioBuffer,
  tempoRatio: number,
  createAudioBuffer: (channels: number, frameCount: number, sampleRate: number) => AudioBuffer
): Promise<AudioBuffer> => {
  const safeTempoRatio = Math.max(0.25, Math.min(4, Number(tempoRatio) || 1))
  if (Math.abs(safeTempoRatio - 1) <= SOUNDTOUCH_TEMPO_EPSILON) {
    return buffer
  }
  const cacheKey = buildMixtapeSoundTouchCacheKey(filePath, buffer, safeTempoRatio)
  const cached = soundTouchBufferCache.get(cacheKey)
  if (cached) {
    soundTouchBufferCache.delete(cacheKey)
    soundTouchBufferCache.set(cacheKey, cached)
    return cached
  }

  let inflight = soundTouchInflight.get(cacheKey)
  if (!inflight) {
    inflight = (async () => {
      const interleaved = interleaveAudioBuffer(buffer)
      const pcmBytes = new Uint8Array(
        interleaved.buffer.slice(
          interleaved.byteOffset,
          interleaved.byteOffset + interleaved.byteLength
        )
      )
      const result = (await window.electron.ipcRenderer.invoke('mixtape:process-soundtouch-pcm', {
        pcmData: pcmBytes,
        sampleRate: buffer.sampleRate,
        channels: buffer.numberOfChannels,
        tempoRatio: safeTempoRatio
      })) as {
        pcmData?: unknown
        sampleRate?: number
        channels?: number
        totalFrames?: number
        error?: string
      }
      if (result?.error) {
        throw new Error(String(result.error))
      }
      const processedPcm = normalizePcmData(result?.pcmData)
      const processedChannels = Math.max(1, Number(result?.channels) || buffer.numberOfChannels)
      const processedSampleRate = Math.max(1, Number(result?.sampleRate) || buffer.sampleRate)
      const processedFrames =
        Math.max(0, Number(result?.totalFrames) || 0) ||
        Math.floor(processedPcm.length / Math.max(1, processedChannels))
      if (!processedPcm.length || processedFrames <= 0) {
        throw new Error('SoundTouch result is empty')
      }
      const nextBuffer = createAudioBuffer(processedChannels, processedFrames, processedSampleRate)
      fillAudioBufferFromInterleavedPcm(
        nextBuffer,
        processedPcm,
        processedChannels,
        processedFrames
      )
      soundTouchBufferCache.set(cacheKey, nextBuffer)
      return nextBuffer
    })().finally(() => {
      soundTouchInflight.delete(cacheKey)
    })
    soundTouchInflight.set(cacheKey, inflight)
  }

  return await inflight
}
