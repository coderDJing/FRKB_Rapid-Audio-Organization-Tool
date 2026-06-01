const MIN_RAW_WAVEFORM_INITIAL_CHUNK_FRAMES = 512
const RAW_WAVEFORM_DEFAULT_INITIAL_CHUNK_FRAMES = 4096
const MAX_RAW_WAVEFORM_INITIAL_BURST_CHUNKS = 16
const MAX_RAW_WAVEFORM_BACKGROUND_INITIAL_BURST_CHUNKS = 2

export const resolveRawWaveformInitialChunkFrames = (params: {
  totalFrames?: number
  rate: number
  chunkFrames: number
  bootstrapDurationSec: number
}) => {
  const totalFrames = Math.max(0, Math.floor(Number(params.totalFrames) || 0))
  const rate = Math.max(1, Number(params.rate) || 1)
  const chunkFrames = Math.max(256, Math.floor(Number(params.chunkFrames) || 0))
  const bootstrapFrames = Math.ceil(Math.max(0, Number(params.bootstrapDurationSec) || 0) * rate)
  const desiredFrames =
    bootstrapFrames > 0
      ? bootstrapFrames
      : Math.min(chunkFrames, RAW_WAVEFORM_DEFAULT_INITIAL_CHUNK_FRAMES)
  const boundedFrames = Math.min(
    chunkFrames,
    Math.max(MIN_RAW_WAVEFORM_INITIAL_CHUNK_FRAMES, desiredFrames)
  )
  return totalFrames > 0 ? Math.min(totalFrames, boundedFrames) : boundedFrames
}

export const resolveRawWaveformInitialBurstFrames = (params: {
  totalFrames?: number
  rate: number
  chunkFrames: number
  bootstrapDurationSec: number
  protectsPlayback: boolean
}) => {
  const totalFrames = Math.max(0, Math.floor(Number(params.totalFrames) || 0))
  const rate = Math.max(1, Number(params.rate) || 1)
  const chunkFrames = Math.max(256, Math.floor(Number(params.chunkFrames) || 0))
  const maxBurstChunks = params.protectsPlayback
    ? MAX_RAW_WAVEFORM_INITIAL_BURST_CHUNKS
    : MAX_RAW_WAVEFORM_BACKGROUND_INITIAL_BURST_CHUNKS
  const bootstrapFrames = Math.ceil(Math.max(0, Number(params.bootstrapDurationSec) || 0) * rate)
  const desiredFrames =
    bootstrapFrames > 0
      ? bootstrapFrames
      : Math.min(chunkFrames, RAW_WAVEFORM_DEFAULT_INITIAL_CHUNK_FRAMES)
  const burstFrames = Math.max(MIN_RAW_WAVEFORM_INITIAL_CHUNK_FRAMES, desiredFrames)
  const cappedFrames = Math.min(burstFrames, chunkFrames * maxBurstChunks)
  return totalFrames > 0 ? Math.min(totalFrames, cappedFrames) : cappedFrames
}
