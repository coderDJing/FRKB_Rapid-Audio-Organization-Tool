import { ref } from 'vue'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import {
  clampHorizontalBrowsePreviewStartByVisibleDuration,
  resolveHorizontalBrowsePlaybackAlignedStart
} from '@renderer/components/horizontalBrowseDetailMath'
import {
  HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM,
  HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO,
  HORIZONTAL_BROWSE_DETAIL_VISIBLE_DURATION_BASE_SEC
} from '@renderer/components/horizontalBrowseWaveform.constants'
import { parseHorizontalBrowseDurationToSeconds } from '@renderer/components/horizontalBrowseShellState'
import {
  PREVIEW_MAX_SAMPLES_PER_PIXEL,
  clampNumber
} from '@renderer/components/MixtapeBeatAlignDialog.constants'
import { startHorizontalBrowseUserTiming } from '@renderer/components/horizontalBrowseUserTiming'
import { isRawPlaceholderMixxxData } from '@renderer/components/beatGridWaveformData'
import { resolveHorizontalBrowseWaveformThemeVariant } from '@renderer/components/horizontalBrowseWaveformDetail.utils'
import { createHorizontalBrowseDetailLiveCanvasBridge } from '@renderer/components/horizontalBrowseDetailLiveCanvasBridge'
import { HORIZONTAL_BROWSE_DETAIL_OVERLAY_EXTEND_PX } from '@renderer/components/horizontalBrowseDetailOverlayCanvas'
import { resolvePixelSnappedCssSize } from '@renderer/components/horizontalBrowseCanvasGeometry'
import {
  isHorizontalBrowseRawDataCoveringRange,
  isHorizontalBrowseRawDataIntersectingRange,
  resolveHorizontalBrowsePlaybackDurationSec
} from '@renderer/components/horizontalBrowseRawWaveformCoverage'
import type {
  HorizontalBrowseWaveformLayout,
  HorizontalBrowseWaveformRenderStyle,
  UseHorizontalBrowseRawWaveformCanvasOptions
} from '@renderer/components/horizontalBrowseRawWaveformCanvasTypes'
import { normalizeSongHotCues } from '@shared/hotCues'
import { normalizeSongMemoryCues } from '@shared/memoryCues'
import type {
  HorizontalBrowseDetailLiveCanvasLoopRange,
  HorizontalBrowseDetailLiveCanvasRawChunk,
  HorizontalBrowseDetailLiveCanvasRawMeta,
  HorizontalBrowseDetailLiveCanvasWorkerOutgoing
} from '@renderer/workers/horizontalBrowseDetailLiveCanvas.types'

type LiveCanvasRenderedPayload = Extract<
  HorizontalBrowseDetailLiveCanvasWorkerOutgoing,
  { type: 'rendered' }
>['payload']
type LiveCanvasPresentationPayload = Extract<
  HorizontalBrowseDetailLiveCanvasWorkerOutgoing,
  { type: 'presentation' }
>['payload']

const RAW_STREAM_REDRAW_INTERVAL_MS = 80
const DEFERRED_RAW_STREAM_REDRAW_INTERVAL_MS = 160
const PLAYBACK_DIRTY_PATCH_MAX_VISIBLE_RATIO = 0.25
const PLAYBACK_RAW_SETTLE_HOLD_MS = 360
const DEFAULT_CUE_ACCENT_COLOR = '#d98921'
const ATTACK_SAFE_RAW_PEAK_MAX_SEC_PER_RENDER_PIXEL = 0.002

const shouldUseAttackSafeRawPeaks = (
  rangeDurationSec: number,
  cssWidth: number,
  pixelRatio: number,
  waveformRenderStyle: HorizontalBrowseWaveformRenderStyle
) => {
  if (waveformRenderStyle !== 'columns') return false
  const safeRangeDurationSec = Number(rangeDurationSec)
  if (!Number.isFinite(safeRangeDurationSec) || safeRangeDurationSec <= 0) return false
  const safePixelRatio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1
  const renderPixels = Math.max(1, Math.floor(Math.max(1, cssWidth) * safePixelRatio))
  const secondsPerRenderPixel = safeRangeDurationSec / renderPixels
  return (
    Number.isFinite(secondsPerRenderPixel) &&
    secondsPerRenderPixel > 0 &&
    secondsPerRenderPixel <= ATTACK_SAFE_RAW_PEAK_MAX_SEC_PER_RENDER_PIXEL
  )
}

export const useHorizontalBrowseRawWaveformCanvas = (
  options: UseHorizontalBrowseRawWaveformCanvasOptions
) => {
  const wrapRef = ref<HTMLDivElement | null>(null)
  const waveformCanvasRef = ref<HTMLCanvasElement | null>(null)
  const gridCanvasRef = ref<HTMLCanvasElement | null>(null)
  const overlayCanvasRef = ref<HTMLCanvasElement | null>(null)

  let drawRaf = 0
  let streamDrawRaf = 0
  let streamDrawTimer: ReturnType<typeof setTimeout> | null = null
  let nextAllowedStreamDrawAt = 0
  let pendingRawStreamDirtyStartSec: number | null = null
  let pendingRawStreamDirtyEndSec: number | null = null
  let liveCanvasRenderToken = 0
  let liveCanvasAttached = false
  let retainedWaveformFilePath = ''
  let retainedRawData: RawWaveformData | null = null
  let retainedMixxxData: MixxxWaveformData | null = null
  let holdPreviousWaveformFrame = false
  let forceNextRawStreamCoverageFullDraw = false
  // stream 重启到首个 live raw 之前禁止复用旧像素；首帧落位后必须立刻交回 worker 连续滚动。
  let suppressNextPlaybackScrollReuse = false
  // 引用稳定才允许 scroll reuse；新 rawData ref 必须等覆盖充分再整帧绘制。
  let lastStreamRenderedRawData: RawWaveformData | null = null
  let lastDrawPlaybackActive = false
  // worker overlay 独立渲染，即使 displayReady=false，也会跟随当前 range 立即更新。
  const displayStartSec = ref(0)
  const displayReady = ref(false)
  let lastQueuedPlaybackSyncRevision = -1
  let playbackRawSettleUntilMs = 0
  let lastQueuedPlaybackRawSlot: 'live' | 'retained' | null = null
  let lastQueuedMissingPlaybackRawSyncRevision = -1
  // 播放续流只补 raw 数据，不应触发 seek/load 那种黑屏重建。
  let preservePlaybackDisplayUntilRawReady = false

  const liveCanvasBridge = createHorizontalBrowseDetailLiveCanvasBridge({
    onRendered: (payload) => handleLiveCanvasRendered(payload),
    onPresentation: (payload) => handleLiveCanvasPresentation(payload)
  })

  const setDisplayReady = (ready: boolean) => {
    if (!ready) {
      preservePlaybackDisplayUntilRawReady = false
    }
    displayReady.value = ready
  }

  const resolvePreviewTimeScale = () =>
    Math.max(0.25, Number(options.visualPlaybackRate?.() ?? options.playbackRate()) || 1)

  const resolveWaveformGain = () => {
    const numeric = Number(options.waveformGain?.() ?? 1)
    if (!Number.isFinite(numeric)) return 1
    return clampNumber(numeric, 0, 16)
  }

  const resolvePreviewDurationSec = () => {
    const duration = Number(
      options.rawData.value?.duration ||
        options.mixxxData.value?.duration ||
        parseHorizontalBrowseDurationToSeconds(options.song()?.duration) ||
        0
    )
    return Number.isFinite(duration) && duration > 0 ? duration : 0
  }

  const resolveVisibleDurationSec = () =>
    Math.max(
      0.001,
      (HORIZONTAL_BROWSE_DETAIL_VISIBLE_DURATION_BASE_SEC * resolvePreviewTimeScale()) /
        Number(options.previewZoom.value || HORIZONTAL_BROWSE_DETAIL_MIN_ZOOM)
    )

  const resolvePreviewAnchorSec = () => {
    const duration = resolvePreviewDurationSec()
    const visibleDuration = resolveVisibleDurationSec()
    if (!duration || !visibleDuration) return 0
    const anchorSec =
      options.previewStartSec.value + visibleDuration * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
    return options.allowNegativeTimeline()
      ? Math.min(Number.isFinite(anchorSec) ? anchorSec : 0, duration)
      : clampNumber(anchorSec, 0, duration)
  }

  const clampPreviewStart = (value: number) => {
    const duration = resolvePreviewDurationSec()
    const visibleDuration = resolveVisibleDurationSec()
    return clampHorizontalBrowsePreviewStartByVisibleDuration(
      value,
      duration,
      visibleDuration,
      options.allowNegativeTimeline()
    )
  }

  const resolveSnappedRenderStartSec = (visibleDuration: number) => {
    const clampedStart = clampPreviewStart(options.previewStartSec.value)
    if (visibleDuration <= 0) return clampedStart
    // 保留连续时间，避免 seek 后出现 0px / 1px / 2px 的规律跳动。
    return clampedStart
  }

  const resolvePlaybackDrivenRenderStartSec = (visibleDuration: number) => {
    if (!options.playing.value || options.dragging.value) {
      return resolveSnappedRenderStartSec(visibleDuration)
    }
    const playbackSeconds = Number(options.currentSeconds()) || 0
    return resolvePlaybackAlignedStart(playbackSeconds)
  }

  const resolveWaveformLayout = (): HorizontalBrowseWaveformLayout => options.waveformLayout()

  const resolvePlaybackAlignedStart = (seconds: number) =>
    resolveHorizontalBrowsePlaybackAlignedStart(
      seconds,
      resolvePreviewDurationSec(),
      resolveVisibleDurationSec(),
      options.allowNegativeTimeline()
    )

  const clearRawStreamDirtyRange = () => {
    pendingRawStreamDirtyStartSec = null
    pendingRawStreamDirtyEndSec = null
  }

  const resolveDeferredVisualProtection = () =>
    options.deferWaveformLoad.value && !options.playing.value

  const isPlaybackDirtyPatchRedundant = () => {
    if (!options.playing.value || options.dragging.value || !displayReady.value) return false
    const raw = options.rawData.value
    if (!raw) return true
    const duration = resolvePreviewDurationSec()
    const visibleDuration = Math.max(0.001, resolveVisibleDurationSec() || duration || 0.001)
    const renderStartSec = resolvePlaybackDrivenRenderStartSec(visibleDuration)
    return isRawDataCoveringRange(raw, renderStartSec, visibleDuration)
  }

  const resolveCueAccentColor = () => {
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue('--shell-cue-accent')
      .trim()
    return value || DEFAULT_CUE_ACCENT_COLOR
  }

  const resolveWorkerLoopRange = (): HorizontalBrowseDetailLiveCanvasLoopRange | null => {
    const loopRange = options.loopRange()
    if (!loopRange) return null
    const startSec = Math.max(0, Number(loopRange.startSec) || 0)
    const endSec = Math.max(startSec, Number(loopRange.endSec ?? loopRange.startSec) || startSec)
    return {
      startSec,
      endSec
    }
  }

  const resetRetainedWaveformData = () => {
    liveCanvasRenderToken += 1
    liveCanvasBridge.clearRaw()
    retainedWaveformFilePath = ''
    retainedRawData = null
    retainedMixxxData = null
    holdPreviousWaveformFrame = false
    suppressNextPlaybackScrollReuse = false
    lastDrawPlaybackActive = false
    lastStreamRenderedRawData = null
    playbackRawSettleUntilMs = 0
    lastQueuedPlaybackRawSlot = null
    lastQueuedMissingPlaybackRawSyncRevision = -1
    clearLiveCanvasPresentationOffset()
    // 外部重置 retained（例如切歌、loadWaveform）会清掉 canvas 上所有可用像素。
    setDisplayReady(false)
  }

  const holdCurrentWaveformFrame = () => {
    holdPreviousWaveformFrame = true
    suppressNextPlaybackScrollReuse = false
  }

  const resetRawStreamDrawState = (resetOptions: { preserveDisplay?: boolean } = {}) => {
    const preserveDisplay = resetOptions.preserveDisplay === true && displayReady.value
    if (preserveDisplay) {
      preservePlaybackDisplayUntilRawReady = true
    } else {
      preservePlaybackDisplayUntilRawReady = false
      liveCanvasRenderToken += 1
      setDisplayReady(false)
      liveCanvasBridge.clear()
    }
    if (!preserveDisplay) {
      lastStreamRenderedRawData = null
      suppressNextPlaybackScrollReuse = true
      forceNextRawStreamCoverageFullDraw = true
    }
    playbackRawSettleUntilMs = 0
    lastQueuedPlaybackRawSlot = null
    lastQueuedMissingPlaybackRawSyncRevision = -1
    clearRawStreamDirtyRange()
    cancelStreamDrawFrameScheduling()
  }

  const cancelStreamDrawFrameScheduling = () => {
    if (streamDrawTimer) {
      clearTimeout(streamDrawTimer)
      streamDrawTimer = null
    }
    if (streamDrawRaf) {
      cancelAnimationFrame(streamDrawRaf)
      streamDrawRaf = 0
    }
  }

  const clearStreamDrawScheduling = () => {
    cancelStreamDrawFrameScheduling()
    clearRawStreamDirtyRange()
  }

  const clearCanvas = () => {
    liveCanvasRenderToken += 1
    liveCanvasBridge.clear()
    clearLiveCanvasPresentationOffset()
    for (const canvas of [gridCanvasRef.value]) {
      if (!canvas) continue
      const ctx = canvas.getContext('2d')
      if (!ctx) continue
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
  }

  const clearGridCanvas = () => {
    const canvas = gridCanvasRef.value
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }

  const ensureLiveCanvasMounted = () => {
    if (liveCanvasAttached) return true
    liveCanvasAttached = liveCanvasBridge.mount(waveformCanvasRef.value, overlayCanvasRef.value)
    return liveCanvasAttached
  }

  const resolveRawSlotForRender = (rawData: RawWaveformData | null) => {
    if (!rawData) return null
    if (rawData === options.rawData.value) return 'live'
    if (rawData === retainedRawData) return 'retained'
    return 'live'
  }

  const handleLiveCanvasRendered = (payload: LiveCanvasRenderedPayload) => {
    if (payload.renderToken !== liveCanvasRenderToken) return
    displayStartSec.value = payload.rangeStartSec
    if (!payload.ready) {
      setDisplayReady(false)
      return
    }
    preservePlaybackDisplayUntilRawReady = false
    setDisplayReady(true)
  }

  const clearLiveCanvasPresentationOffset = () => {
    waveformCanvasRef.value?.style.removeProperty('transform')
  }

  const handleLiveCanvasPresentation = (payload: LiveCanvasPresentationPayload) => {
    if (payload.renderToken !== liveCanvasRenderToken) return
    const canvas = waveformCanvasRef.value
    if (!canvas) return
    const offsetCssPx = Number(payload.offsetCssPx) || 0
    if (Math.abs(offsetCssPx) <= 0.001) {
      canvas.style.removeProperty('transform')
      return
    }
    canvas.style.transform = `translate3d(${offsetCssPx}px, 0, 0)`
  }

  const queueLiveWaveformRender = (payload: {
    rangeStartSec: number
    rangeDurationSec: number
    rawData: RawWaveformData | null
    maxSamplesPerPixel: number
    allowScrollReuse: boolean
    preferRawPeaksOnly: boolean
    dirtyStartSec?: number
    dirtyEndSec?: number
    completeSeekTransition?: boolean
  }) => {
    const wrap = wrapRef.value
    if (!wrap || !ensureLiveCanvasMounted()) return false
    const wrapRect = wrap.getBoundingClientRect()
    const waveformLayout = resolveWaveformLayout()
    const waveformRenderStyle = options.waveformRenderStyle()
    const pixelRatio = window.devicePixelRatio || 1
    const wrapWidth = Math.max(1, wrapRect.width || wrap.clientWidth || 0)
    const wrapHeight = Math.max(1, wrapRect.height || wrap.clientHeight || 0)
    const width = resolvePixelSnappedCssSize(wrapWidth, pixelRatio)
    const height = resolvePixelSnappedCssSize(wrapHeight, pixelRatio)
    const setCanvasGeometry = (
      canvas: HTMLCanvasElement | null,
      left: number,
      top: number,
      canvasWidth: number,
      canvasHeight: number
    ) => {
      if (!canvas) return
      canvas.style.left = `${left}px`
      canvas.style.top = `${top}px`
      canvas.style.right = 'auto'
      canvas.style.bottom = 'auto'
      canvas.style.width = `${canvasWidth}px`
      canvas.style.height = `${canvasHeight}px`
    }
    setCanvasGeometry(waveformCanvasRef.value, 0, 0, width, height)
    setCanvasGeometry(
      overlayCanvasRef.value,
      0,
      -HORIZONTAL_BROWSE_DETAIL_OVERLAY_EXTEND_PX,
      width,
      height + HORIZONTAL_BROWSE_DETAIL_OVERLAY_EXTEND_PX * 2
    )
    const isPlaybackDirtyPatch =
      options.playing.value &&
      !options.dragging.value &&
      (typeof payload.dirtyStartSec === 'number' || typeof payload.dirtyEndSec === 'number') &&
      liveCanvasRenderToken > 0
    const rawSlot = resolveRawSlotForRender(payload.rawData)
    const playbackSyncRevision = Math.max(
      0,
      Math.floor(Number(options.playbackSyncRevision.value) || 0)
    )
    const preferRawPeaksOnly =
      payload.preferRawPeaksOnly ||
      (waveformLayout === 'full' && waveformRenderStyle === 'columns') ||
      shouldUseAttackSafeRawPeaks(payload.rangeDurationSec, width, pixelRatio, waveformRenderStyle)
    const nowMs = performance.now()
    const playbackActive = options.playing.value && !options.dragging.value
    const playbackSyncChanged =
      playbackActive && playbackSyncRevision !== lastQueuedPlaybackSyncRevision
    const playbackRawRecovering =
      playbackActive && !isPlaybackDirtyPatch && !!rawSlot && !displayReady.value
    const allowScrollReuse = payload.allowScrollReuse && !playbackSyncChanged
    if (playbackSyncChanged) {
      playbackRawSettleUntilMs = nowMs + PLAYBACK_RAW_SETTLE_HOLD_MS
      lastQueuedPlaybackRawSlot = null
      liveCanvasBridge.stopPlayback()
    }
    if (!playbackActive) {
      playbackRawSettleUntilMs = 0
      lastQueuedPlaybackRawSlot = null
      lastQueuedMissingPlaybackRawSyncRevision = -1
    }
    lastQueuedPlaybackSyncRevision = playbackSyncRevision
    if (playbackActive && !isPlaybackDirtyPatch && !rawSlot && !displayReady.value) {
      if (lastQueuedMissingPlaybackRawSyncRevision === playbackSyncRevision) {
        return false
      }
      lastQueuedMissingPlaybackRawSyncRevision = playbackSyncRevision
    } else if (rawSlot) {
      lastQueuedMissingPlaybackRawSyncRevision = -1
    }
    if (
      playbackActive &&
      !isPlaybackDirtyPatch &&
      rawSlot &&
      lastQueuedPlaybackRawSlot === rawSlot &&
      displayReady.value &&
      nowMs < playbackRawSettleUntilMs
    ) {
      return false
    }
    const renderToken = isPlaybackDirtyPatch ? liveCanvasRenderToken : liveCanvasRenderToken + 1
    if (!isPlaybackDirtyPatch) {
      liveCanvasRenderToken = renderToken
    }
    liveCanvasBridge.render({
      renderToken,
      width,
      height,
      pixelRatio,
      bpm: Number(options.previewBpm.value) || 0,
      firstBeatMs: Number(options.previewFirstBeatMs.value) || 0,
      barBeatOffset: Number(options.previewBarBeatOffset.value) || 0,
      timeBasisOffsetMs: Number(options.previewTimeBasisOffsetMs.value) || 0,
      rangeStartSec: payload.rangeStartSec,
      rangeDurationSec: payload.rangeDurationSec,
      maxSamplesPerPixel: payload.maxSamplesPerPixel,
      showDetailHighlights: false,
      showCenterLine: false,
      showBackground: false,
      showBeatGrid: Number(options.previewBpm.value) > 0,
      allowScrollReuse,
      phaseAwareScrollReuse: allowScrollReuse && options.phaseAwareScrollReuse?.() === true,
      waveformLayout,
      waveformRenderStyle,
      preferRawPeaksOnly,
      themeVariant: resolveHorizontalBrowseWaveformThemeVariant(),
      rawSlot,
      direction: options.direction(),
      cueSeconds: Number.isFinite(Number(options.cueSeconds()))
        ? Number(options.cueSeconds())
        : null,
      hotCues: normalizeSongHotCues(options.hotCues()),
      memoryCues: normalizeSongMemoryCues(options.memoryCues()),
      loopRange: resolveWorkerLoopRange(),
      cueAccentColor: resolveCueAccentColor(),
      playbackActive,
      playbackSeconds: Number(options.currentSeconds()) || 0,
      playbackSyncRevision,
      playbackRate: Math.max(0.25, Number(options.playbackRate()) || 1),
      playbackDurationSec: resolvePlaybackDurationSecForRender(payload.rawData),
      waveformGain: resolveWaveformGain(),
      dirtyStartSec: payload.dirtyStartSec,
      dirtyEndSec: payload.dirtyEndSec
    })
    if (playbackRawRecovering) {
      playbackRawSettleUntilMs = Math.max(
        playbackRawSettleUntilMs,
        nowMs + PLAYBACK_RAW_SETTLE_HOLD_MS
      )
    }
    lastQueuedPlaybackRawSlot = playbackActive ? rawSlot : null
    return true
  }

  const resolveTimeBasisOffsetSec = () =>
    Math.max(0, Number(options.previewTimeBasisOffsetMs.value) || 0) / 1000

  const resolvePlaybackDurationSecForRender = (rawData: RawWaveformData | null) => {
    return resolveHorizontalBrowsePlaybackDurationSec(
      rawData,
      resolvePreviewDurationSec(),
      resolveTimeBasisOffsetSec()
    )
  }

  const isRawDataCoveringRange = (
    rawData: RawWaveformData | null,
    rangeStartSec: number,
    rangeDurationSec: number
  ) => {
    return isHorizontalBrowseRawDataCoveringRange(
      rawData,
      rangeStartSec,
      rangeDurationSec,
      resolveTimeBasisOffsetSec()
    )
  }

  const isRawDataIntersectingRange = (
    rawData: RawWaveformData | null,
    rangeStartSec: number,
    rangeDurationSec: number
  ) => {
    return isHorizontalBrowseRawDataIntersectingRange(
      rawData,
      rangeStartSec,
      rangeDurationSec,
      resolveTimeBasisOffsetSec()
    )
  }

  const resolveActiveMixxxSelection = () => {
    const liveMixxxData = options.mixxxData.value
    if (liveMixxxData && !isRawPlaceholderMixxxData(liveMixxxData)) {
      return { data: liveMixxxData, source: 'live' as const }
    }
    if (liveMixxxData) {
      return { data: liveMixxxData, source: 'placeholder' as const }
    }
    return { data: null, source: 'none' as const }
  }

  const invalidateWaveformTiles = () => {
    liveCanvasRenderToken += 1
    liveCanvasBridge.clear()
  }

  const storeRawWaveform = (filePath: string, data: RawWaveformData) => {
    void filePath
    void data
  }

  const drawWaveform = () => {
    const wrap = wrapRef.value
    const waveformCanvas = waveformCanvasRef.value
    if (!wrap || !waveformCanvas) return

    const duration = resolvePreviewDurationSec()
    if (!duration) {
      clearCanvas()
      setDisplayReady(false)
      return
    }

    const visibleDuration = Math.max(0.001, resolveVisibleDurationSec() || duration || 0.001)
    options.previewStartSec.value = clampPreviewStart(options.previewStartSec.value)
    const renderStartSec = resolvePlaybackDrivenRenderStartSec(visibleDuration)
    const wasDisplayReady = displayReady.value
    const forceRawStreamCoverageFullDraw = forceNextRawStreamCoverageFullDraw
    forceNextRawStreamCoverageFullDraw = false
    const playbackStreamReuse = options.playing.value && !options.dragging.value
    const playbackStartedThisDraw = playbackStreamReuse && !lastDrawPlaybackActive
    lastDrawPlaybackActive = playbackStreamReuse
    const canReusePlaybackScroll =
      playbackStreamReuse &&
      wasDisplayReady &&
      !suppressNextPlaybackScrollReuse &&
      !forceRawStreamCoverageFullDraw &&
      !playbackStartedThisDraw
    const streamMaxSamplesPerPixel = PREVIEW_MAX_SAMPLES_PER_PIXEL
    const currentFilePath = String(options.song()?.filePath || '').trim()
    const activeMixxxSelection = resolveActiveMixxxSelection()
    const canUseRetainedWaveform =
      options.rawStreamActive.value &&
      !!currentFilePath &&
      currentFilePath === retainedWaveformFilePath &&
      !!retainedRawData

    // seek 重启 stream 会换 live rawData；新数据未覆盖前优先复用可覆盖的 retained。
    const liveRawData = options.rawData.value
    const liveRawCovers = isRawDataCoveringRange(liveRawData, renderStartSec, visibleDuration)
    const retainedRawCovers =
      canUseRetainedWaveform &&
      isRawDataCoveringRange(retainedRawData, renderStartSec, visibleDuration)
    const preferRetainedRaw =
      !!liveRawData && !liveRawCovers && retainedRawCovers && liveRawData !== retainedRawData

    let effectiveRawData: RawWaveformData | null
    let effectiveMixxxSelection: {
      data: MixxxWaveformData | null
      source: 'live' | 'placeholder' | 'retained' | 'retained-placeholder' | 'none'
    }
    if (preferRetainedRaw) {
      effectiveRawData = retainedRawData
      effectiveMixxxSelection = retainedMixxxData
        ? {
            data: retainedMixxxData,
            source: isRawPlaceholderMixxxData(retainedMixxxData)
              ? 'retained-placeholder'
              : 'retained'
          }
        : activeMixxxSelection.data
          ? activeMixxxSelection
          : { data: null, source: 'none' }
    } else if (liveRawData) {
      effectiveRawData = liveRawData
      effectiveMixxxSelection = activeMixxxSelection.data
        ? activeMixxxSelection
        : canUseRetainedWaveform && retainedMixxxData
          ? {
              data: retainedMixxxData,
              source: isRawPlaceholderMixxxData(retainedMixxxData)
                ? 'retained-placeholder'
                : 'retained'
            }
          : { data: null, source: 'none' }
    } else if (canUseRetainedWaveform && retainedRawData) {
      effectiveRawData = retainedRawData
      effectiveMixxxSelection = retainedMixxxData
        ? {
            data: retainedMixxxData,
            source: isRawPlaceholderMixxxData(retainedMixxxData)
              ? 'retained-placeholder'
              : 'retained'
          }
        : activeMixxxSelection.data
          ? activeMixxxSelection
          : { data: null, source: 'none' }
    } else {
      effectiveRawData = null
      effectiveMixxxSelection = activeMixxxSelection.data
        ? activeMixxxSelection
        : { data: null, source: 'none' }
    }

    const effectiveMixxxData = effectiveMixxxSelection.data
    const effectiveRawCoverage = isRawDataCoveringRange(
      effectiveRawData,
      renderStartSec,
      visibleDuration
    )
    const allowPlaybackScrollReuse = canReusePlaybackScroll
    const effectiveRawIntersection = isRawDataIntersectingRange(
      effectiveRawData,
      renderStartSec,
      visibleDuration
    )
    const drawableRawData = effectiveRawIntersection ? effectiveRawData : null
    const canRenderWithoutRawCoverage =
      effectiveMixxxSelection.source === 'live' || effectiveMixxxSelection.source === 'retained'
    const shouldPreserveDisplay = preservePlaybackDisplayUntilRawReady && wasDisplayReady
    const shouldHoldPlaybackFrame = playbackStreamReuse && wasDisplayReady

    const commitRetainedFromDrawn = () => {
      if (!currentFilePath) return
      if (!drawableRawData) return
      retainedWaveformFilePath = currentFilePath
      retainedRawData = drawableRawData
      if (activeMixxxSelection.source === 'live' && activeMixxxSelection.data) {
        retainedMixxxData = activeMixxxSelection.data
      }
    }

    if (!effectiveMixxxData && !drawableRawData) {
      if (shouldPreserveDisplay || shouldHoldPlaybackFrame) {
        return
      }
      lastStreamRenderedRawData = null
      // 完全无高清波形可画：只清波形层；时间线 overlay 仍按当前 range 渲染。
      setDisplayReady(false)
      queueLiveWaveformRender({
        rangeStartSec: renderStartSec,
        rangeDurationSec: visibleDuration,
        rawData: null,
        maxSamplesPerPixel: streamMaxSamplesPerPixel,
        allowScrollReuse: false,
        preferRawPeaksOnly: false
      })
    } else if (options.playing.value || options.rawStreamActive.value || options.dragging.value) {
      // 稳定 ref 才允许滚动复用；播放恢复期不能提交 partial raw，避免隐藏 full render 挤占 worker。
      const rawDataRefStable =
        drawableRawData != null && drawableRawData === lastStreamRenderedRawData
      const allowPartialViewportPaint =
        Boolean(drawableRawData) &&
        !holdPreviousWaveformFrame &&
        !playbackStreamReuse &&
        (options.dragging.value || !options.playing.value || !wasDisplayReady)
      const canDrawStream =
        Boolean(drawableRawData) &&
        (effectiveRawCoverage ||
          (allowPlaybackScrollReuse && rawDataRefStable) ||
          allowPartialViewportPaint)
      if (!canDrawStream) {
        if (shouldPreserveDisplay || shouldHoldPlaybackFrame) {
          return
        }
        lastStreamRenderedRawData = null
        setDisplayReady(false)
        queueLiveWaveformRender({
          rangeStartSec: renderStartSec,
          rangeDurationSec: visibleDuration,
          rawData: null,
          maxSamplesPerPixel: streamMaxSamplesPerPixel,
          allowScrollReuse: false,
          preferRawPeaksOnly: false
        })
      } else {
        holdPreviousWaveformFrame = false
        const finishTiming = startHorizontalBrowseUserTiming(
          `frkb:hb:canvas:stream-live:${options.direction()}`
        )
        const queued = queueLiveWaveformRender({
          rangeStartSec: renderStartSec,
          rangeDurationSec: visibleDuration,
          rawData: drawableRawData,
          maxSamplesPerPixel: streamMaxSamplesPerPixel,
          allowScrollReuse: allowPlaybackScrollReuse,
          preferRawPeaksOnly: false,
          completeSeekTransition: effectiveRawCoverage
        })
        if (queued) {
          lastStreamRenderedRawData = drawableRawData
          commitRetainedFromDrawn()
        }
        suppressNextPlaybackScrollReuse = false
        finishTiming()
      }
    } else if (!drawableRawData && !canRenderWithoutRawCoverage) {
      if (shouldPreserveDisplay) return
      lastStreamRenderedRawData = null
      setDisplayReady(false)
      queueLiveWaveformRender({
        rangeStartSec: renderStartSec,
        rangeDurationSec: visibleDuration,
        rawData: null,
        maxSamplesPerPixel: streamMaxSamplesPerPixel,
        allowScrollReuse: false,
        preferRawPeaksOnly: false
      })
    } else {
      holdPreviousWaveformFrame = false
      const finishTiming = startHorizontalBrowseUserTiming(
        `frkb:hb:canvas:worker-live:${options.direction()}`
      )
      const queued = queueLiveWaveformRender({
        rangeStartSec: renderStartSec,
        rangeDurationSec: visibleDuration,
        rawData: drawableRawData,
        maxSamplesPerPixel: streamMaxSamplesPerPixel,
        allowScrollReuse: allowPlaybackScrollReuse,
        preferRawPeaksOnly: false,
        completeSeekTransition: effectiveRawCoverage
      })
      if (queued) {
        lastStreamRenderedRawData = drawableRawData
        commitRetainedFromDrawn()
      }
      suppressNextPlaybackScrollReuse = false
      finishTiming()
    }
  }

  const flushRawStreamDirtyDraw = () => {
    if (streamDrawTimer) {
      clearTimeout(streamDrawTimer)
      streamDrawTimer = null
    }
    streamDrawRaf = 0
    const dirtyStartSec = pendingRawStreamDirtyStartSec
    const dirtyEndSec = pendingRawStreamDirtyEndSec
    nextAllowedStreamDrawAt =
      performance.now() +
      (resolveDeferredVisualProtection()
        ? DEFERRED_RAW_STREAM_REDRAW_INTERVAL_MS
        : RAW_STREAM_REDRAW_INTERVAL_MS)

    if (
      dirtyStartSec === null ||
      dirtyEndSec === null ||
      !options.rawStreamActive.value ||
      options.dragging.value ||
      !options.rawData.value ||
      !options.mixxxData.value ||
      !waveformCanvasRef.value ||
      !wrapRef.value
    ) {
      clearRawStreamDirtyRange()
      scheduleDraw()
      return
    }

    const duration = resolvePreviewDurationSec()
    if (!duration) {
      clearRawStreamDirtyRange()
      scheduleDraw()
      return
    }

    // 高清波形层未就绪时，让整帧逻辑决定是否清波形层，overlay 继续推进。
    if (!displayReady.value) {
      scheduleDraw()
      return
    }

    if (isPlaybackDirtyPatchRedundant()) {
      clearRawStreamDirtyRange()
      return
    }

    const visibleDuration = Math.max(0.001, resolveVisibleDurationSec() || duration || 0.001)
    options.previewStartSec.value = clampPreviewStart(options.previewStartSec.value)
    const renderStartSec = resolvePlaybackDrivenRenderStartSec(visibleDuration)
    const playbackStreamReuse = options.playing.value && !options.dragging.value
    const dirtyViewStartSec = Math.max(dirtyStartSec, renderStartSec)
    const dirtyViewEndSec = Math.min(dirtyEndSec, renderStartSec + visibleDuration)
    if (dirtyViewEndSec <= dirtyViewStartSec) {
      clearRawStreamDirtyRange()
      return
    }
    const maxPlaybackDirtyDurationSec = playbackStreamReuse
      ? Math.max(0.5, visibleDuration * PLAYBACK_DIRTY_PATCH_MAX_VISIBLE_RATIO)
      : Infinity
    const patchStartSec = dirtyViewStartSec
    const patchEndSec = Math.min(dirtyViewEndSec, patchStartSec + maxPlaybackDirtyDurationSec)
    if (patchEndSec < dirtyEndSec - 0.0001) {
      pendingRawStreamDirtyStartSec = patchEndSec
      pendingRawStreamDirtyEndSec = dirtyEndSec
    } else {
      clearRawStreamDirtyRange()
    }
    const finishTiming = startHorizontalBrowseUserTiming(
      `frkb:hb:canvas:stream-dirty:${options.direction()}`
    )

    queueLiveWaveformRender({
      rangeStartSec: renderStartSec,
      rangeDurationSec: visibleDuration,
      rawData: options.rawData.value,
      maxSamplesPerPixel: PREVIEW_MAX_SAMPLES_PER_PIXEL,
      allowScrollReuse: true,
      preferRawPeaksOnly: false,
      dirtyStartSec: patchStartSec,
      dirtyEndSec: patchEndSec
    })
    schedulePendingRawStreamDirtyDraw()
    finishTiming()
  }

  const hasPendingRawStreamDirtyRange = () =>
    pendingRawStreamDirtyStartSec !== null && pendingRawStreamDirtyEndSec !== null

  const schedulePendingRawStreamDirtyDraw = () => {
    if (!hasPendingRawStreamDirtyRange()) return
    if (drawRaf || streamDrawRaf || streamDrawTimer) return
    const now = performance.now()
    const delayMs = Math.max(0, nextAllowedStreamDrawAt - now)
    if (delayMs <= 0) {
      streamDrawRaf = requestAnimationFrame(() => {
        flushRawStreamDirtyDraw()
      })
      return
    }

    streamDrawTimer = setTimeout(() => {
      streamDrawTimer = null
      if (streamDrawRaf) return
      streamDrawRaf = requestAnimationFrame(() => {
        flushRawStreamDirtyDraw()
      })
    }, delayMs)
  }

  const scheduleRawStreamDirtyDraw = (dirtyStartSec: number, dirtyEndSec: number) => {
    const safeStartSec = Math.max(0, Math.min(dirtyStartSec, dirtyEndSec))
    const safeEndSec = Math.max(safeStartSec, dirtyEndSec)
    if (preservePlaybackDisplayUntilRawReady) {
      scheduleDraw()
      return
    }
    if (isPlaybackDirtyPatchRedundant()) {
      clearRawStreamDirtyRange()
      return
    }
    pendingRawStreamDirtyStartSec =
      pendingRawStreamDirtyStartSec === null
        ? safeStartSec
        : Math.min(pendingRawStreamDirtyStartSec, safeStartSec)
    pendingRawStreamDirtyEndSec =
      pendingRawStreamDirtyEndSec === null
        ? safeEndSec
        : Math.max(pendingRawStreamDirtyEndSec, safeEndSec)

    schedulePendingRawStreamDirtyDraw()
  }

  const scheduleRawStreamCoverageDraw = () => {
    forceNextRawStreamCoverageFullDraw = true
    clearRawStreamDirtyRange()
    scheduleDraw()
  }

  const scheduleDraw = () => {
    cancelStreamDrawFrameScheduling()
    if (drawRaf) return
    drawRaf = requestAnimationFrame(() => {
      drawRaf = 0
      drawWaveform()
      schedulePendingRawStreamDirtyDraw()
    })
  }

  const scheduleGridOverlayDraw = () => {
    scheduleDraw()
  }

  const resetGridRenderer = () => {
    clearGridCanvas()
  }

  const mountWaveformCanvasWorker = () => {
    ensureLiveCanvasMounted()
  }

  const resetLiveWaveformRaw = (meta: HorizontalBrowseDetailLiveCanvasRawMeta) => {
    liveCanvasBridge.resetRaw(meta, true, preservePlaybackDisplayUntilRawReady)
  }

  const ensureLiveWaveformRawCapacity = (meta: HorizontalBrowseDetailLiveCanvasRawMeta) => {
    liveCanvasBridge.ensureRawCapacity(meta)
  }

  const applyLiveWaveformRawChunk = (
    chunk: HorizontalBrowseDetailLiveCanvasRawChunk,
    transferOwnership = false
  ) => {
    liveCanvasBridge.applyRawChunk(chunk, transferOwnership)
  }

  const replaceLiveWaveformRaw = (data: RawWaveformData | null) => {
    liveCanvasBridge.replaceRaw(data)
  }

  const stopLiveWaveformPlayback = () => {
    liveCanvasBridge.stopPlayback()
  }

  const updateLiveWaveformRawMeta = (meta: Partial<HorizontalBrowseDetailLiveCanvasRawMeta>) => {
    liveCanvasBridge.updateRawMeta(meta)
  }

  const dispose = () => {
    clearStreamDrawScheduling()
    resetRetainedWaveformData()
    liveCanvasAttached = false
    if (drawRaf) {
      cancelAnimationFrame(drawRaf)
      drawRaf = 0
    }
    liveCanvasBridge.dispose()
  }

  return {
    wrapRef,
    waveformCanvasRef,
    gridCanvasRef,
    overlayCanvasRef,
    resolvePreviewTimeScale,
    resolvePreviewDurationSec,
    resolveVisibleDurationSec,
    resolvePreviewAnchorSec,
    clampPreviewStart,
    resolveSnappedRenderStartSec,
    resolvePlaybackAlignedStart,
    scheduleRawStreamDirtyDraw,
    scheduleRawStreamCoverageDraw,
    resetRawStreamDrawState,
    clearStreamDrawScheduling,
    clearCanvas,
    invalidateWaveformTiles,
    mountWaveformCanvasWorker,
    scheduleDraw,
    scheduleGridOverlayDraw,
    resetGridRenderer,
    holdCurrentWaveformFrame,
    resetRetainedWaveformData,
    resetLiveWaveformRaw,
    stopLiveWaveformPlayback,
    ensureLiveWaveformRawCapacity,
    applyLiveWaveformRawChunk,
    replaceLiveWaveformRaw,
    updateLiveWaveformRawMeta,
    storeRawWaveform,
    displayStartSec,
    displayReady,
    dispose
  }
}
