import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import type { HorizontalBrowseDetailLiveCanvasRawChunk } from '@renderer/workers/horizontalBrowseDetailLiveCanvas.types'
import { createRawPlaceholderMixxxData } from '@renderer/components/beatGridWaveformPlaceholder'
import { PREVIEW_RAW_TARGET_RATE } from '@renderer/components/MixtapeBeatAlignDialog.constants'
import { normalizeHorizontalBrowsePathKey } from '@renderer/components/horizontalBrowseWaveformDetail.utils'
import { parseHorizontalBrowseDurationToSeconds } from '@renderer/components/horizontalBrowseShellState'
import {
  ensureRawWaveformWindowCapacity,
  isRawWaveformWindowFormatCompatible,
  resolveRawWaveformWindowFrame,
  trimRawWaveformWindowStart
} from '@renderer/components/horizontalBrowseRawWaveformRollingBuffer'
import { buildPendingRawStreamChunkWork } from '@renderer/components/horizontalBrowseRawWaveformStreamChunkWork'
import * as rawStreamWindow from '@renderer/components/horizontalBrowseRawWaveformStreamWindow'
import {
  HORIZONTAL_BROWSE_RAW_CHUNK_COPY_SLICE_FRAMES,
  HORIZONTAL_BROWSE_RAW_CHUNK_PROCESS_BUDGET_MS,
  HORIZONTAL_BROWSE_RAW_CONTINUE_LOOKAHEAD_FACTOR,
  HORIZONTAL_BROWSE_RAW_CONTINUE_TIMEOUT_MS,
  HORIZONTAL_BROWSE_RAW_DURATION_TAIL_TOLERANCE_SEC,
  HORIZONTAL_BROWSE_RAW_INITIAL_CHUNK_MAX_RETRIES,
  HORIZONTAL_BROWSE_RAW_INITIAL_CHUNK_TIMEOUT_MS,
  HORIZONTAL_BROWSE_RAW_PLAYING_COPY_SLICE_FRAMES,
  HORIZONTAL_BROWSE_RAW_PLAYING_COPY_SLICES_PER_FLUSH,
  HORIZONTAL_BROWSE_RAW_PLAYING_WAVEFORM_CHUNK_FRAMES,
  HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_CHUNK_FRAMES,
  HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_CHUNK_OVERSCAN_FACTOR,
  HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_LEAD_FACTOR,
  HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_MAX_CHUNK_FRAMES,
  HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_MIN_SEC,
  HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_OVERSCAN_FACTOR,
  HORIZONTAL_BROWSE_RAW_VIEWPORT_OVERSCAN_FACTOR,
  HORIZONTAL_BROWSE_RAW_VIEWPORT_RESTART_GAP_FACTOR,
  HORIZONTAL_BROWSE_RAW_VISIBLE_REDRAW_LEAD_FACTOR,
  HORIZONTAL_BROWSE_RAW_WAVEFORM_CHUNK_FRAMES,
  normalizeRawWaveformData,
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
  let rawChunkProcessChannel: MessageChannel | null = null
  let rawChunkProcessChannelPending = false
  let rawChunkProcessScheduleToken = 0
  let rawStreamFirstVisibleDrawScheduled = false
  let rawStreamVisibleCoverageRedrawn = false
  let rawStreamBootstrapDurationSec = 0
  let rawStreamBootstrapAnchorSec: number | null = null
  let rawStreamContinuePending = false
  let rawStreamInitialRetryCount = 0
  let rawStreamContinueStartedAt = 0
  let rawStreamWatchdogTimer: ReturnType<typeof setTimeout> | null = null
  let rawStreamKeepMainThreadRawArrays = true
  let rawStreamFastInitialCoverage = false

  const resolveRawLoadPriorityHint = () =>
    Math.max(0, Math.floor(Number(options.rawLoadPriorityHint()) || 0))

  const resolveDeckKey = () => (options.direction() === 'up' ? 'top' : 'bottom')

  const resolveProtectsPlayback = () => options.playing() === true

  const resolveChunkProcessBudgetMs = () => HORIZONTAL_BROWSE_RAW_CHUNK_PROCESS_BUDGET_MS

  const resolveChunkCopySliceFrames = () => HORIZONTAL_BROWSE_RAW_CHUNK_COPY_SLICE_FRAMES

  const isFastInitialCoverageActive = () =>
    rawStreamFastInitialCoverage && !rawStreamVisibleCoverageRedrawn

  const resolveMaxChunkCopySlicesPerFlush = () =>
    options.playing() ? HORIZONTAL_BROWSE_RAW_PLAYING_COPY_SLICES_PER_FLUSH : Infinity

  const resolveMaxChunkCopyFrames = (bootstrapCopyFrames: number) =>
    options.playing()
      ? HORIZONTAL_BROWSE_RAW_PLAYING_COPY_SLICE_FRAMES
      : Math.max(resolveChunkCopySliceFrames(), bootstrapCopyFrames)

  const shouldKeepMainThreadRawArrays = () => rawStreamKeepMainThreadRawArrays

  const resolveSeekBootstrapChunkFrames = () => {
    const visibleDurationSec = Math.max(0.001, Number(options.visibleDurationSec()) || 0.001)
    const targetRate = Math.max(1, Math.floor(Number(resolveWaveformTargetRate(false)) || 1))
    const targetFrames = Math.ceil(
      visibleDurationSec * targetRate * HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_CHUNK_OVERSCAN_FACTOR
    )
    return Math.min(
      HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_MAX_CHUNK_FRAMES,
      Math.max(HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_CHUNK_FRAMES, targetFrames)
    )
  }

  const resolveStreamChunkFrames = () =>
    isFastInitialCoverageActive()
      ? resolveSeekBootstrapChunkFrames()
      : options.playing()
        ? HORIZONTAL_BROWSE_RAW_PLAYING_WAVEFORM_CHUNK_FRAMES
        : HORIZONTAL_BROWSE_RAW_WAVEFORM_CHUNK_FRAMES

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

  const ensureRawWaveformCapacity = (
    requiredFrames: number,
    meta: { duration: number; sampleRate: number; rate: number; startSec: number }
  ) => {
    const nextFrames = Math.max(0, Math.floor(requiredFrames))
    if (!nextFrames) return

    const current = options.rawData.value
    const hasCompatibleFormat = isRawWaveformWindowFormatCompatible(current, meta)
    if (
      !current ||
      !hasCompatibleFormat ||
      Math.abs((Number(current.startSec) || 0) - meta.startSec) > 0.0001
    ) {
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
      options.scheduleDraw()
      return
    }

    const keepMainThreadRawArrays = shouldKeepMainThreadRawArrays()
    const changed = ensureRawWaveformWindowCapacity(current, nextFrames, keepMainThreadRawArrays)
    if (!changed) return
    const grownFrames = Math.max(nextFrames, current.frames)
    current.duration = Math.max(current.duration, meta.duration)
    current.sampleRate = meta.sampleRate
    current.rate = meta.rate
    current.frames = grownFrames
    options.mixxxData.value = createRawPlaceholderMixxxData(current)
    options.ensureLiveWaveformRawCapacity({
      duration: Math.max(current.duration, meta.duration),
      sampleRate: meta.sampleRate,
      rate: meta.rate,
      frames: grownFrames,
      startSec: Math.max(0, Number(current.startSec) || 0),
      loadedFrames: current.loadedFrames
    })
  }

  const clearQueuedRawStreamPayloads = () => {
    pendingRawStreamChunks.length = 0
    pendingRawStreamDonePayload = null
    rawStreamFirstVisibleDrawScheduled = false
    rawStreamVisibleCoverageRedrawn = false
    if (rawChunkProcessTimer) {
      clearTimeout(rawChunkProcessTimer)
      rawChunkProcessTimer = null
    }
    rawChunkProcessScheduleToken += 1
    rawChunkProcessChannelPending = false
  }

  const closeRawChunkProcessChannel = () => {
    if (!rawChunkProcessChannel) return
    rawChunkProcessChannel.port1.onmessage = null
    rawChunkProcessChannel.port1.close()
    rawChunkProcessChannel.port2.close()
    rawChunkProcessChannel = null
    rawChunkProcessChannelPending = false
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
    if (rawStreamInitialRetryCount >= HORIZONTAL_BROWSE_RAW_INITIAL_CHUNK_MAX_RETRIES) return false
    return restartRawWaveformStreamAt(viewportAnchorSec, false, {
      forceRestart: true,
      forceLiveDecode: true,
      initialRetryCount: rawStreamInitialRetryCount + 1,
      bootstrapDurationSec: resolveSeekBootstrapDurationSec(),
      preferFastInitialCoverage: rawStreamFastInitialCoverage,
      preserveDisplay: canPreservePlaybackDisplayForStreamRestart(viewportAnchorSec)
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
    window.electron.ipcRenderer.send('mixtape-waveform-raw:cancel-stream', {
      requestId: rawStreamRequestId
    })
    rawStreamRequestId = ''
    rawStreamContinuePending = false
    rawStreamContinueStartedAt = 0
    rawStreamFastInitialCoverage = false
    rawStreamKeepMainThreadRawArrays = true
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

  const resolveCurrentViewportAnchorSec = () =>
    Math.max(
      0,
      Number(options.playing() ? options.currentSeconds() : options.viewportAnchorSec()) || 0
    )

  const trimPlayingRawWindow = (anchorSec = resolveCurrentViewportAnchorSec()) => {
    const current = options.rawData.value
    if (!current || !options.playing()) return false
    const visibleDurationSec = Number(options.visibleDurationSec()) || 0.001
    const requestedWindowStartSec = rawStreamWindow.resolvePlayingRawWindowStartAudioSec(
      anchorSec,
      visibleDurationSec,
      resolveTimeBasisOffsetSec()
    )
    const windowStartSec = rawStreamWindow.resolveSafePlayingRawWindowStartAudioSec(
      current,
      requestedWindowStartSec,
      visibleDurationSec
    )
    const droppedFrames = trimRawWaveformWindowStart(current, windowStartSec)
    if (!droppedFrames) return false
    options.mixxxData.value = createRawPlaceholderMixxxData(current)
    options.updateLiveWaveformRawMeta({
      duration: current.duration,
      frames: current.frames,
      startSec: Math.max(0, Number(current.startSec) || 0),
      loadedFrames: current.loadedFrames
    })
    return true
  }

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
    const preserveDisplay = startOptions.preserveDisplay === true
    const appendToCurrent = startOptions.appendToCurrent === true && !!options.rawData.value
    clearQueuedRawStreamPayloads()
    cancelRawWaveformStream()
    if (!appendToCurrent) {
      options.resetRawStreamDrawState({ preserveDisplay })
    }
    rawStreamFastInitialCoverage = startOptions.preferFastInitialCoverage === true
    rawStreamStartSec = Math.max(0, Number(startSec) || 0)
    rawStreamRequestId = `horizontal-raw-${options.direction()}-${Date.now()}-${requestToken}`
    options.rawStreamActive.value = true
    rawStreamStartedAt = performance.now()
    rawStreamChunkCount = 0
    rawStreamFirstVisibleDrawScheduled = false
    rawStreamContinuePending = false
    rawStreamContinueStartedAt = 0
    rawStreamInitialRetryCount = Math.max(
      0,
      Math.floor(Number(startOptions.initialRetryCount) || 0)
    )
    rawStreamBootstrapAnchorSec = Math.max(
      0,
      Number(startOptions.bootstrapAnchorSec ?? resolveCurrentViewportAnchorSec()) || 0
    )
    const bootstrapDurationSec = Math.max(
      0,
      Number(startOptions.bootstrapDurationSec ?? options.bootstrapDurationSec()) || 0
    )
    rawStreamBootstrapDurationSec = bootstrapDurationSec
    const protectsPlayback = resolveProtectsPlayback()
    rawStreamKeepMainThreadRawArrays = !protectsPlayback
    const songDurationSec = resolveSongDurationSec()
    const remainingDurationSec = Math.max(0, songDurationSec - rawStreamStartSec)
    const visibleDurationSec = Math.max(0.001, Number(options.visibleDurationSec()) || 0.001)
    const playbackDecodeWindowSec = Math.max(
      bootstrapDurationSec,
      visibleDurationSec *
        (HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_LEAD_FACTOR +
          HORIZONTAL_BROWSE_RAW_CONTINUE_LOOKAHEAD_FACTOR)
    )
    const streamExpectedDurationSec = protectsPlayback
      ? Math.min(remainingDurationSec, playbackDecodeWindowSec)
      : remainingDurationSec
    const streamChunkFrames = resolveStreamChunkFrames()
    window.electron.ipcRenderer.send('mixtape-waveform-raw:stream', {
      requestId: rawStreamRequestId,
      filePath,
      deckKey: resolveDeckKey(),
      protectsPlayback: resolveProtectsPlayback(),
      priorityHint: resolveRawLoadPriorityHint(),
      targetRate,
      startSec: rawStreamStartSec,
      songDurationSec,
      chunkFrames: streamChunkFrames,
      expectedDurationSec: streamExpectedDurationSec,
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
    const totalFrames = Math.max(0, Number(current?.frames) || 0)
    const currentStartSec = Number(current?.startSec)
    const rawStartSec =
      current && Number.isFinite(currentStartSec) ? Math.max(0, currentStartSec) : rawStreamStartSec
    const loadedStartSec = resolveAudioRangeStartSecToTimelineSec(rawStartSec)
    const loadedEndSec =
      rate > 0 ? resolveAudioSecToTimelineSec(rawStartSec + loadedFrames / rate) : loadedStartSec
    const streamComplete = Boolean(current && totalFrames > 0 && loadedFrames >= totalFrames)
    return {
      rate,
      loadedFrames,
      loadedStartSec,
      loadedEndSec,
      streamComplete
    }
  }

  const resolveCoverageEndSec = (
    visibleEndSec: number,
    loadedEndSec: number,
    streamComplete: boolean
  ) => {
    const songDurationSec = resolveSongDurationSec()
    if (
      streamComplete &&
      songDurationSec > 0 &&
      loadedEndSec > 0 &&
      visibleEndSec >= loadedEndSec &&
      songDurationSec - loadedEndSec >= 0 &&
      songDurationSec - loadedEndSec <= HORIZONTAL_BROWSE_RAW_DURATION_TAIL_TOLERANCE_SEC
    ) {
      return Math.min(visibleEndSec, loadedEndSec)
    }
    return visibleEndSec
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
    const { loadedStartSec, loadedEndSec, streamComplete } = resolveLoadedTimelineRange()
    const { visibleStartSec, visibleEndSec } = resolveVisibleTimelineRange(
      anchorSec,
      overscanFactor
    )
    const coverageEndSec = resolveCoverageEndSec(visibleEndSec, loadedEndSec, streamComplete)
    return visibleStartSec >= loadedStartSec && coverageEndSec <= loadedEndSec
  }

  const canPreservePlaybackDisplayForStreamRestart = (_anchorSec: number) =>
    options.playing() && !!options.rawData.value

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
    const hasCoverage = isCurrentRawCoveringVisibleRange(targetSec)
    if (hasCoverage) {
      return false
    }
    if (!startOptions.forceRestart && isActiveInitialStreamCoveringVisibleCore(targetSec)) {
      return false
    }
    if (holdFrame) {
      options.holdCurrentWaveformFrame()
    }
    const forceLiveDecode =
      startOptions.forceLiveDecode === true || (options.playing() && targetStartSec > 0.0001)
    beginRawWaveformStream(filePath, resolveWaveformTargetRate(false), Date.now(), targetStartSec, {
      bootstrapDurationSec: startOptions.bootstrapDurationSec ?? resolveSeekBootstrapDurationSec(),
      bootstrapAnchorSec: targetSec,
      preserveDisplay: startOptions.preserveDisplay === true,
      forceLiveDecode,
      initialRetryCount: startOptions.initialRetryCount
    })
    return true
  }

  const appendRawWaveformStreamFrom = (loadedEndTimelineSec: number) => {
    const filePath = String(options.song()?.filePath || '').trim()
    if (!filePath || rawStreamRequestId || options.rawStreamActive.value) return false
    const songDurationSec = resolveSongDurationSec()
    if (songDurationSec > 0 && loadedEndTimelineSec >= songDurationSec - 0.05) return false
    const appendStartSec = rawStreamWindow.resolveRawStreamAppendStartAudioSec(
      loadedEndTimelineSec,
      resolveTimeBasisOffsetSec()
    )
    beginRawWaveformStream(filePath, resolveWaveformTargetRate(false), Date.now(), appendStartSec, {
      appendToCurrent: true,
      bootstrapAnchorSec: resolveCurrentViewportAnchorSec(),
      preserveDisplay: true,
      forceLiveDecode: true
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

  const resolveInitialViewportBootstrapTargetLoadedFrames = (rate: number, startSec: number) => {
    if (rawStreamFirstVisibleDrawScheduled) return 0
    const anchorSec = rawStreamBootstrapAnchorSec ?? resolveCurrentViewportAnchorSec()
    const { visibleEndSec } = resolveVisibleTimelineRange(anchorSec)
    const desiredLoadedEndSec = visibleEndSec
    const desiredLoadedEndAudioSec = resolveTimelineSecToAudioSec(desiredLoadedEndSec)
    return Math.max(0, Math.ceil(Math.max(0, desiredLoadedEndAudioSec - startSec) * rate))
  }

  const finalizePendingRawStreamChunkWork = (work: PendingRawStreamChunkWork) => {
    rawStreamContinuePending = false
    rawStreamContinueStartedAt = 0
    rawStreamChunkCount += 1
    if (rawStreamChunkCount === 1) {
      options.previewLoading.value = false
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
    const anchorSec = resolveCurrentViewportAnchorSec()
    trimPlayingRawWindow(anchorSec)
    const chunkStartAudioSec = work.startSec + work.startFrame / work.rate
    const chunkEndAudioSec = work.startSec + (work.startFrame + work.chunkFrames) / work.rate
    const windowStartSec = rawStreamWindow.resolveChunkRawWindowStartSec(
      options.rawData.value,
      work
    )
    const requiredFrames = Math.max(0, Math.ceil((chunkEndAudioSec - windowStartSec) * work.rate))
    ensureRawWaveformCapacity(requiredFrames, {
      duration: work.duration,
      sampleRate: work.sampleRate,
      rate: work.rate,
      startSec: windowStartSec
    })

    const target = options.rawData.value
    if (!target) return true

    const rawWindowStartSec = Math.max(0, Number(target.startSec) || 0)
    const minAppliedFrame = Math.max(
      0,
      Math.ceil(Math.max(0, rawWindowStartSec - chunkStartAudioSec) * work.rate)
    )
    if (work.appliedFrames < minAppliedFrame) {
      work.appliedFrames = Math.min(work.chunkFrames, minAppliedFrame)
    }

    const remainingFrames = work.chunkFrames - work.appliedFrames
    if (remainingFrames <= 0) return true

    const initialViewportBootstrapTargetLoadedFrames = Math.min(
      target.frames,
      resolveInitialViewportBootstrapTargetLoadedFrames(work.rate, rawWindowStartSec)
    )
    const keepMainThreadRawArrays = shouldKeepMainThreadRawArrays()
    const sourceStart = work.appliedFrames
    const targetStart = resolveRawWaveformWindowFrame(
      target,
      chunkStartAudioSec + sourceStart / work.rate
    )
    if (targetStart >= target.frames) {
      return true
    }
    const loadedFrames = Math.max(Math.max(0, Number(target.loadedFrames) || 0), targetStart)
    const bootstrapCopyFrames = Math.max(
      0,
      initialViewportBootstrapTargetLoadedFrames - loadedFrames
    )
    const copyFrames = Math.min(
      remainingFrames,
      Math.max(0, target.frames - targetStart),
      keepMainThreadRawArrays ? resolveMaxChunkCopyFrames(bootstrapCopyFrames) : remainingFrames
    )
    if (copyFrames <= 0) {
      return true
    }
    const sourceEnd = sourceStart + copyFrames
    const targetEnd = targetStart + copyFrames
    if (keepMainThreadRawArrays && targetEnd > target.minLeft.length) return true

    if (keepMainThreadRawArrays) {
      target.minLeft.set(work.minLeft.subarray(sourceStart, sourceEnd), targetStart)
      target.maxLeft.set(work.maxLeft.subarray(sourceStart, sourceEnd), targetStart)
      target.minRight.set(work.minRight.subarray(sourceStart, sourceEnd), targetStart)
      target.maxRight.set(work.maxRight.subarray(sourceStart, sourceEnd), targetStart)
      if (work.meanLeft && work.meanRight) {
        if (!target.meanLeft || target.meanLeft.length < target.minLeft.length) {
          target.meanLeft = new Float32Array(target.minLeft.length)
        }
        if (!target.meanRight || target.meanRight.length < target.minRight.length) {
          target.meanRight = new Float32Array(target.minRight.length)
        }
        target.meanLeft.set(work.meanLeft.subarray(sourceStart, sourceEnd), targetStart)
        target.meanRight.set(work.meanRight.subarray(sourceStart, sourceEnd), targetStart)
      } else {
        target.meanLeft = undefined
        target.meanRight = undefined
      }
      if (work.rmsLeft && work.rmsRight) {
        if (!target.rmsLeft || target.rmsLeft.length < target.minLeft.length) {
          target.rmsLeft = new Float32Array(target.minLeft.length)
        }
        if (!target.rmsRight || target.rmsRight.length < target.minRight.length) {
          target.rmsRight = new Float32Array(target.minRight.length)
        }
        target.rmsLeft.set(work.rmsLeft.subarray(sourceStart, sourceEnd), targetStart)
        target.rmsRight.set(work.rmsRight.subarray(sourceStart, sourceEnd), targetStart)
      } else {
        target.rmsLeft = undefined
        target.rmsRight = undefined
      }
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
      maxRight: work.maxRight.subarray(sourceStart, sourceEnd),
      meanLeft: work.meanLeft?.subarray(sourceStart, sourceEnd),
      meanRight: work.meanRight?.subarray(sourceStart, sourceEnd),
      rmsLeft: work.rmsLeft?.subarray(sourceStart, sourceEnd),
      rmsRight: work.rmsRight?.subarray(sourceStart, sourceEnd)
    }
    options.applyLiveWaveformRawChunk(liveChunk, !keepMainThreadRawArrays)

    const dirtyStartSec = resolveAudioRangeStartSecToTimelineSec(
      chunkStartAudioSec + sourceStart / work.rate
    )
    const dirtyEndSec = resolveAudioSecToTimelineSec(chunkStartAudioSec + sourceEnd / work.rate)
    if (shouldScheduleRawStreamRedraw(dirtyStartSec, dirtyEndSec)) {
      if (!rawStreamFirstVisibleDrawScheduled) {
        rawStreamFirstVisibleDrawScheduled = true
        options.scheduleDraw()
      }
      options.scheduleRawStreamDirtyDraw(dirtyStartSec, dirtyEndSec)
    }

    if (!rawStreamVisibleCoverageRedrawn && isCurrentRawCoveringVisibleRange(anchorSec)) {
      rawStreamVisibleCoverageRedrawn = true
      rawStreamFastInitialCoverage = false
      options.scheduleRawStreamCoverageDraw()
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
    const work = buildPendingRawStreamChunkWork(payload, rawStreamStartSec)
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
    rawStreamRequestId = ''
    rawStreamContinuePending = false
    rawStreamContinueStartedAt = 0
    clearRawStreamWatchdog()
    options.previewLoading.value = false
    options.rawStreamActive.value = false

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
      const currentStartSec = Math.max(0, Number(current.startSec) || 0)
      const currentRate = Math.max(0, Number(current.rate) || 0)
      const streamEndSec =
        currentRate > 0 && totalFrames > 0 ? startSec + totalFrames / currentRate : 0
      const loadedFramesForCurrentWindow =
        currentRate > 0 && streamEndSec > currentStartSec
          ? Math.ceil((streamEndSec - currentStartSec) * currentRate)
          : totalFrames
      const payloadStartsCurrentWindow = Math.abs(startSec - currentStartSec) <= 0.0001
      if (payloadStartsCurrentWindow && totalFrames > 0 && totalFrames <= current.frames) {
        current.frames = totalFrames
      }
      current.loadedFrames = Math.min(
        current.frames,
        Math.max(
          Math.floor(Number(current.loadedFrames ?? 0) || 0),
          totalFrames > 0 ? loadedFramesForCurrentWindow : (current.loadedFrames ?? current.frames)
        )
      )
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

    if (options.playing() && !payload?.error) {
      maybeContinueRawWaveformStream()
    } else {
      options.scheduleDraw()
    }
  }

  const flushQueuedRawStreamPayloads = () => {
    rawChunkProcessTimer = null
    rawChunkProcessChannelPending = false
    const startedAt = performance.now()
    let processedWorkCount = 0
    const maxProcessedWorkCount = resolveMaxChunkCopySlicesPerFlush()
    while (pendingRawStreamChunks.length > 0) {
      const nextWork = pendingRawStreamChunks[0]
      if (!nextWork) break
      const completed = processPendingRawStreamChunkWork(nextWork)
      processedWorkCount += 1
      if (completed) {
        pendingRawStreamChunks.shift()
        finalizePendingRawStreamChunkWork(nextWork)
      }
      if (processedWorkCount >= maxProcessedWorkCount) {
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
    if (rawChunkProcessTimer || rawChunkProcessChannelPending) return
    const scheduleToken = rawChunkProcessScheduleToken
    if (typeof MessageChannel !== 'undefined') {
      if (!rawChunkProcessChannel) {
        rawChunkProcessChannel = new MessageChannel()
        rawChunkProcessChannel.port1.onmessage = (event) => {
          if (Number(event.data) !== rawChunkProcessScheduleToken) return
          flushQueuedRawStreamPayloads()
        }
      }
      rawChunkProcessChannelPending = true
      rawChunkProcessChannel.port2.postMessage(scheduleToken)
      return
    }
    rawChunkProcessTimer = setTimeout(() => {
      rawChunkProcessTimer = null
      if (scheduleToken !== rawChunkProcessScheduleToken) return
      flushQueuedRawStreamPayloads()
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
    if (
      pendingRawStreamChunks.length > 0 ||
      rawChunkProcessTimer ||
      rawChunkProcessChannelPending
    ) {
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
    if (currentCoversVisible && !options.playing()) {
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
      restartRawWaveformStreamAt(viewportAnchorSec, false, {
        preserveDisplay: canPreservePlaybackDisplayForStreamRestart(viewportAnchorSec)
      })
      return
    }
    if (!options.rawData.value) {
      restartRawWaveformStreamAt(viewportAnchorSec, false, {
        preserveDisplay: canPreservePlaybackDisplayForStreamRestart(viewportAnchorSec)
      })
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
      restartRawWaveformStreamAt(viewportAnchorSec, false, {
        preserveDisplay: canPreservePlaybackDisplayForStreamRestart(viewportAnchorSec)
      })
      return
    }

    const desiredLoadedEndSec = options.playing()
      ? viewportAnchorSec + visibleDurationSec * HORIZONTAL_BROWSE_RAW_CONTINUE_LOOKAHEAD_FACTOR
      : visibleEndSec
    if (loadedEndSec >= desiredLoadedEndSec) {
      return
    }
    if (rawStreamRequestId && options.rawStreamActive.value) {
      continueRawWaveformStream(rawStreamRequestId)
      return
    }
    if (options.playing()) {
      appendRawWaveformStreamFrom(loadedEndSec)
    }
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
    closeRawChunkProcessChannel()
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
