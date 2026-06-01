import type { Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import type {
  HorizontalBrowseDetailLiveCanvasRawChunk,
  HorizontalBrowseDetailLiveCanvasRawMeta
} from '@renderer/workers/horizontalBrowseDetailLiveCanvas.types'

export type HorizontalBrowseDirection = 'up' | 'down'

type HorizontalBrowseRawWaveformPayload = {
  frames?: unknown
  duration?: unknown
  sampleRate?: unknown
  rate?: unknown
  startSec?: unknown
  minLeft?: unknown
  maxLeft?: unknown
  minRight?: unknown
  maxRight?: unknown
  meanLeft?: unknown
  meanRight?: unknown
  rmsLeft?: unknown
  rmsRight?: unknown
}

export type HorizontalBrowseRawWaveformStreamChunkPayload = {
  requestId?: string
  filePath?: string
  startFrame?: number
  frames?: number
  totalFrames?: number
  duration?: number
  sampleRate?: number
  rate?: number
  startSec?: number
  minLeft?: unknown
  maxLeft?: unknown
  minRight?: unknown
  maxRight?: unknown
  meanLeft?: unknown
  meanRight?: unknown
  rmsLeft?: unknown
  rmsRight?: unknown
}

export type HorizontalBrowseRawWaveformStreamDonePayload = {
  requestId?: string
  filePath?: string
  data?: unknown
  duration?: unknown
  totalFrames?: unknown
  startSec?: unknown
  error?: string
  fromCache?: boolean
  streamed?: boolean
}

export type RawWaveformStreamStartOptions = {
  bootstrapAnchorSec?: number
  bootstrapDurationSec?: number
  forceLiveDecode?: boolean
  initialRetryCount?: number
}

export type PendingRawStreamChunkWork = {
  payload: HorizontalBrowseRawWaveformStreamChunkPayload
  startFrame: number
  chunkFrames: number
  totalFrames: number
  duration: number
  sampleRate: number
  rate: number
  startSec: number
  minLeft: Float32Array
  maxLeft: Float32Array
  minRight: Float32Array
  maxRight: Float32Array
  meanLeft?: Float32Array
  meanRight?: Float32Array
  rmsLeft?: Float32Array
  rmsRight?: Float32Array
  appliedFrames: number
}

export type UseHorizontalBrowseRawWaveformStreamOptions = {
  song: () => ISongInfo | null
  direction: () => HorizontalBrowseDirection
  deferWaveformLoad: () => boolean
  rawLoadPriorityHint: () => number | undefined
  bootstrapDurationSec: () => number | undefined
  timeBasisOffsetMs: () => number
  playing: () => boolean
  currentSeconds: () => number | undefined
  viewportAnchorSec: () => number
  visibleDurationSec: () => number
  previewLoading: Ref<boolean>
  rawStreamActive: Ref<boolean>
  rawData: Ref<RawWaveformData | null>
  mixxxData: Ref<MixxxWaveformData | null>
  clearStreamDrawScheduling: () => void
  scheduleRawStreamDirtyDraw: (dirtyStartSec: number, dirtyEndSec: number) => void
  scheduleRawStreamCoverageDraw: () => void
  resetRawStreamDrawState: () => void
  scheduleDraw: () => void
  holdCurrentWaveformFrame: () => void
  storeRawWaveform: (filePath: string, data: RawWaveformData) => void
  resetLiveWaveformRaw: (meta: HorizontalBrowseDetailLiveCanvasRawMeta) => void
  ensureLiveWaveformRawCapacity: (meta: HorizontalBrowseDetailLiveCanvasRawMeta) => void
  applyLiveWaveformRawChunk: (
    chunk: HorizontalBrowseDetailLiveCanvasRawChunk,
    transferOwnership?: boolean
  ) => void
  replaceLiveWaveformRaw: (data: RawWaveformData | null) => void
  updateLiveWaveformRawMeta: (meta: Partial<HorizontalBrowseDetailLiveCanvasRawMeta>) => void
}

export const HORIZONTAL_BROWSE_RAW_WAVEFORM_CHUNK_FRAMES = 32768
export const HORIZONTAL_BROWSE_RAW_PLAYING_WAVEFORM_CHUNK_FRAMES = 8192
export const HORIZONTAL_BROWSE_RAW_CHUNK_PROCESS_BUDGET_MS = 4
export const HORIZONTAL_BROWSE_RAW_CHUNK_COPY_SLICE_FRAMES = 2048
export const HORIZONTAL_BROWSE_RAW_PLAYING_COPY_SLICE_FRAMES = 4096
export const HORIZONTAL_BROWSE_RAW_PLAYING_COPY_SLICES_PER_FLUSH = 4
export const HORIZONTAL_BROWSE_RAW_CONTINUE_LOOKAHEAD_FACTOR = 2
export const HORIZONTAL_BROWSE_RAW_VIEWPORT_OVERSCAN_FACTOR = 0.25
export const HORIZONTAL_BROWSE_RAW_VIEWPORT_RESTART_GAP_FACTOR = 0.75
export const HORIZONTAL_BROWSE_RAW_VISIBLE_REDRAW_LEAD_FACTOR = 0.25
export const HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_LEAD_FACTOR = 0.55
export const HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_OVERSCAN_FACTOR = 1.25
export const HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_MIN_SEC = 4
export const HORIZONTAL_BROWSE_RAW_INITIAL_CHUNK_TIMEOUT_MS = 1500
export const HORIZONTAL_BROWSE_RAW_INITIAL_CHUNK_MAX_RETRIES = 1
export const HORIZONTAL_BROWSE_RAW_CONTINUE_TIMEOUT_MS = 1200
export const HORIZONTAL_BROWSE_RAW_DURATION_TAIL_TOLERANCE_SEC = 0.75

export const toFloat32Array = (value: unknown) => {
  if (value instanceof Float32Array) return value
  if (value instanceof ArrayBuffer) return new Float32Array(value)
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    return new Float32Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / 4))
  }
  return new Float32Array(0)
}

export const normalizeRawWaveformData = (value: unknown): RawWaveformData | null => {
  const payload =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as HorizontalBrowseRawWaveformPayload)
      : null
  if (!payload) return null

  const frames = Math.max(0, Number(payload.frames) || 0)
  const duration = Math.max(0, Number(payload.duration) || 0)
  const sampleRate = Math.max(0, Number(payload.sampleRate) || 0)
  const rate = Math.max(0, Number(payload.rate) || 0)
  const startSec = Math.max(0, Number(payload.startSec) || 0)
  const minLeft = toFloat32Array(payload.minLeft)
  const maxLeft = toFloat32Array(payload.maxLeft)
  const minRight = toFloat32Array(payload.minRight)
  const maxRight = toFloat32Array(payload.maxRight)
  const meanLeft = toFloat32Array(payload.meanLeft)
  const meanRight = toFloat32Array(payload.meanRight)
  const rmsLeft = toFloat32Array(payload.rmsLeft)
  const rmsRight = toFloat32Array(payload.rmsRight)
  if (!frames || !duration || !sampleRate || !rate) return null
  const hasRms = rmsLeft.length >= frames && rmsRight.length >= frames
  const hasMean = meanLeft.length >= frames && meanRight.length >= frames

  const normalized: RawWaveformData = {
    duration,
    sampleRate,
    rate,
    frames,
    startSec,
    loadedFrames: frames,
    minLeft: new Float32Array(minLeft),
    maxLeft: new Float32Array(maxLeft),
    minRight: new Float32Array(minRight),
    maxRight: new Float32Array(maxRight)
  }
  if (hasRms) {
    normalized.rmsLeft = new Float32Array(rmsLeft.subarray(0, frames))
    normalized.rmsRight = new Float32Array(rmsRight.subarray(0, frames))
  }
  if (hasMean) {
    normalized.meanLeft = new Float32Array(meanLeft.subarray(0, frames))
    normalized.meanRight = new Float32Array(meanRight.subarray(0, frames))
  }
  return normalized
}
