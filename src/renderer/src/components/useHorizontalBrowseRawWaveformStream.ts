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
import { isHorizontalBrowseEditRawWindowMode } from '@renderer/components/horizontalBrowseEditDetailRawWaveform'
import {
  isRawWaveformActiveInitialStreamCoveringVisibleCore,
  isRawWaveformStreamCoveringVisibleRange,
  resolveRawWaveformStreamLoadedTimelineRange,
  resolveRawWaveformStreamVisibleTimelineRange
} from '@renderer/components/horizontalBrowseRawWaveformStreamViewport'
import {
  HORIZONTAL_BROWSE_RAW_CHUNK_COPY_SLICE_FRAMES,
  HORIZONTAL_BROWSE_RAW_CHUNK_PROCESS_BUDGET_MS,
  HORIZONTAL_BROWSE_RAW_CONTINUE_LOOKAHEAD_FACTOR,
  HORIZONTAL_BROWSE_RAW_CONTINUE_TIMEOUT_MS,
  HORIZONTAL_BROWSE_RAW_INITIAL_CHUNK_MAX_RETRIES,
  HORIZONTAL_BROWSE_RAW_INITIAL_CHUNK_TIMEOUT_MS,
  HORIZONTAL_BROWSE_RAW_PLAYING_COPY_SLICE_FRAMES,
  HORIZONTAL_BROWSE_RAW_PLAYING_COPY_SLICES_PER_FLUSH,
  HORIZONTAL_BROWSE_RAW_VIEWPORT_OVERSCAN_FACTOR,
  HORIZONTAL_BROWSE_RAW_VIEWPORT_RESTART_GAP_FACTOR,
  HORIZONTAL_BROWSE_RAW_VISIBLE_REDRAW_LEAD_FACTOR,
  normalizeRawWaveformData,
  type HorizontalBrowseRawWaveformStreamChunkPayload,
  type HorizontalBrowseRawWaveformStreamDonePayload,
  type PendingRawStreamChunkWork,
  type RawWaveformStreamStartOptions,
  type UseHorizontalBrowseRawWaveformStreamOptions
} from '@renderer/components/horizontalBrowseRawWaveformStreamTypes'
import {
  resolveHorizontalBrowseRawSeekBootstrapChunkFrames,
  resolveHorizontalBrowseRawSeekBootstrapDurationSec,
  resolveHorizontalBrowseRawStreamBootstrapStartSec,
  resolveHorizontalBrowseRawStreamExpectedDurationSec,
  resolveHorizontalBrowseRawStreamChunkFrames
} from '@renderer/components/horizontalBrowseRawWaveformStreamSizing'

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
  let rawStreamTargetRate = 0
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
  const isFastInitialCoverageActive = () =>
    rawStreamFastInitialCoverage && !rawStreamVisibleCoverageRedrawn
  const resolveMaxChunkCopySlicesPerFlush = () =>
    isEditWindowRawStream()
      ? 1
      : options.playing()
        ? HORIZONTAL_BROWSE_RAW_PLAYING_COPY_SLICES_PER_FLUSH
        : Infinity

  const resolveMaxChunkCopyFrames = (bootstrapCopyFrames: number) =>
    options.playing()
      ? HORIZONTAL_BROWSE_RAW_PLAYING_COPY_SLICE_FRAMES
      : Math.max(HORIZONTAL_BROWSE_RAW_CHUNK_COPY_SLICE_FRAMES, bootstrapCopyFrames)

  const shouldKeepMainThreadRawArrays = () => rawStreamKeepMainThreadRawArrays

  const isEditWindowRawStream = () => isHorizontalBrowseEditRawWindowMode(options.rawStreamMode?.())

  const resolveSeekBootstrapChunkFrames = () => {
    const visibleDurationSec = Math.max(0.001, Number(options.visibleDurationSec()) || 0.001)
    const targetRate = Math.max(1, Math.floor(Number(resolveWaveformTargetRate(false)) || 1))
    return resolveHorizontalBrowseRawSeekBootstrapChunkFrames({ visibleDurationSec, targetRate })
  }

  const resolveStreamChunkFrames = () =>
    resolveHorizontalBrowseRawStreamChunkFrames({
      editWindow: isEditWindowRawStream(),
      fastInitialCoverage: isFastInitialCoverageActive(),
      playing: options.playing(),
      seekBootstrapChunkFrames: resolveSeekBootstrapChunkFrames(),
      targetRate: rawStreamTargetRate || resolveWaveformTargetRate(false),
      bootstrapDurationSec: rawStreamBootstrapDurationSec
    })

  const resolveWaveformTargetRate = (_deferred: boolean) => {
    const requestedRate = Math.max(1, Number(options.rawTargetRate?.()) || PREVIEW_RAW_TARGET_RATE)
    const minRate = isEditWindowRawStream() ? 1 : PREVIEW_RAW_TARGET_RATE
    return Math.max(minRate, requestedRate)
  }

  const resolveSeekBootstrapDurationSec = () => {
    const visibleDurationSec = Math.max(0.001, Number(options.visibleDurationSec()) || 0.001)
    return resolveHorizontalBrowseRawSeekBootstrapDurationSec(visibleDurationSec)
  }

  const resolveTimeBasisOffsetSec = () =>
    Math.max(0, Number(options.timeBasisOffsetMs()) || 0) / 1000

  const resolveAudioSecToTimelineSec = (audioSec: number) =>
    Math.max(0, (Number(audioSec) || 0) + resolveTimeBasisOffsetSec())

  const resolveAudioRangeStartSecToTimelineSec = (audioSec: number) =>
    Math.max(0, Number(audioSec) || 0) <= 0.0001 ? 0 : resolveAudioSecToTimelineSec(audioSec)

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
    if (isEditWindowRawStream()) return false
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
    return resolveHorizontalBrowseRawStreamBootstrapStartSec({
      targetSec,
      visibleDurationSec: options.visibleDurationSec(),
      editWindow: isEditWindowRawStream(),
      highPrecision: resolveWaveformTargetRate(false) > PREVIEW_RAW_TARGET_RATE,
      playing: options.playing()
    })
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
    const editWindow = isEditWindowRawStream()
    const streamAnchorSec = Math.max(
      0,
      Number(startOptions.bootstrapAnchorSec ?? resolveCurrentViewportAnchorSec()) || 0
    )
    const streamStartSec = editWindow
      ? resolveTimelineSecToAudioSec(resolveRawWaveformBootstrapStartSec(streamAnchorSec))
      : Math.max(0, Number(startSec) || 0)
    rawStreamStartSec = streamStartSec
    rawStreamTargetRate = Math.max(1, Number(targetRate) || PREVIEW_RAW_TARGET_RATE)
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
      Number(startOptions.bootstrapAnchorSec ?? streamAnchorSec) || 0
    )
    const bootstrapDurationSec = Math.max(
      0,
      Number(startOptions.bootstrapDurationSec ?? options.bootstrapDurationSec()) || 0
    )
    rawStreamBootstrapDurationSec = bootstrapDurationSec
    const protectsPlayback = resolveProtectsPlayback()
    rawStreamKeepMainThreadRawArrays = !protectsPlayback && !editWindow
    const songDurationSec = resolveSongDurationSec()
    const visibleDurationSec = Math.max(0.001, Number(options.visibleDurationSec()) || 0.001)
    const highPrecisionLiveWindow = targetRate > PREVIEW_RAW_TARGET_RATE
    const streamExpectedDurationSec = resolveHorizontalBrowseRawStreamExpectedDurationSec({
      songDurationSec,
      startSec: rawStreamStartSec,
      bootstrapDurationSec,
      visibleDurationSec,
      protectsPlayback,
      highPrecision: highPrecisionLiveWindow
    })
    const streamChunkFrames = resolveStreamChunkFrames()
    if (editWindow && !appendToCurrent) {
      options.previewLoading.value = true
    }
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
      forceLiveDecode: startOptions.forceLiveDecode === true || highPrecisionLiveWindow,
      autoContinue: false,
      peaksOnly: editWindow
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
    return resolveRawWaveformStreamLoadedTimelineRange({
      current: options.rawData.value,
      rawStreamStartSec,
      timeBasisOffsetSec: resolveTimeBasisOffsetSec()
    })
  }

  const resolveVisibleTimelineRange = (anchorSec: number, overscanFactor = 0) => {
    return resolveRawWaveformStreamVisibleTimelineRange({
      anchorSec,
      visibleDurationSec: options.visibleDurationSec(),
      songDurationSec: resolveSongDurationSec(),
      overscanFactor
    })
  }

  const isCurrentRawCoveringVisibleRange = (anchorSec: number, overscanFactor = 0) => {
    return isRawWaveformStreamCoveringVisibleRange({
      current: options.rawData.value,
      rawStreamStartSec,
      timeBasisOffsetSec: resolveTimeBasisOffsetSec(),
      anchorSec,
      visibleDurationSec: options.visibleDurationSec(),
      songDurationSec: resolveSongDurationSec(),
      overscanFactor
    })
  }

  const canPreservePlaybackDisplayForStreamRestart = (_anchorSec: number) =>
    !!options.rawData.value && (options.playing() || isEditWindowRawStream())

  const isActiveInitialStreamCoveringVisibleCore = (anchorSec: number) =>
    isRawWaveformActiveInitialStreamCoveringVisibleCore({
      requestId: rawStreamRequestId,
      active: options.rawStreamActive.value,
      chunkCount: rawStreamChunkCount,
      rawStreamTargetRate,
      targetRate: resolveWaveformTargetRate(false),
      rawStreamStartSec,
      bootstrapDurationSec: rawStreamBootstrapDurationSec,
      timeBasisOffsetSec: resolveTimeBasisOffsetSec(),
      anchorSec,
      visibleDurationSec: options.visibleDurationSec(),
      songDurationSec: resolveSongDurationSec()
    })

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
    if (hasCoverage && !startOptions.forceRestart) {
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
    if (isEditWindowRawStream()) return false
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
    if (isEditWindowRawStream()) {
      const anchorSec = resolveCurrentViewportAnchorSec()
      const { visibleStartSec, visibleEndSec } = resolveVisibleTimelineRange(
        anchorSec,
        HORIZONTAL_BROWSE_RAW_VIEWPORT_OVERSCAN_FACTOR
      )
      return dirtyEndSec >= visibleStartSec && dirtyStartSec <= visibleEndSec
    }
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
    if (rawStreamChunkCount === 1 && !isEditWindowRawStream()) {
      options.previewLoading.value = false
    }

    if (!options.playing() && options.rawData.value) {
      options.rawData.value = { ...options.rawData.value }
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
    const windowStartSec = isEditWindowRawStream()
      ? Math.max(0, Number(work.startSec) || 0)
      : rawStreamWindow.resolveChunkRawWindowStartSec(options.rawData.value, work)
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
      startSec: rawWindowStartSec,
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
      options.previewLoading.value = false
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
      if (isEditWindowRawStream()) {
        current.loadedFrames = Math.min(
          current.frames,
          Math.max(0, Math.floor(Number(current.loadedFrames ?? 0) || 0))
        )
        options.updateLiveWaveformRawMeta({
          duration: current.duration,
          loadedFrames: current.loadedFrames
        })
        if (!options.playing()) {
          options.rawData.value = { ...current }
        }
      } else {
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
            totalFrames > 0
              ? loadedFramesForCurrentWindow
              : (current.loadedFrames ?? current.frames)
          )
        )
        options.updateLiveWaveformRawMeta({
          duration: current.duration,
          frames: current.frames,
          startSec: Math.max(0, Number(current.startSec) || 0),
          loadedFrames: current.loadedFrames
        })
        if (!options.playing()) {
          options.rawData.value = { ...current }
        }
      }
    }

    if (!isEditWindowRawStream() && options.rawData.value && options.song()?.filePath) {
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
      if (performance.now() - startedAt >= HORIZONTAL_BROWSE_RAW_CHUNK_PROCESS_BUDGET_MS) {
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
    if (isEditWindowRawStream()) {
      rawChunkProcessTimer = setTimeout(() => {
        rawChunkProcessTimer = null
        if (scheduleToken !== rawChunkProcessScheduleToken) return
        flushQueuedRawStreamPayloads()
      }, 12)
      return
    }
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
    const editWindow = isEditWindowRawStream()
    const currentCoversVisible = isCurrentRawCoveringVisibleRange(
      viewportAnchorSec,
      editWindow ? 0 : HORIZONTAL_BROWSE_RAW_VIEWPORT_OVERSCAN_FACTOR
    )
    const targetRate = Math.max(1, Number(resolveWaveformTargetRate(false)) || 1)
    const currentRateSufficient = (Number(options.rawData.value?.rate) || 0) >= targetRate
    if (currentCoversVisible && !currentRateSufficient) {
      restartRawWaveformStreamAt(viewportAnchorSec, false, {
        bootstrapDurationSec: options.bootstrapDurationSec(),
        forceLiveDecode: true,
        forceRestart: true,
        preserveDisplay: true
      })
      return
    }
    if (currentCoversVisible && currentRateSufficient && !options.playing()) {
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
    if (!rate) return
    const { visibleStartSec, visibleEndSec, visibleDurationSec } = resolveVisibleTimelineRange(
      viewportAnchorSec,
      HORIZONTAL_BROWSE_RAW_VIEWPORT_OVERSCAN_FACTOR
    )
    const highPrecisionWindow = targetRate > PREVIEW_RAW_TARGET_RATE
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
      ? highPrecisionWindow
        ? viewportAnchorSec + Math.max(2, Number(options.bootstrapDurationSec()) * 0.5)
        : viewportAnchorSec + visibleDurationSec * HORIZONTAL_BROWSE_RAW_CONTINUE_LOOKAHEAD_FACTOR
      : visibleEndSec
    if (loadedEndSec >= desiredLoadedEndSec) {
      return
    }
    if (rawStreamRequestId && options.rawStreamActive.value) {
      continueRawWaveformStream(rawStreamRequestId)
      return
    }
    if (isEditWindowRawStream()) {
      restartRawWaveformStreamAt(viewportAnchorSec, false, {
        bootstrapDurationSec: options.bootstrapDurationSec(),
        forceLiveDecode: true,
        forceRestart: true,
        preserveDisplay: canPreservePlaybackDisplayForStreamRestart(viewportAnchorSec)
      })
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
