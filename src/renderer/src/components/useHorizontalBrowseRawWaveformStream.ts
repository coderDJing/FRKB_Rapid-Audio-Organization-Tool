import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import type { HorizontalBrowseDetailLiveCanvasRawChunk } from '@renderer/workers/horizontalBrowseDetailLiveCanvas.types'
import { createRawPlaceholderMixxxData } from '@renderer/components/mixtapeBeatAlignWaveformPlaceholder'
import { PREVIEW_RAW_TARGET_RATE } from '@renderer/components/MixtapeBeatAlignDialog.constants'
import { normalizeHorizontalBrowsePathKey } from '@renderer/components/horizontalBrowseWaveformDetail.utils'
import { parseHorizontalBrowseDurationToSeconds } from '@renderer/components/horizontalBrowseShellState'
import {
  resolveHorizontalBrowseWaveformTraceElapsedMs,
  sendHorizontalBrowseWaveformTrace
} from '@renderer/components/horizontalBrowseWaveformTrace'
import {
  HORIZONTAL_BROWSE_RAW_CHUNK_COPY_SLICE_FRAMES,
  HORIZONTAL_BROWSE_RAW_CHUNK_PROCESS_BUDGET_MS,
  HORIZONTAL_BROWSE_RAW_CONTINUE_LOOKAHEAD_FACTOR,
  HORIZONTAL_BROWSE_RAW_CONTINUE_TIMEOUT_MS,
  HORIZONTAL_BROWSE_RAW_INITIAL_CHUNK_MAX_RETRIES,
  HORIZONTAL_BROWSE_RAW_INITIAL_CHUNK_TIMEOUT_MS,
  HORIZONTAL_BROWSE_RAW_PLAYING_COPY_SLICE_FRAMES,
  HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_LEAD_FACTOR,
  HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_MIN_SEC,
  HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_OVERSCAN_FACTOR,
  HORIZONTAL_BROWSE_RAW_VIEWPORT_OVERSCAN_FACTOR,
  HORIZONTAL_BROWSE_RAW_VIEWPORT_RESTART_GAP_FACTOR,
  HORIZONTAL_BROWSE_RAW_VISIBLE_REDRAW_LEAD_FACTOR,
  HORIZONTAL_BROWSE_RAW_WAVEFORM_CHUNK_FRAMES,
  normalizeRawWaveformData,
  toFloat32Array,
  type HorizontalBrowseRawWaveformStreamChunkPayload,
  type HorizontalBrowseRawWaveformStreamDonePayload,
  type PendingRawStreamChunkWork,
  type RawWaveformStreamStartOptions,
  type UseHorizontalBrowseRawWaveformStreamOptions
} from '@renderer/components/horizontalBrowseRawWaveformStreamTypes'

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
  let rawStreamBootstrapDurationSec = 0
  let rawStreamContinuePending = false
  let rawStreamInitialRetryCount = 0
  let rawStreamContinueStartedAt = 0
  let rawStreamWatchdogTimer: ReturnType<typeof setTimeout> | null = null

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

  const resolveDeckKey = () => (options.direction() === 'up' ? 'top' : 'bottom')

  const resolveProtectsPlayback = () => options.playing() === true

  const resolveChunkProcessBudgetMs = () => HORIZONTAL_BROWSE_RAW_CHUNK_PROCESS_BUDGET_MS

  const resolveChunkCopySliceFrames = () => HORIZONTAL_BROWSE_RAW_CHUNK_COPY_SLICE_FRAMES

  const resolveMaxChunkCopyFrames = (bootstrapCopyFrames: number) =>
    options.playing()
      ? HORIZONTAL_BROWSE_RAW_PLAYING_COPY_SLICE_FRAMES
      : Math.max(resolveChunkCopySliceFrames(), bootstrapCopyFrames)

  const shouldKeepMainThreadRawArrays = () => true

  const resolveStreamChunkFrames = () => HORIZONTAL_BROWSE_RAW_WAVEFORM_CHUNK_FRAMES

  const resolveWaveformTargetRate = (_deferred: boolean) => PREVIEW_RAW_TARGET_RATE

  const resolveSeekBootstrapDurationSec = () => {
    const visibleDurationSec = Math.max(0.001, Number(options.visibleDurationSec()) || 0.001)
    return Math.max(
      HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_MIN_SEC,
      visibleDurationSec * HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_OVERSCAN_FACTOR
    )
  }

  const resolveTimeBasisOffsetSec = () =>
    Math.max(0, Number(options.timeBasisOffsetMs()) || 0) / 1000

  const resolveAudioSecToTimelineSec = (audioSec: number) =>
    Math.max(0, (Number(audioSec) || 0) + resolveTimeBasisOffsetSec())

  const resolveAudioRangeStartSecToTimelineSec = (audioSec: number) => {
    const safeAudioSec = Math.max(0, Number(audioSec) || 0)
    if (safeAudioSec <= 0.0001) return 0
    return resolveAudioSecToTimelineSec(safeAudioSec)
  }

  const resolveTimelineSecToAudioSec = (timelineSec: number) =>
    Math.max(0, (Number(timelineSec) || 0) - resolveTimeBasisOffsetSec())

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
      const rawArrayFrames = shouldKeepMainThreadRawArrays() ? nextFrames : 0
      options.rawData.value = {
        duration: meta.duration,
        sampleRate: meta.sampleRate,
        rate: meta.rate,
        frames: nextFrames,
        startSec: meta.startSec,
        loadedFrames: 0,
        minLeft: new Float32Array(rawArrayFrames),
        maxLeft: new Float32Array(rawArrayFrames),
        minRight: new Float32Array(rawArrayFrames),
        maxRight: new Float32Array(rawArrayFrames)
      }
      options.mixxxData.value = createRawPlaceholderMixxxData(options.rawData.value)
      options.resetLiveWaveformRaw({
        duration: meta.duration,
        sampleRate: meta.sampleRate,
        rate: meta.rate,
        frames: nextFrames,
        startSec: meta.startSec,
        loadedFrames: 0
      })
      // 换 rawData ref 往往意味着 seek / 开始新 stream：必须主动触发一次整帧重绘，
      // 让 drawWaveform 在新数据一就绪时立即评估是画局部高清，还是继续保持波形层黑屏。
      options.scheduleDraw()
      return
    }

    const keepMainThreadRawArrays = shouldKeepMainThreadRawArrays()
    if (
      current.frames >= nextFrames &&
      (!keepMainThreadRawArrays || current.minLeft.length >= nextFrames)
    ) {
      return
    }

    const grownFrames = Math.max(nextFrames, current.frames)
    const grownArrayFrames = keepMainThreadRawArrays ? grownFrames : current.minLeft.length
    const grow = (source: Float32Array) => {
      const target = new Float32Array(grownArrayFrames)
      target.set(source.subarray(0, Math.min(source.length, grownArrayFrames)))
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
    options.ensureLiveWaveformRawCapacity({
      duration: Math.max(current.duration, meta.duration),
      sampleRate: meta.sampleRate,
      rate: meta.rate,
      frames: grownFrames,
      startSec: meta.startSec,
      loadedFrames: current.loadedFrames
    })
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

  const clearRawStreamWatchdog = () => {
    if (!rawStreamWatchdogTimer) return
    clearTimeout(rawStreamWatchdogTimer)
    rawStreamWatchdogTimer = null
  }

  const recoverStalledInitialStream = (viewportAnchorSec: number) => {
    if (!rawStreamRequestId || !options.rawStreamActive.value || rawStreamChunkCount > 0) {
      return false
    }
    const elapsedMs = rawStreamStartedAt > 0 ? performance.now() - rawStreamStartedAt : 0
    if (elapsedMs < HORIZONTAL_BROWSE_RAW_INITIAL_CHUNK_TIMEOUT_MS) return false
    if (rawStreamInitialRetryCount >= HORIZONTAL_BROWSE_RAW_INITIAL_CHUNK_MAX_RETRIES) {
      return false
    }
    return restartRawWaveformStreamAt(viewportAnchorSec, false, {
      forceRestart: true,
      forceLiveDecode: true,
      initialRetryCount: rawStreamInitialRetryCount + 1,
      bootstrapDurationSec: resolveSeekBootstrapDurationSec()
    })
  }

  const recoverStalledContinue = () => {
    if (!rawStreamContinuePending) return false
    const elapsedMs =
      rawStreamContinueStartedAt > 0 ? performance.now() - rawStreamContinueStartedAt : 0
    if (elapsedMs < HORIZONTAL_BROWSE_RAW_CONTINUE_TIMEOUT_MS) return false
    rawStreamContinuePending = false
    rawStreamContinueStartedAt = 0
    return true
  }

  const runRawStreamWatchdog = () => {
    rawStreamWatchdogTimer = null
    if (!rawStreamRequestId || !options.rawStreamActive.value) return
    const anchorSec = Math.max(
      0,
      Number(options.playing() ? options.currentSeconds() : options.viewportAnchorSec()) || 0
    )
    if (recoverStalledInitialStream(anchorSec)) return
    if (recoverStalledContinue()) {
      maybeContinueRawWaveformStream(anchorSec)
      return
    }
    if (rawStreamChunkCount === 0 || rawStreamContinuePending) {
      scheduleRawStreamWatchdog()
    }
  }

  const scheduleRawStreamWatchdog = () => {
    if (rawStreamWatchdogTimer) return
    rawStreamWatchdogTimer = setTimeout(runRawStreamWatchdog, 250)
  }

  const cancelRawWaveformStream = () => {
    if (!rawStreamRequestId) return
    clearRawStreamWatchdog()
    traceHorizontalRawStream('raw-stream:cancel')
    window.electron.ipcRenderer.send('mixtape-waveform-raw:cancel-stream', {
      requestId: rawStreamRequestId
    })
    rawStreamRequestId = ''
    rawStreamContinuePending = false
    rawStreamContinueStartedAt = 0
    options.rawStreamActive.value = false
    options.clearStreamDrawScheduling()
    clearQueuedRawStreamPayloads()
    clearPendingRawWaveformStore()
  }

  const continueRawWaveformStream = (requestId: string) => {
    if (!requestId) return false
    if (rawStreamContinuePending) return false
    rawStreamContinuePending = true
    rawStreamContinueStartedAt = performance.now()
    window.electron.ipcRenderer.send('mixtape-waveform-raw:continue-stream', { requestId })
    scheduleRawStreamWatchdog()
    return true
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
    startSec = 0,
    startOptions: RawWaveformStreamStartOptions = {}
  ) => {
    clearQueuedRawStreamPayloads()
    cancelRawWaveformStream()
    rawStreamStartSec = Math.max(0, Number(startSec) || 0)
    rawStreamRequestId = `horizontal-raw-${options.direction()}-${Date.now()}-${requestToken}`
    options.rawStreamActive.value = true
    rawStreamStartedAt = performance.now()
    rawStreamChunkCount = 0
    rawStreamFirstVisibleReadyLogged = false
    rawStreamContinuePending = false
    rawStreamContinueStartedAt = 0
    rawStreamInitialRetryCount = Math.max(
      0,
      Math.floor(Number(startOptions.initialRetryCount) || 0)
    )
    const bootstrapDurationSec = Math.max(
      0,
      Number(startOptions.bootstrapDurationSec ?? options.bootstrapDurationSec()) || 0
    )
    rawStreamBootstrapDurationSec = bootstrapDurationSec
    const songDurationSec = resolveSongDurationSec()
    const remainingDurationSec = Math.max(0, songDurationSec - rawStreamStartSec)
    traceHorizontalRawStream('raw-stream:start', {
      requestToken,
      targetRate,
      startSec: rawStreamStartSec,
      deckKey: resolveDeckKey(),
      priorityHint: resolveRawLoadPriorityHint(),
      protectsPlayback: resolveProtectsPlayback(),
      expectedDurationSec: remainingDurationSec,
      bootstrapDurationSec
    })
    window.electron.ipcRenderer.send('mixtape-waveform-raw:stream', {
      requestId: rawStreamRequestId,
      filePath,
      deckKey: resolveDeckKey(),
      protectsPlayback: resolveProtectsPlayback(),
      priorityHint: resolveRawLoadPriorityHint(),
      targetRate,
      startSec: rawStreamStartSec,
      songDurationSec,
      chunkFrames: resolveStreamChunkFrames(),
      expectedDurationSec: remainingDurationSec,
      bootstrapDurationSec,
      forceLiveDecode: startOptions.forceLiveDecode === true
    })
    scheduleRawStreamWatchdog()
  }

  const handleRawLoadPriorityHintChange = (
    priorityHint: number,
    previousPriorityHint: number | undefined
  ) => {
    if (!rawStreamRequestId) return
    if (priorityHint === previousPriorityHint) return
    traceHorizontalRawStream('raw-stream:update-priority', {
      priorityHint,
      previousPriorityHint,
      protectsPlayback: resolveProtectsPlayback()
    })
    window.electron.ipcRenderer.send('mixtape-waveform-raw:update-priority', {
      requestId: rawStreamRequestId,
      priorityHint,
      protectsPlayback: resolveProtectsPlayback()
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

  const resolveLoadedTimelineRange = () => {
    const current = options.rawData.value
    const rate = Math.max(0, Number(current?.rate) || 0)
    const loadedFrames = Math.max(0, Number(current?.loadedFrames ?? current?.frames) || 0)
    const rawStartSec = Math.max(0, Number(current?.startSec) || rawStreamStartSec)
    const loadedStartSec = resolveAudioRangeStartSecToTimelineSec(rawStartSec)
    const loadedEndSec =
      rate > 0 ? resolveAudioSecToTimelineSec(rawStartSec + loadedFrames / rate) : loadedStartSec
    return {
      rate,
      loadedFrames,
      loadedStartSec,
      loadedEndSec
    }
  }

  const resolveVisibleTimelineRange = (anchorSec: number, overscanFactor = 0) => {
    const visibleDurationSec = Math.max(0.001, Number(options.visibleDurationSec()) || 0.001)
    const halfVisible = visibleDurationSec * 0.5
    const overscanSec = Math.max(0, visibleDurationSec * overscanFactor)
    const songDurationSec = resolveSongDurationSec()
    const visibleStartSec = Math.max(0, anchorSec - halfVisible - overscanSec)
    const visibleEndSec =
      songDurationSec > 0
        ? Math.min(songDurationSec, anchorSec + halfVisible + overscanSec)
        : anchorSec + halfVisible + overscanSec
    return {
      visibleDurationSec,
      visibleStartSec,
      visibleEndSec
    }
  }

  const isCurrentRawCoveringVisibleRange = (anchorSec: number, overscanFactor = 0) => {
    const current = options.rawData.value
    if (!current) return false
    const { loadedStartSec, loadedEndSec } = resolveLoadedTimelineRange()
    const { visibleStartSec, visibleEndSec } = resolveVisibleTimelineRange(
      anchorSec,
      overscanFactor
    )
    return visibleStartSec >= loadedStartSec && visibleEndSec <= loadedEndSec
  }

  const resolveActiveInitialStreamTimelineRange = () => {
    if (!rawStreamRequestId || !options.rawStreamActive.value || rawStreamChunkCount > 0) {
      return null
    }
    const startSec = resolveAudioRangeStartSecToTimelineSec(rawStreamStartSec)
    return {
      startSec,
      endSec: startSec + Math.max(rawStreamBootstrapDurationSec, 0.001)
    }
  }

  const isActiveInitialStreamCoveringVisibleCore = (anchorSec: number) => {
    const activeRange = resolveActiveInitialStreamTimelineRange()
    if (!activeRange) return false
    const { visibleStartSec, visibleEndSec } = resolveVisibleTimelineRange(anchorSec)
    return (
      visibleStartSec >= activeRange.startSec - 0.001 && visibleEndSec <= activeRange.endSec + 0.001
    )
  }

  const restartRawWaveformStreamAt = (
    targetSec: number,
    holdFrame = true,
    startOptions: RawWaveformStreamStartOptions & { forceRestart?: boolean } = {}
  ) => {
    const filePath = String(options.song()?.filePath || '').trim()
    if (!filePath) return false
    const targetStartTimelineSec = resolveRawWaveformBootstrapStartSec(targetSec)
    const targetStartSec = resolveTimelineSecToAudioSec(targetStartTimelineSec)
    const { loadedStartSec, loadedEndSec } = resolveLoadedTimelineRange()
    const { visibleStartSec, visibleEndSec } = resolveVisibleTimelineRange(targetSec)
    const hasCoverage = isCurrentRawCoveringVisibleRange(targetSec)
    traceHorizontalRawStream('raw-stream:seek-restart:check', {
      targetSec,
      targetStartSec,
      targetStartTimelineSec,
      loadedStartSec,
      loadedEndSec,
      visibleStartSec,
      visibleEndSec,
      hasCoverage
    })
    if (hasCoverage) return false
    if (!startOptions.forceRestart && isActiveInitialStreamCoveringVisibleCore(targetSec)) {
      return false
    }
    if (holdFrame) {
      options.holdCurrentWaveformFrame()
    }
    beginRawWaveformStream(filePath, resolveWaveformTargetRate(false), Date.now(), targetStartSec, {
      bootstrapDurationSec: startOptions.bootstrapDurationSec ?? resolveSeekBootstrapDurationSec(),
      forceLiveDecode: startOptions.forceLiveDecode,
      initialRetryCount: startOptions.initialRetryCount
    })
    traceHorizontalRawStream('raw-stream:seek-restart:started', {
      targetSec,
      targetStartSec,
      targetStartTimelineSec,
      holdFrame
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
    const desiredLoadedEndAudioSec = resolveTimelineSecToAudioSec(desiredLoadedEndSec)
    return Math.max(0, Math.ceil(Math.max(0, desiredLoadedEndAudioSec - startSec) * rate))
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
    rawStreamContinuePending = false
    rawStreamContinueStartedAt = 0
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

    const dirtyStartSec = resolveAudioRangeStartSecToTimelineSec(
      work.startSec + work.startFrame / work.rate
    )
    const dirtyEndSec = resolveAudioSecToTimelineSec(
      work.startSec + (work.startFrame + work.chunkFrames) / work.rate
    )
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
    const keepMainThreadRawArrays = shouldKeepMainThreadRawArrays()
    const loadedFrames = Math.max(
      Math.max(0, Number(target.loadedFrames) || 0),
      work.startFrame + work.appliedFrames
    )
    const bootstrapCopyFrames = Math.max(0, playbackBootstrapTargetLoadedFrames - loadedFrames)
    const copyFrames = Math.min(
      remainingFrames,
      keepMainThreadRawArrays ? resolveMaxChunkCopyFrames(bootstrapCopyFrames) : remainingFrames
    )
    const sourceStart = work.appliedFrames
    const sourceEnd = sourceStart + copyFrames
    const targetStart = work.startFrame + sourceStart
    const targetEnd = targetStart + copyFrames
    if (keepMainThreadRawArrays && targetEnd > target.minLeft.length) return true

    if (keepMainThreadRawArrays) {
      target.minLeft.set(work.minLeft.subarray(sourceStart, sourceEnd), targetStart)
      target.maxLeft.set(work.maxLeft.subarray(sourceStart, sourceEnd), targetStart)
      target.minRight.set(work.minRight.subarray(sourceStart, sourceEnd), targetStart)
      target.maxRight.set(work.maxRight.subarray(sourceStart, sourceEnd), targetStart)
    }
    work.appliedFrames = sourceEnd
    target.loadedFrames = Math.max(Number(target.loadedFrames) || 0, targetStart + copyFrames)
    const liveChunk: HorizontalBrowseDetailLiveCanvasRawChunk = {
      duration: target.duration,
      sampleRate: target.sampleRate,
      rate: target.rate,
      frames: target.frames,
      startSec: Math.max(0, Number(target.startSec) || work.startSec),
      loadedFrames: target.loadedFrames,
      startFrame: targetStart,
      chunkFrames: copyFrames,
      minLeft: work.minLeft.subarray(sourceStart, sourceEnd),
      maxLeft: work.maxLeft.subarray(sourceStart, sourceEnd),
      minRight: work.minRight.subarray(sourceStart, sourceEnd),
      maxRight: work.maxRight.subarray(sourceStart, sourceEnd)
    }
    options.applyLiveWaveformRawChunk(liveChunk, !keepMainThreadRawArrays)

    const dirtyStartSec = resolveAudioRangeStartSecToTimelineSec(
      work.startSec + targetStart / work.rate
    )
    const dirtyEndSec = resolveAudioSecToTimelineSec(work.startSec + targetEnd / work.rate)
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
        options.scheduleDraw()
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
    rawStreamContinuePending = false
    rawStreamContinueStartedAt = 0
    clearRawStreamWatchdog()
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
        options.replaceLiveWaveformRaw(normalized)
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
      options.updateLiveWaveformRawMeta({
        duration: current.duration,
        frames: current.frames,
        startSec: Math.max(0, Number(current.startSec) || 0),
        loadedFrames: current.loadedFrames
      })
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
    let processedWorkCount = 0
    while (pendingRawStreamChunks.length > 0) {
      const nextWork = pendingRawStreamChunks[0]
      if (!nextWork) break
      const completed = processPendingRawStreamChunkWork(nextWork)
      processedWorkCount += 1
      if (completed) {
        pendingRawStreamChunks.shift()
        finalizePendingRawStreamChunkWork(nextWork)
      }
      if (options.playing() && processedWorkCount >= 1) {
        break
      }
      if (performance.now() - startedAt >= resolveChunkProcessBudgetMs()) {
        break
      }
    }
    if (pendingRawStreamChunks.length > 0) {
      scheduleQueuedRawStreamPayloadFlush()
      return
    }

    maybeContinueRawWaveformStream()

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

  const maybeContinueRawWaveformStream = (anchorSec?: number) => {
    const filePath = String(options.song()?.filePath || '').trim()
    if (!filePath) return
    const viewportAnchorSec = Math.max(
      0,
      Number(
        anchorSec ?? (options.playing() ? options.currentSeconds() : options.viewportAnchorSec())
      ) || 0
    )
    if (isActiveInitialStreamCoveringVisibleCore(viewportAnchorSec)) {
      if (recoverStalledInitialStream(viewportAnchorSec)) {
        return
      }
      return
    }
    const currentCoversVisible = isCurrentRawCoveringVisibleRange(
      viewportAnchorSec,
      HORIZONTAL_BROWSE_RAW_VIEWPORT_OVERSCAN_FACTOR
    )
    if (
      currentCoversVisible &&
      (!options.playing() || !rawStreamRequestId || !options.rawStreamActive.value)
    ) {
      return
    }
    if (rawStreamRequestId && options.rawStreamActive.value && !options.rawData.value) {
      const targetStartSec = resolveRawWaveformBootstrapStartSec(viewportAnchorSec)
      const activeStartSec = resolveAudioRangeStartSecToTimelineSec(rawStreamStartSec)
      const visibleDurationSec = Math.max(0.001, Number(options.visibleDurationSec()) || 0.001)
      if (
        Math.abs(targetStartSec - activeStartSec) <=
        visibleDurationSec * HORIZONTAL_BROWSE_RAW_VIEWPORT_RESTART_GAP_FACTOR
      ) {
        return
      }
      restartRawWaveformStreamAt(viewportAnchorSec, false)
      return
    }
    if (!rawStreamRequestId || !options.rawStreamActive.value || !options.rawData.value) {
      restartRawWaveformStreamAt(viewportAnchorSec, false)
      return
    }

    const { rate, loadedStartSec, loadedEndSec } = resolveLoadedTimelineRange()
    if (!rate) {
      return
    }
    const { visibleStartSec, visibleEndSec, visibleDurationSec } = resolveVisibleTimelineRange(
      viewportAnchorSec,
      HORIZONTAL_BROWSE_RAW_VIEWPORT_OVERSCAN_FACTOR
    )
    const restartGapSec = Math.max(
      0.5,
      visibleDurationSec * HORIZONTAL_BROWSE_RAW_VIEWPORT_RESTART_GAP_FACTOR
    )
    if (visibleStartSec + restartGapSec < loadedStartSec || visibleStartSec > loadedEndSec) {
      restartRawWaveformStreamAt(viewportAnchorSec, false)
      return
    }

    const desiredLoadedEndSec = options.playing()
      ? viewportAnchorSec + visibleDurationSec * HORIZONTAL_BROWSE_RAW_CONTINUE_LOOKAHEAD_FACTOR
      : visibleEndSec
    if (loadedEndSec >= desiredLoadedEndSec) {
      return
    }
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
    clearRawStreamWatchdog()
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
