import type { Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { createRawPlaceholderMixxxData } from '@renderer/components/mixtapeBeatAlignWaveformPlaceholder'
import { PREVIEW_RAW_TARGET_RATE } from '@renderer/components/MixtapeBeatAlignDialog.constants'
import { normalizeHorizontalBrowsePathKey } from '@renderer/components/horizontalBrowseWaveformDetail.utils'
import { parseHorizontalBrowseDurationToSeconds } from '@renderer/components/horizontalBrowseShellState'

type HorizontalBrowseDirection = 'up' | 'down'

type HorizontalBrowseRawWaveformPayload = {
  frames?: unknown
  duration?: unknown
  sampleRate?: unknown
  rate?: unknown
  minLeft?: unknown
  maxLeft?: unknown
  minRight?: unknown
  maxRight?: unknown
}

type HorizontalBrowseRawWaveformStreamChunkPayload = {
  requestId?: string
  filePath?: string
  startFrame?: number
  frames?: number
  totalFrames?: number
  duration?: number
  sampleRate?: number
  rate?: number
  minLeft?: unknown
  maxLeft?: unknown
  minRight?: unknown
  maxRight?: unknown
}

type HorizontalBrowseRawWaveformStreamDonePayload = {
  requestId?: string
  filePath?: string
  data?: unknown
  duration?: unknown
  totalFrames?: unknown
  error?: string
  fromCache?: boolean
  streamed?: boolean
}

type UseHorizontalBrowseRawWaveformStreamOptions = {
  song: () => ISongInfo | null
  direction: () => HorizontalBrowseDirection
  rawLoadPriorityHint: () => number | undefined
  previewLoading: Ref<boolean>
  rawStreamActive: Ref<boolean>
  rawData: Ref<RawWaveformData | null>
  mixxxData: Ref<MixxxWaveformData | null>
  clearStreamDrawScheduling: () => void
  scheduleRawStreamDirtyDraw: (dirtyStartSec: number, dirtyEndSec: number) => void
  scheduleDraw: () => void
  storeRawWaveform: (filePath: string, data: RawWaveformData) => void
}

const HORIZONTAL_BROWSE_DEFERRED_RAW_TARGET_RATE = Math.min(PREVIEW_RAW_TARGET_RATE, 2400)

const toFloat32Array = (value: unknown) => {
  if (value instanceof Float32Array) return value
  if (value instanceof ArrayBuffer) return new Float32Array(value)
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    return new Float32Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / 4))
  }
  return new Float32Array(0)
}

const normalizeRawWaveformData = (value: unknown): RawWaveformData | null => {
  const payload =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as HorizontalBrowseRawWaveformPayload)
      : null
  if (!payload) return null

  const frames = Math.max(0, Number(payload.frames) || 0)
  const duration = Math.max(0, Number(payload.duration) || 0)
  const sampleRate = Math.max(0, Number(payload.sampleRate) || 0)
  const rate = Math.max(0, Number(payload.rate) || 0)
  const minLeft = toFloat32Array(payload.minLeft)
  const maxLeft = toFloat32Array(payload.maxLeft)
  const minRight = toFloat32Array(payload.minRight)
  const maxRight = toFloat32Array(payload.maxRight)
  if (!frames || !duration || !sampleRate || !rate) return null

  return {
    duration,
    sampleRate,
    rate,
    frames,
    minLeft: new Float32Array(minLeft),
    maxLeft: new Float32Array(maxLeft),
    minRight: new Float32Array(minRight),
    maxRight: new Float32Array(maxRight)
  }
}

export const useHorizontalBrowseRawWaveformStream = (
  options: UseHorizontalBrowseRawWaveformStreamOptions
) => {
  let rawStreamRequestId = ''
  let rawStreamStartedAt = 0
  let rawStreamChunkCount = 0

  const resolveRawLoadPriorityHint = () =>
    Math.max(0, Math.floor(Number(options.rawLoadPriorityHint()) || 0))

  const resolveWaveformTargetRate = (deferred: boolean) =>
    deferred ? HORIZONTAL_BROWSE_DEFERRED_RAW_TARGET_RATE : PREVIEW_RAW_TARGET_RATE

  const ensureRawWaveformCapacity = (
    requiredFrames: number,
    meta: { duration: number; sampleRate: number; rate: number }
  ) => {
    const nextFrames = Math.max(0, Math.floor(requiredFrames))
    if (!nextFrames) return

    const current = options.rawData.value
    if (!current) {
      options.rawData.value = {
        duration: meta.duration,
        sampleRate: meta.sampleRate,
        rate: meta.rate,
        frames: nextFrames,
        minLeft: new Float32Array(nextFrames),
        maxLeft: new Float32Array(nextFrames),
        minRight: new Float32Array(nextFrames),
        maxRight: new Float32Array(nextFrames)
      }
      options.mixxxData.value = createRawPlaceholderMixxxData(options.rawData.value)
      return
    }

    if (
      current.frames >= nextFrames &&
      current.sampleRate === meta.sampleRate &&
      current.rate === meta.rate &&
      Math.abs(current.duration - meta.duration) <= 0.0001
    ) {
      return
    }

    const grownFrames = Math.max(nextFrames, current.frames)
    const grow = (source: Float32Array) => {
      const target = new Float32Array(grownFrames)
      target.set(source.subarray(0, Math.min(source.length, grownFrames)))
      return target
    }

    options.rawData.value = {
      duration: Math.max(current.duration, meta.duration),
      sampleRate: meta.sampleRate,
      rate: meta.rate,
      frames: grownFrames,
      minLeft: grow(current.minLeft),
      maxLeft: grow(current.maxLeft),
      minRight: grow(current.minRight),
      maxRight: grow(current.maxRight)
    }
    options.mixxxData.value = createRawPlaceholderMixxxData(options.rawData.value)
  }

  const cancelRawWaveformStream = () => {
    if (!rawStreamRequestId) return
    window.electron.ipcRenderer.send('mixtape-waveform-raw:cancel-stream', {
      requestId: rawStreamRequestId
    })
    rawStreamRequestId = ''
    options.rawStreamActive.value = false
    options.clearStreamDrawScheduling()
  }

  const beginRawWaveformStream = (filePath: string, targetRate: number, requestToken: number) => {
    cancelRawWaveformStream()
    rawStreamRequestId = `horizontal-raw-${options.direction()}-${Date.now()}-${requestToken}`
    options.rawStreamActive.value = true
    rawStreamStartedAt = performance.now()
    rawStreamChunkCount = 0
    window.electron.ipcRenderer.send('mixtape-waveform-raw:stream', {
      requestId: rawStreamRequestId,
      filePath,
      priorityHint: resolveRawLoadPriorityHint(),
      targetRate,
      chunkFrames: 32768,
      expectedDurationSec: parseHorizontalBrowseDurationToSeconds(options.song()?.duration)
    })
  }

  const handleRawLoadPriorityHintChange = (
    priorityHint: number,
    previousPriorityHint: number | undefined
  ) => {
    if (!rawStreamRequestId) return
    if (priorityHint === previousPriorityHint) return
    window.electron.ipcRenderer.send('mixtape-waveform-raw:update-priority', {
      requestId: rawStreamRequestId,
      priorityHint
    })
  }

  const handleRawWaveformStreamChunk = (
    _event: unknown,
    payload?: HorizontalBrowseRawWaveformStreamChunkPayload
  ) => {
    if (String(payload?.requestId || '') !== rawStreamRequestId) return
    if (
      normalizeHorizontalBrowsePathKey(payload?.filePath) !==
      normalizeHorizontalBrowsePathKey(options.song()?.filePath)
    ) {
      return
    }

    const totalFrames = Math.max(0, Number(payload?.totalFrames) || 0)
    const duration = Math.max(0, Number(payload?.duration) || 0)
    const sampleRate = Math.max(0, Number(payload?.sampleRate) || 0)
    const rate = Math.max(0, Number(payload?.rate) || 0)
    const startFrame = Math.max(0, Number(payload?.startFrame) || 0)
    const frames = Math.max(0, Number(payload?.frames) || 0)
    if (!totalFrames || !duration || !sampleRate || !rate || !frames) return

    rawStreamChunkCount += 1
    ensureRawWaveformCapacity(Math.max(totalFrames, startFrame + frames), {
      duration,
      sampleRate,
      rate
    })

    const target = options.rawData.value
    if (!target) return

    const minLeftChunk = toFloat32Array(payload?.minLeft)
    const maxLeftChunk = toFloat32Array(payload?.maxLeft)
    const minRightChunk = toFloat32Array(payload?.minRight)
    const maxRightChunk = toFloat32Array(payload?.maxRight)
    const chunkFrames = Math.min(
      frames,
      minLeftChunk.length,
      maxLeftChunk.length,
      minRightChunk.length,
      maxRightChunk.length
    )
    if (!chunkFrames || startFrame + chunkFrames > target.minLeft.length) return

    target.minLeft.set(minLeftChunk.subarray(0, chunkFrames), startFrame)
    target.maxLeft.set(maxLeftChunk.subarray(0, chunkFrames), startFrame)
    target.minRight.set(minRightChunk.subarray(0, chunkFrames), startFrame)
    target.maxRight.set(maxRightChunk.subarray(0, chunkFrames), startFrame)

    if (rawStreamChunkCount === 1) {
      console.info('[horizontal-raw-stream] first chunk', {
        filePath: options.song()?.filePath,
        elapsedMs: Number((performance.now() - rawStreamStartedAt).toFixed(1)),
        totalFrames,
        frames: chunkFrames
      })
    }

    const dirtyStartSec = startFrame / rate
    const dirtyEndSec = (startFrame + chunkFrames) / rate
    options.scheduleRawStreamDirtyDraw(dirtyStartSec, dirtyEndSec)
  }

  const handleRawWaveformStreamDone = (
    _event: unknown,
    payload?: HorizontalBrowseRawWaveformStreamDonePayload
  ) => {
    if (String(payload?.requestId || '') !== rawStreamRequestId) return
    if (
      normalizeHorizontalBrowsePathKey(payload?.filePath) !==
      normalizeHorizontalBrowsePathKey(options.song()?.filePath)
    ) {
      return
    }

    rawStreamRequestId = ''
    options.previewLoading.value = false
    options.rawStreamActive.value = false
    console.info('[horizontal-raw-stream] done', {
      filePath: options.song()?.filePath,
      elapsedMs: Number((performance.now() - rawStreamStartedAt).toFixed(1)),
      chunkCount: rawStreamChunkCount,
      fromCache: payload?.fromCache === true,
      error: payload?.error
    })

    if (payload?.data) {
      const normalized = normalizeRawWaveformData(payload.data)
      if (normalized) {
        options.rawData.value = normalized
        options.mixxxData.value = createRawPlaceholderMixxxData(normalized)
      }
    }

    if (options.rawData.value) {
      const duration = Math.max(0, Number(payload?.duration) || 0)
      const totalFrames = Math.max(0, Number(payload?.totalFrames) || 0)
      if (duration > 0) {
        options.rawData.value.duration = duration
      }
      if (totalFrames > 0 && totalFrames <= options.rawData.value.frames) {
        options.rawData.value.frames = totalFrames
      }
    }

    if (options.rawData.value && options.song()?.filePath) {
      options.storeRawWaveform(String(options.song()?.filePath || '').trim(), options.rawData.value)
    }

    options.scheduleDraw()
  }

  const mount = () => {
    window.electron.ipcRenderer.on(
      'mixtape-waveform-raw:stream-chunk',
      handleRawWaveformStreamChunk
    )
    window.electron.ipcRenderer.on('mixtape-waveform-raw:stream-done', handleRawWaveformStreamDone)
  }

  const dispose = () => {
    cancelRawWaveformStream()
    window.electron.ipcRenderer.removeListener(
      'mixtape-waveform-raw:stream-chunk',
      handleRawWaveformStreamChunk
    )
    window.electron.ipcRenderer.removeListener(
      'mixtape-waveform-raw:stream-done',
      handleRawWaveformStreamDone
    )
  }

  return {
    resolveWaveformTargetRate,
    cancelRawWaveformStream,
    beginRawWaveformStream,
    handleRawLoadPriorityHintChange,
    mount,
    dispose
  }
}
