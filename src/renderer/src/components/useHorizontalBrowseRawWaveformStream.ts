import type { Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { createRawPlaceholderMixxxData } from '@renderer/components/mixtapeBeatAlignWaveformPlaceholder'
import { PREVIEW_RAW_TARGET_RATE } from '@renderer/components/MixtapeBeatAlignDialog.constants'
import { normalizeHorizontalBrowsePathKey } from '@renderer/components/horizontalBrowseWaveformDetail.utils'
import { parseHorizontalBrowseDurationToSeconds } from '@renderer/components/horizontalBrowseShellState'
import {
  resolveHorizontalBrowseWaveformTraceElapsedMs,
  sendHorizontalBrowseWaveformTrace
} from '@renderer/components/horizontalBrowseWaveformTrace'

type HorizontalBrowseDirection = 'up' | 'down'

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
  startSec?: number
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
  startSec?: unknown
  error?: string
  fromCache?: boolean
  streamed?: boolean
}

type PendingRawStreamChunkWork = {
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
  appliedFrames: number
}

type UseHorizontalBrowseRawWaveformStreamOptions = {
  song: () => ISongInfo | null
  direction: () => HorizontalBrowseDirection
  rawLoadPriorityHint: () => number | undefined
  bootstrapDurationSec: () => number | undefined
  playing: () => boolean
  currentSeconds: () => number | undefined
  visibleDurationSec: () => number
  previewLoading: Ref<boolean>
  rawStreamActive: Ref<boolean>
  rawData: Ref<RawWaveformData | null>
  mixxxData: Ref<MixxxWaveformData | null>
  clearStreamDrawScheduling: () => void
  scheduleRawStreamDirtyDraw: (dirtyStartSec: number, dirtyEndSec: number) => void
  scheduleDraw: () => void
  holdCurrentWaveformFrame: () => void
  storeRawWaveform: (filePath: string, data: RawWaveformData) => void
}

const HORIZONTAL_BROWSE_DEFERRED_RAW_TARGET_RATE = Math.min(PREVIEW_RAW_TARGET_RATE, 2400)
const HORIZONTAL_BROWSE_RAW_WAVEFORM_CHUNK_FRAMES = 32768
const HORIZONTAL_BROWSE_RAW_CHUNK_PROCESS_BUDGET_MS = 4
const HORIZONTAL_BROWSE_RAW_CHUNK_COPY_SLICE_FRAMES = 2048
const HORIZONTAL_BROWSE_RAW_CONTINUE_LOOKAHEAD_FACTOR = 0.8
const HORIZONTAL_BROWSE_RAW_VISIBLE_REDRAW_LEAD_FACTOR = 0.25
const HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_LEAD_FACTOR = 0.5

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
  const startSec = Math.max(0, Number(payload.startSec) || 0)
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
    startSec,
    loadedFrames: frames,
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
  let rawStreamStartSec = 0
  let pendingRawWaveformStoreFilePath = ''
  let pendingRawWaveformStoreData: RawWaveformData | null = null
  let pendingRawStreamDonePayload: HorizontalBrowseRawWaveformStreamDonePayload | null = null
  const pendingRawStreamChunks: PendingRawStreamChunkWork[] = []
  let rawChunkProcessTimer: ReturnType<typeof setTimeout> | null = null
  let rawChunkProcessRaf = 0
  let rawStreamFirstVisibleReadyLogged = false

  const traceHorizontalRawStream = (stage: string, payload?: Record<string, unknown>) => {
    sendHorizontalBrowseWaveformTrace('stream', stage, {
      deck: options.direction(),
      filePath: String(options.song()?.filePath || '').trim(),
      requestId: rawStreamRequestId,
      elapsedMs: resolveHorizontalBrowseWaveformTraceElapsedMs(rawStreamStartedAt),
      ...payload
    })
  }

  const resolveRawLoadPriorityHint = () =>
    Math.max(0, Math.floor(Number(options.rawLoadPriorityHint()) || 0))

  const resolveWaveformTargetRate = (deferred: boolean) =>
    deferred ? HORIZONTAL_BROWSE_DEFERRED_RAW_TARGET_RATE : PREVIEW_RAW_TARGET_RATE

  const hasSameRawWaveformMeta = (
    current: RawWaveformData,
    meta: { duration: number; sampleRate: number; rate: number; startSec: number }
  ) =>
    current.sampleRate === meta.sampleRate &&
    current.rate === meta.rate &&
    Math.abs((current.startSec ?? 0) - meta.startSec) <= 0.0001 &&
    Math.abs(current.duration - meta.duration) <= 0.0001

  const ensureRawWaveformCapacity = (
    requiredFrames: number,
    meta: { duration: number; sampleRate: number; rate: number; startSec: number }
  ) => {
    const nextFrames = Math.max(0, Math.floor(requiredFrames))
    if (!nextFrames) return

    const current = options.rawData.value
    if (!current || !hasSameRawWaveformMeta(current, meta)) {
      options.rawData.value = {
        duration: meta.duration,
        sampleRate: meta.sampleRate,
        rate: meta.rate,
        frames: nextFrames,
        startSec: meta.startSec,
        loadedFrames: 0,
        minLeft: new Float32Array(nextFrames),
        maxLeft: new Float32Array(nextFrames),
        minRight: new Float32Array(nextFrames),
        maxRight: new Float32Array(nextFrames)
      }
      options.mixxxData.value = createRawPlaceholderMixxxData(options.rawData.value)
      // 换 rawData ref 往往意味着 seek / 开始新 stream：此前画布可能已经被 hold 清空、
      // displayReady 已置 false，DOM 层也全部隐藏。必须主动触发一次整帧重绘，让 drawWaveform
      // 能在新数据一就绪时立即评估是否可画，否则只会走后续 dirty 增量路径——而 dirty 路径
      // 对"整块画面未就绪"状态的恢复不起作用（它只在 displayReady=true 时增量刷）。
      options.scheduleDraw()
      return
    }

    if (current.frames >= nextFrames) return

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
      startSec: meta.startSec,
      loadedFrames: current.loadedFrames,
      minLeft: grow(current.minLeft),
      maxLeft: grow(current.maxLeft),
      minRight: grow(current.minRight),
      maxRight: grow(current.maxRight)
    }
    options.mixxxData.value = createRawPlaceholderMixxxData(options.rawData.value)
  }

  const clearQueuedRawStreamPayloads = () => {
    pendingRawStreamChunks.length = 0
    pendingRawStreamDonePayload = null
    rawStreamFirstVisibleReadyLogged = false
    if (rawChunkProcessTimer) {
      clearTimeout(rawChunkProcessTimer)
      rawChunkProcessTimer = null
    }
    if (rawChunkProcessRaf) {
      cancelAnimationFrame(rawChunkProcessRaf)
      rawChunkProcessRaf = 0
    }
  }

  const clearPendingRawWaveformStore = () => {
    pendingRawWaveformStoreFilePath = ''
    pendingRawWaveformStoreData = null
  }

  const cancelRawWaveformStream = () => {
    if (!rawStreamRequestId) return
    traceHorizontalRawStream('raw-stream:cancel')
    window.electron.ipcRenderer.send('mixtape-waveform-raw:cancel-stream', {
      requestId: rawStreamRequestId
    })
    rawStreamRequestId = ''
    options.rawStreamActive.value = false
    options.clearStreamDrawScheduling()
    clearQueuedRawStreamPayloads()
    clearPendingRawWaveformStore()
  }

  const continueRawWaveformStream = (requestId: string) => {
    if (!requestId) return
    window.electron.ipcRenderer.send('mixtape-waveform-raw:continue-stream', { requestId })
  }

  const resolveSongDurationSec = () =>
    Math.max(
      0,
      Number(options.rawData.value?.duration) ||
        parseHorizontalBrowseDurationToSeconds(options.song()?.duration) ||
        0
    )

  const resolveRawWaveformBootstrapStartSec = (targetSec: number) => {
    const visibleDurationSec = Math.max(0.001, Number(options.visibleDurationSec()) || 0.001)
    return Math.max(
      0,
      targetSec - visibleDurationSec * HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_LEAD_FACTOR
    )
  }

  const beginRawWaveformStream = (
    filePath: string,
    targetRate: number,
    requestToken: number,
    startSec = 0
  ) => {
    clearQueuedRawStreamPayloads()
    cancelRawWaveformStream()
    rawStreamStartSec = Math.max(0, Number(startSec) || 0)
    rawStreamRequestId = `horizontal-raw-${options.direction()}-${Date.now()}-${requestToken}`
    options.rawStreamActive.value = true
    rawStreamStartedAt = performance.now()
    rawStreamChunkCount = 0
    rawStreamFirstVisibleReadyLogged = false
    const bootstrapDurationSec = Math.max(0, Number(options.bootstrapDurationSec()) || 0)
    const songDurationSec = resolveSongDurationSec()
    const remainingDurationSec = Math.max(0, songDurationSec - rawStreamStartSec)
    traceHorizontalRawStream('raw-stream:start', {
      requestToken,
      targetRate,
      startSec: rawStreamStartSec,
      priorityHint: resolveRawLoadPriorityHint(),
      expectedDurationSec: remainingDurationSec,
      bootstrapDurationSec
    })
    window.electron.ipcRenderer.send('mixtape-waveform-raw:stream', {
      requestId: rawStreamRequestId,
      filePath,
      priorityHint: resolveRawLoadPriorityHint(),
      targetRate,
      startSec: rawStreamStartSec,
      songDurationSec,
      chunkFrames: HORIZONTAL_BROWSE_RAW_WAVEFORM_CHUNK_FRAMES,
      expectedDurationSec: remainingDurationSec,
      bootstrapDurationSec
    })
  }

  const handleRawLoadPriorityHintChange = (
    priorityHint: number,
    previousPriorityHint: number | undefined
  ) => {
    if (!rawStreamRequestId) return
    if (priorityHint === previousPriorityHint) return
    traceHorizontalRawStream('raw-stream:update-priority', {
      priorityHint,
      previousPriorityHint
    })
    window.electron.ipcRenderer.send('mixtape-waveform-raw:update-priority', {
      requestId: rawStreamRequestId,
      priorityHint
    })
  }

  const flushDeferredRawWaveformStore = () => {
    if (!pendingRawWaveformStoreData || !pendingRawWaveformStoreFilePath) return
    if (Math.max(0, Number(pendingRawWaveformStoreData.startSec) || 0) > 0.0001) {
      clearPendingRawWaveformStore()
      return
    }
    options.storeRawWaveform(pendingRawWaveformStoreFilePath, pendingRawWaveformStoreData)
    clearPendingRawWaveformStore()
  }

  const restartRawWaveformStreamAt = (targetSec: number) => {
    const filePath = String(options.song()?.filePath || '').trim()
    if (!filePath) return false
    const targetStartSec = resolveRawWaveformBootstrapStartSec(targetSec)
    if (!options.rawData.value) {
      traceHorizontalRawStream('raw-stream:seek-restart:skip', {
        reason: 'no-raw-data',
        targetSec,
        targetStartSec
      })
      return false
    }
    const rate = Math.max(0, Number(options.rawData.value?.rate) || 0)
    const loadedFrames = Math.max(
      0,
      Number(options.rawData.value?.loadedFrames ?? options.rawData.value?.frames) || 0
    )
    const loadedStartSec = rawStreamStartSec
    const loadedEndSec = rate > 0 ? loadedStartSec + loadedFrames / rate : loadedStartSec
    const visibleDurationSec = Math.max(0.001, Number(options.visibleDurationSec()) || 0.001)
    const visibleStartSec = Math.max(0, targetSec - visibleDurationSec * 0.5)
    const visibleEndSec = targetSec + visibleDurationSec * 0.5
    const hasCoverage =
      Boolean(options.rawData.value) &&
      visibleStartSec >= loadedStartSec &&
      visibleEndSec <= loadedEndSec
    traceHorizontalRawStream('raw-stream:seek-restart:check', {
      targetSec,
      targetStartSec,
      loadedStartSec,
      loadedEndSec,
      visibleStartSec,
      visibleEndSec,
      hasCoverage
    })
    if (hasCoverage) return false
    options.holdCurrentWaveformFrame()
    beginRawWaveformStream(filePath, resolveWaveformTargetRate(false), Date.now(), targetStartSec)
    traceHorizontalRawStream('raw-stream:seek-restart:started', {
      targetSec,
      targetStartSec
    })
    return true
  }

  const shouldScheduleRawStreamRedraw = (dirtyStartSec: number, dirtyEndSec: number) => {
    if (!options.playing()) return true
    const currentSec = Math.max(0, Number(options.currentSeconds()) || 0)
    const visibleDurationSec = Math.max(0.001, Number(options.visibleDurationSec()) || 0.001)
    const halfVisible = visibleDurationSec * 0.5
    const redrawLeadSec = visibleDurationSec * HORIZONTAL_BROWSE_RAW_VISIBLE_REDRAW_LEAD_FACTOR
    const viewStartSec = Math.max(0, currentSec - halfVisible)
    const viewEndSec = currentSec + halfVisible
    return dirtyEndSec >= viewStartSec && dirtyStartSec <= viewEndSec + redrawLeadSec
  }

  const resolvePlaybackBootstrapTargetLoadedFrames = (rate: number, startSec: number) => {
    if (!options.playing()) return 0
    if (rawStreamFirstVisibleReadyLogged) return 0
    // 播放已经开始但首屏还没真正画出来时，优先把"当前可视窗口右半边"需要的 raw 数据
    // 一次性补齐，避免 2048 帧一刀地零碎写入，导致首帧在 await/live 之间来回切几次。
    const currentSec = Math.max(0, Number(options.currentSeconds()) || 0)
    const visibleDurationSec = Math.max(0.001, Number(options.visibleDurationSec()) || 0.001)
    const desiredLoadedEndSec = currentSec + visibleDurationSec * 0.5
    return Math.max(0, Math.ceil(Math.max(0, desiredLoadedEndSec - startSec) * rate))
  }

  const buildPendingRawStreamChunkWork = (
    payload: HorizontalBrowseRawWaveformStreamChunkPayload
  ): PendingRawStreamChunkWork | null => {
    const totalFrames = Math.max(0, Number(payload.totalFrames) || 0)
    const duration = Math.max(0, Number(payload.duration) || 0)
    const sampleRate = Math.max(0, Number(payload.sampleRate) || 0)
    const rate = Math.max(0, Number(payload.rate) || 0)
    const startSec = Math.max(0, Number(payload.startSec) || rawStreamStartSec)
    const startFrame = Math.max(0, Number(payload.startFrame) || 0)
    const frames = Math.max(0, Number(payload.frames) || 0)
    if (!totalFrames || !duration || !sampleRate || !rate || !frames) return null

    const minLeft = toFloat32Array(payload.minLeft)
    const maxLeft = toFloat32Array(payload.maxLeft)
    const minRight = toFloat32Array(payload.minRight)
    const maxRight = toFloat32Array(payload.maxRight)
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
      appliedFrames: 0
    }
  }

  const finalizePendingRawStreamChunkWork = (work: PendingRawStreamChunkWork) => {
    rawStreamChunkCount += 1
    if (rawStreamChunkCount === 1) {
      options.previewLoading.value = false
      traceHorizontalRawStream('raw-stream:first-chunk', {
        startSec: work.startSec,
        startFrame: work.startFrame,
        frames: work.chunkFrames,
        totalFrames: work.totalFrames,
        duration: work.duration,
        sampleRate: work.sampleRate,
        rate: work.rate
      })
    }

    if (!options.playing() && options.rawData.value) {
      options.rawData.value = {
        ...options.rawData.value
      }
    }

    const dirtyStartSec = work.startSec + work.startFrame / work.rate
    const dirtyEndSec = work.startSec + (work.startFrame + work.chunkFrames) / work.rate
    if (shouldScheduleRawStreamRedraw(dirtyStartSec, dirtyEndSec)) {
      options.scheduleRawStreamDirtyDraw(dirtyStartSec, dirtyEndSec)
    }
  }

  const processPendingRawStreamChunkWork = (work: PendingRawStreamChunkWork) => {
    ensureRawWaveformCapacity(Math.max(work.totalFrames, work.startFrame + work.chunkFrames), {
      duration: work.duration,
      sampleRate: work.sampleRate,
      rate: work.rate,
      startSec: work.startSec
    })

    const target = options.rawData.value
    if (!target) return true

    const remainingFrames = work.chunkFrames - work.appliedFrames
    if (remainingFrames <= 0) return true

    const playbackBootstrapTargetLoadedFrames = Math.min(
      work.totalFrames,
      resolvePlaybackBootstrapTargetLoadedFrames(work.rate, work.startSec)
    )
    const loadedFrames = Math.max(
      Math.max(0, Number(target.loadedFrames) || 0),
      work.startFrame + work.appliedFrames
    )
    const bootstrapCopyFrames = Math.max(0, playbackBootstrapTargetLoadedFrames - loadedFrames)
    const copyFrames = Math.min(
      remainingFrames,
      Math.max(HORIZONTAL_BROWSE_RAW_CHUNK_COPY_SLICE_FRAMES, bootstrapCopyFrames)
    )
    const sourceStart = work.appliedFrames
    const sourceEnd = sourceStart + copyFrames
    const targetStart = work.startFrame + sourceStart
    const targetEnd = targetStart + copyFrames
    if (targetEnd > target.minLeft.length) return true

    target.minLeft.set(work.minLeft.subarray(sourceStart, sourceEnd), targetStart)
    target.maxLeft.set(work.maxLeft.subarray(sourceStart, sourceEnd), targetStart)
    target.minRight.set(work.minRight.subarray(sourceStart, sourceEnd), targetStart)
    target.maxRight.set(work.maxRight.subarray(sourceStart, sourceEnd), targetStart)
    work.appliedFrames = sourceEnd
    target.loadedFrames = Math.max(Number(target.loadedFrames) || 0, targetStart + copyFrames)

    const dirtyStartSec = work.startSec + targetStart / work.rate
    const dirtyEndSec = work.startSec + targetEnd / work.rate
    if (shouldScheduleRawStreamRedraw(dirtyStartSec, dirtyEndSec)) {
      if (!rawStreamFirstVisibleReadyLogged) {
        rawStreamFirstVisibleReadyLogged = true
        traceHorizontalRawStream('raw-stream:first-visible-ready', {
          startSec: work.startSec,
          dirtyStartSec,
          dirtyEndSec,
          loadedFrames: target.loadedFrames,
          chunkFrames: work.chunkFrames
        })
      }
      options.scheduleRawStreamDirtyDraw(dirtyStartSec, dirtyEndSec)
    }

    return work.appliedFrames >= work.chunkFrames
  }

  const applyRawWaveformStreamChunk = (payload?: HorizontalBrowseRawWaveformStreamChunkPayload) => {
    if (!payload) return
    if (String(payload?.requestId || '') !== rawStreamRequestId) return
    if (
      normalizeHorizontalBrowsePathKey(payload?.filePath) !==
      normalizeHorizontalBrowsePathKey(options.song()?.filePath)
    ) {
      return
    }
    const work = buildPendingRawStreamChunkWork(payload)
    if (!work) return
    pendingRawStreamChunks.push(work)
  }

  const applyRawWaveformStreamDone = (payload?: HorizontalBrowseRawWaveformStreamDonePayload) => {
    if (String(payload?.requestId || '') !== rawStreamRequestId) return
    if (
      normalizeHorizontalBrowsePathKey(payload?.filePath) !==
      normalizeHorizontalBrowsePathKey(options.song()?.filePath)
    ) {
      return
    }

    const completedRequestId = rawStreamRequestId
    rawStreamRequestId = ''
    options.previewLoading.value = false
    options.rawStreamActive.value = false
    traceHorizontalRawStream('raw-stream:done', {
      requestId: completedRequestId,
      chunkCount: rawStreamChunkCount,
      fromCache: payload?.fromCache === true,
      streamed: payload?.streamed === true,
      error: payload?.error
    })

    if (payload?.data) {
      const normalized = normalizeRawWaveformData(payload.data)
      if (normalized) {
        normalized.startSec = Math.max(0, Number(payload?.startSec) || rawStreamStartSec)
        options.rawData.value = normalized
        options.mixxxData.value = createRawPlaceholderMixxxData(normalized)
      }
    }

    if (options.rawData.value) {
      const duration = Math.max(0, Number(payload?.duration) || 0)
      const totalFrames = Math.max(0, Number(payload?.totalFrames) || 0)
      const startSec = Math.max(0, Number(payload?.startSec) || rawStreamStartSec)
      const current = options.rawData.value
      if (duration > 0) {
        current.duration = duration
      }
      current.startSec = startSec
      if (totalFrames > 0 && totalFrames <= current.frames) {
        current.frames = totalFrames
      }
      current.loadedFrames =
        totalFrames > 0 ? totalFrames : (current.loadedFrames ?? current.frames)
      if (!options.playing()) {
        options.rawData.value = {
          ...current
        }
      }
    }

    if (options.rawData.value && options.song()?.filePath) {
      const filePath = String(options.song()?.filePath || '').trim()
      const isFullSongRaw = Math.max(0, Number(options.rawData.value.startSec) || 0) <= 0.0001
      if (options.playing()) {
        pendingRawWaveformStoreFilePath = filePath
        pendingRawWaveformStoreData = isFullSongRaw ? options.rawData.value : null
      } else if (isFullSongRaw) {
        options.storeRawWaveform(filePath, options.rawData.value)
        clearPendingRawWaveformStore()
      } else {
        clearPendingRawWaveformStore()
      }
    }

    if (!options.playing()) {
      options.scheduleDraw()
    }
  }

  const flushQueuedRawStreamPayloads = () => {
    rawChunkProcessTimer = null
    rawChunkProcessRaf = 0
    const startedAt = performance.now()
    while (pendingRawStreamChunks.length > 0) {
      const nextWork = pendingRawStreamChunks[0]
      if (!nextWork) break
      const completed = processPendingRawStreamChunkWork(nextWork)
      if (completed) {
        pendingRawStreamChunks.shift()
        finalizePendingRawStreamChunkWork(nextWork)
      }
      if (performance.now() - startedAt >= HORIZONTAL_BROWSE_RAW_CHUNK_PROCESS_BUDGET_MS) {
        break
      }
    }

    if (pendingRawStreamChunks.length > 0) {
      scheduleQueuedRawStreamPayloadFlush()
      return
    }

    if (pendingRawStreamDonePayload) {
      const donePayload = pendingRawStreamDonePayload
      pendingRawStreamDonePayload = null
      applyRawWaveformStreamDone(donePayload)
    }
  }

  const scheduleQueuedRawStreamPayloadFlush = () => {
    if (rawChunkProcessTimer || rawChunkProcessRaf) return
    rawChunkProcessTimer = setTimeout(() => {
      rawChunkProcessTimer = null
      rawChunkProcessRaf = requestAnimationFrame(() => {
        flushQueuedRawStreamPayloads()
      })
    }, 0)
  }

  const handleRawWaveformStreamChunk = (
    _event: unknown,
    payload?: HorizontalBrowseRawWaveformStreamChunkPayload
  ) => {
    if (!payload) return
    if (String(payload?.requestId || '') !== rawStreamRequestId) return
    if (
      normalizeHorizontalBrowsePathKey(payload?.filePath) !==
      normalizeHorizontalBrowsePathKey(options.song()?.filePath)
    ) {
      return
    }
    applyRawWaveformStreamChunk(payload)
    scheduleQueuedRawStreamPayloadFlush()
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
    if (pendingRawStreamChunks.length > 0 || rawChunkProcessTimer || rawChunkProcessRaf) {
      pendingRawStreamDonePayload = payload || null
      scheduleQueuedRawStreamPayloadFlush()
      return
    }
    applyRawWaveformStreamDone(payload)
  }

  const maybeContinueRawWaveformStream = () => {
    if (!rawStreamRequestId || !options.rawStreamActive.value || !options.rawData.value) return
    if (!options.playing()) return
    const rate = Math.max(0, Number(options.rawData.value.rate) || 0)
    if (!rate) return
    const currentSec = Math.max(0, Number(options.currentSeconds()) || 0)
    const loadedFrames = Math.max(
      0,
      Number(options.rawData.value.loadedFrames ?? options.rawData.value.frames) || 0
    )
    const loadedEndSec = rawStreamStartSec + loadedFrames / rate
    const visibleDurationSec = Math.max(0.001, Number(options.visibleDurationSec()) || 0.001)
    const desiredLoadedEndSec =
      currentSec + visibleDurationSec * HORIZONTAL_BROWSE_RAW_CONTINUE_LOOKAHEAD_FACTOR
    if (loadedEndSec >= desiredLoadedEndSec) return
    continueRawWaveformStream(rawStreamRequestId)
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
    clearQueuedRawStreamPayloads()
    clearPendingRawWaveformStore()
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
    maybeContinueRawWaveformStream,
    restartRawWaveformStreamAt,
    flushDeferredRawWaveformStore,
    handleRawLoadPriorityHintChange,
    mount,
    dispose
  }
}
