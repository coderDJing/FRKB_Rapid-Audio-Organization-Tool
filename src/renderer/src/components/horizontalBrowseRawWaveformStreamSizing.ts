import {
  HORIZONTAL_BROWSE_RAW_CONTINUE_LOOKAHEAD_FACTOR,
  HORIZONTAL_BROWSE_RAW_PLAYING_WAVEFORM_CHUNK_FRAMES,
  HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_CHUNK_FRAMES,
  HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_CHUNK_OVERSCAN_FACTOR,
  HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_LEAD_FACTOR,
  HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_MAX_CHUNK_FRAMES,
  HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_MIN_SEC,
  HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_OVERSCAN_FACTOR,
  HORIZONTAL_BROWSE_RAW_WAVEFORM_CHUNK_FRAMES
} from '@renderer/components/horizontalBrowseRawWaveformStreamTypes'
import { resolveHorizontalBrowseEditRawWindowLeadSec } from '@renderer/components/horizontalBrowseEditDetailRawWaveform'

const HORIZONTAL_BROWSE_EDIT_RAW_WINDOW_MIN_CHUNK_FRAMES = 262144
const HORIZONTAL_BROWSE_EDIT_RAW_WINDOW_MAX_CHUNK_FRAMES = 2_000_000

export const resolveHorizontalBrowseRawSeekBootstrapChunkFrames = (params: {
  visibleDurationSec: number
  targetRate: number
}) => {
  const visibleDurationSec = Math.max(0.001, Number(params.visibleDurationSec) || 0.001)
  const targetRate = Math.max(1, Math.floor(Number(params.targetRate) || 1))
  const targetFrames = Math.ceil(
    visibleDurationSec * targetRate * HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_CHUNK_OVERSCAN_FACTOR
  )
  return Math.min(
    HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_MAX_CHUNK_FRAMES,
    Math.max(HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_CHUNK_FRAMES, targetFrames)
  )
}

export const resolveHorizontalBrowseRawStreamChunkFrames = (params: {
  editWindow: boolean
  fastInitialCoverage: boolean
  playing: boolean
  seekBootstrapChunkFrames: number
  targetRate: number
  bootstrapDurationSec: number
}) => {
  if (params.editWindow) {
    const targetFrames = Math.ceil(
      Math.max(0.001, Number(params.bootstrapDurationSec) || 0.001) *
        Math.max(1, Math.floor(Number(params.targetRate) || 1))
    )
    return Math.min(
      HORIZONTAL_BROWSE_EDIT_RAW_WINDOW_MAX_CHUNK_FRAMES,
      Math.max(HORIZONTAL_BROWSE_EDIT_RAW_WINDOW_MIN_CHUNK_FRAMES, targetFrames)
    )
  }
  if (params.fastInitialCoverage) return params.seekBootstrapChunkFrames
  return params.playing
    ? HORIZONTAL_BROWSE_RAW_PLAYING_WAVEFORM_CHUNK_FRAMES
    : HORIZONTAL_BROWSE_RAW_WAVEFORM_CHUNK_FRAMES
}

export const resolveHorizontalBrowseRawSeekBootstrapDurationSec = (visibleDurationSec: number) =>
  Math.max(
    HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_MIN_SEC,
    Math.max(0.001, Number(visibleDurationSec) || 0.001) *
      HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_OVERSCAN_FACTOR
  )

export const resolveHorizontalBrowseRawStreamBootstrapStartSec = (params: {
  targetSec: number
  visibleDurationSec: number
  editWindow: boolean
  highPrecision: boolean
  playing: boolean
}) => {
  const visibleDurationSec = Math.max(0.001, Number(params.visibleDurationSec) || 0.001)
  const leadSec = params.editWindow
    ? resolveHorizontalBrowseEditRawWindowLeadSec(visibleDurationSec)
    : params.highPrecision
      ? params.playing
        ? 1
        : 0.25
      : visibleDurationSec * HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_LEAD_FACTOR
  return Math.max(0, Math.max(0, Number(params.targetSec) || 0) - leadSec)
}

export const resolveHorizontalBrowseRawStreamExpectedDurationSec = (params: {
  songDurationSec: number
  startSec: number
  bootstrapDurationSec: number
  visibleDurationSec: number
  protectsPlayback: boolean
  highPrecision: boolean
}) => {
  const songDurationSec = Math.max(0, Number(params.songDurationSec) || 0)
  const startSec = Math.max(0, Number(params.startSec) || 0)
  const bootstrapDurationSec = Math.max(0, Number(params.bootstrapDurationSec) || 0)
  const visibleDurationSec = Math.max(0.001, Number(params.visibleDurationSec) || 0.001)
  const knownRemainingDurationSec =
    songDurationSec > 0 ? Math.max(0, songDurationSec - startSec) : 0
  const playbackDecodeWindowSec = Math.max(
    bootstrapDurationSec,
    visibleDurationSec *
      (HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_LEAD_FACTOR +
        HORIZONTAL_BROWSE_RAW_CONTINUE_LOOKAHEAD_FACTOR)
  )
  const boundedRemainingDurationSec =
    knownRemainingDurationSec > 0 ? knownRemainingDurationSec : playbackDecodeWindowSec
  return params.protectsPlayback || params.highPrecision
    ? Math.min(boundedRemainingDurationSec, playbackDecodeWindowSec)
    : boundedRemainingDurationSec
}
