import { ref, watch } from 'vue'
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
import { shouldUseAttackSafeRawPeaks } from '@renderer/components/horizontalBrowseRawWaveformCanvasPolicy'
import { startHorizontalBrowseUserTiming } from '@renderer/components/horizontalBrowseUserTiming'
import { isRawPlaceholderMixxxData } from '@renderer/components/beatGridWaveformData'
import { resolveHorizontalBrowseWaveformThemeVariant } from '@renderer/components/horizontalBrowseWaveformDetail.utils'
import { createHorizontalBrowseDetailLiveCanvasBridge } from '@renderer/components/horizontalBrowseDetailLiveCanvasBridge'
import { HORIZONTAL_BROWSE_DETAIL_OVERLAY_EXTEND_PX } from '@renderer/components/horizontalBrowseDetailOverlayCanvas'
import {
  applyHorizontalBrowseCanvasPresentationOffset,
  setHorizontalBrowseLiveCanvasGeometry,
  resolveHorizontalBrowseStableOverscanCssPx,
  resolvePixelSnappedCssSize
} from '@renderer/components/horizontalBrowseCanvasGeometry'
import { createHorizontalBrowseStableCanvasPresentationController } from '@renderer/components/horizontalBrowseStableCanvasPresentation'
import {
  isHorizontalBrowseRawDataCoveringRange,
  isHorizontalBrowseRawDataIntersectingRange,
  resolveHorizontalBrowsePlaybackDurationSec
} from '@renderer/components/horizontalBrowseRawWaveformCoverage'
import type {
  HorizontalBrowseWaveformLayout,
  UseHorizontalBrowseRawWaveformCanvasOptions
} from '@renderer/components/horizontalBrowseRawWaveformCanvasTypes'
import { normalizeSongHotCues } from '@shared/hotCues'
import { normalizeSongMemoryCues } from '@shared/memoryCues'
import { resolveHorizontalBrowseLinkedGridVisualPhase } from '@renderer/components/horizontalBrowseLinkedGridVisualPhase'
import type {
  HorizontalBrowseDetailLiveCanvasLoopRange,
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

const PLAYBACK_RAW_SETTLE_HOLD_MS = 360
const STABLE_VIEWPORT_RENDER_HOLD_MS = 90
const STABLE_FULL_RENDER_DELAY_MS = 96
const STABLE_SEEK_REVEAL_HOLD_MS = 90
const DEFAULT_CUE_ACCENT_COLOR = '#d98921'

export const useHorizontalBrowseRawWaveformCanvas = (
  options: UseHorizontalBrowseRawWaveformCanvasOptions
) => {
  const wrapRef = ref<HTMLDivElement | null>(null)
  const waveformSurfaceRef = ref<HTMLDivElement | null>(null)
  const overlaySurfaceRef = ref<HTMLDivElement | null>(null)
  const waveformCanvasRef = ref<HTMLCanvasElement | null>(null)
  const gridCanvasRef = ref<HTMLCanvasElement | null>(null)
  const overlayCanvasRef = ref<HTMLCanvasElement | null>(null)

  let drawRaf = 0
  let liveCanvasRenderToken = 0
  let liveCanvasAttached = false
  let suppressNextPlaybackScrollReuse = false
  // 引用稳定才允许 scroll reuse；新 rawData ref 必须等覆盖充分再整帧绘制。
  let lastRenderedRawData: RawWaveformData | null = null
  let lastDrawPlaybackActive = false
  // worker overlay 独立渲染，即使 displayReady=false，也会跟随当前 range 立即更新。
  const displayStartSec = ref(0)
  const displayReady = ref(false)
  const placeholderVisible = ref(false)
  let lastQueuedPlaybackSyncRevision = -1
  let playbackRawSettleUntilMs = 0
  let lastQueuedPlaybackRawSlot: 'live' | null = null
  let lastQueuedMissingPlaybackRawSyncRevision = -1
  let stableFullRenderTimer: ReturnType<typeof setTimeout> | null = null
  let stableViewportRenderPendingUntilMs = 0
  let displayReadyRevealTimer: ReturnType<typeof setTimeout> | null = null
  let displayReadyRevealGeneration = 0
  let stablePresentationRevealAfterMs = 0
  let stableSurfaceForceHidden = false
  let surfaceVisible: boolean | null = null

  const stablePresentation = createHorizontalBrowseStableCanvasPresentationController({
    isActive: () => resolveStableWaveformSource(),
    isPlaying: () => options.playing.value,
    isDragging: () => options.dragging.value,
    currentSeconds: () => Number(options.currentSeconds()) || 0,
    playbackRate: () => Number(options.playbackRate()) || 1,
    resolveViewportRangeStartSec: (seconds) => resolvePlaybackAlignedStart(seconds),
    waveformCanvas: () => waveformCanvasRef.value,
    overlayCanvas: () => overlayCanvasRef.value,
    scheduleDraw: () => drawWaveformNow(),
    debugLabel: () => options.direction()
  })

  const liveCanvasBridge = createHorizontalBrowseDetailLiveCanvasBridge({
    onRendered: (payload) => handleLiveCanvasRendered(payload),
    onPresentation: (payload) => handleLiveCanvasPresentation(payload)
  })

  const clearDisplayReadyRevealTimer = () => {
    if (!displayReadyRevealTimer) return
    clearTimeout(displayReadyRevealTimer)
    displayReadyRevealTimer = null
  }

  const forEachWaveformSurface = (visitor: (element: HTMLDivElement) => void) => {
    for (const element of [waveformSurfaceRef.value, overlaySurfaceRef.value]) {
      if (element) visitor(element)
    }
  }

  const setWaveformSurfaceVisible = (visible: boolean, fadeIn: boolean) => {
    if (surfaceVisible === visible) return
    surfaceVisible = visible
    forEachWaveformSurface((element) => {
      element.style.transition = visible && fadeIn ? 'opacity 100ms linear' : 'none'
      element.style.opacity = visible ? '1' : '0'
    })
  }

  const syncWaveformSurfaceVisibility = (fadeIn: boolean) => {
    setWaveformSurfaceVisible(
      !stableSurfaceForceHidden && (displayReady.value || placeholderVisible.value),
      fadeIn
    )
  }

  watch(
    [waveformSurfaceRef, overlaySurfaceRef],
    () => {
      surfaceVisible = null
      syncWaveformSurfaceVisibility(false)
    },
    { flush: 'post' }
  )

  const setDisplayReady = (ready: boolean) => {
    if (!ready) {
      clearDisplayReadyRevealTimer()
      displayReadyRevealGeneration += 1
      displayReady.value = false
      syncWaveformSurfaceVisibility(false)
      return
    }
    const nowMs = performance.now()
    if (nowMs < stablePresentationRevealAfterMs) {
      const generation = displayReadyRevealGeneration + 1
      displayReadyRevealGeneration = generation
      clearDisplayReadyRevealTimer()
      displayReadyRevealTimer = setTimeout(
        () => {
          if (displayReadyRevealGeneration !== generation) return
          displayReadyRevealTimer = null
          stableSurfaceForceHidden = false
          placeholderVisible.value = false
          displayReady.value = true
          syncWaveformSurfaceVisibility(true)
        },
        Math.max(0, stablePresentationRevealAfterMs - nowMs)
      )
      return
    }
    clearDisplayReadyRevealTimer()
    displayReadyRevealGeneration += 1
    if (ready) {
      stableSurfaceForceHidden = false
      placeholderVisible.value = false
    }
    displayReady.value = ready
    syncWaveformSurfaceVisibility(true)
  }

  const resolvePreviewTimeScale = () =>
    Math.max(0.25, Number(options.visualPlaybackRate?.() ?? options.playbackRate()) || 1)

  const resolveWaveformGain = () => {
    const numeric = Number(options.waveformGain?.() ?? 1)
    if (!Number.isFinite(numeric)) return 1
    return clampNumber(numeric, 0, 16)
  }

  const resolveStableWaveformSource = () => options.stableWaveformSource?.() === true
  const resolveStableRenderRevision = () =>
    Math.max(0, Math.floor(Number(options.stableRenderRevision?.()) || 0))

  const resolvePreviewDurationSec = () => {
    const duration = Number(
      options.rawData.value?.duration ||
        options.mixxxData.value?.duration ||
        parseHorizontalBrowseDurationToSeconds(options.song()?.duration) ||
        0
    )
    return Number.isFinite(duration) && duration > 0 ? duration : 0
  }

  const canShowTimelinePlaceholder = () => {
    if (!String(options.song()?.filePath || '').trim()) return false
    return resolvePreviewDurationSec() > 0
  }

  const hasDrawableRawFrames = (rawData: RawWaveformData | null) => {
    if (!rawData) return false
    return Math.max(0, Math.floor(Number(rawData.loadedFrames ?? rawData.frames) || 0)) > 0
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

  const resetLiveWaveformData = () => {
    clearStableFullRenderTimer()
    liveCanvasRenderToken += 1
    liveCanvasBridge.clearRaw()
    suppressNextPlaybackScrollReuse = false
    lastDrawPlaybackActive = false
    lastRenderedRawData = null
    playbackRawSettleUntilMs = 0
    lastQueuedPlaybackRawSlot = null
    lastQueuedMissingPlaybackRawSyncRevision = -1
    stablePresentation.clear()
    clearLiveCanvasPresentationOffset()
    setDisplayReady(false)
  }

  const resetWaveformRenderState = (resetOptions: { preserveDisplay?: boolean } = {}) => {
    clearStableFullRenderTimer()
    const preserveDisplay = resetOptions.preserveDisplay === true && displayReady.value
    if (!preserveDisplay) {
      liveCanvasRenderToken += 1
      setDisplayReady(false)
      liveCanvasBridge.clear()
      lastRenderedRawData = null
      suppressNextPlaybackScrollReuse = true
    }
    playbackRawSettleUntilMs = 0
    lastQueuedPlaybackRawSlot = null
    lastQueuedMissingPlaybackRawSyncRevision = -1
    stablePresentation.clear()
  }

  const clearCanvas = () => {
    clearStableFullRenderTimer()
    placeholderVisible.value = false
    liveCanvasRenderToken += 1
    liveCanvasBridge.clear()
    stablePresentation.clear()
    clearLiveCanvasPresentationOffset()
    setDisplayReady(false)
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
    return 'live'
  }

  const handleLiveCanvasRendered = (payload: LiveCanvasRenderedPayload) => {
    if (payload.renderToken !== liveCanvasRenderToken) return
    displayStartSec.value = payload.rangeStartSec
    stablePresentation.handleRendered(payload)
    if (!payload.ready) {
      setDisplayReady(false)
      return
    }
    setDisplayReady(true)
    if (
      payload.renderViewportOnly === true &&
      resolveStableWaveformSource() &&
      !options.playing.value
    ) {
      scheduleStableFullRender()
    }
  }

  const clearLiveCanvasPresentationOffset = () =>
    applyHorizontalBrowseCanvasPresentationOffset(
      waveformCanvasRef.value,
      overlayCanvasRef.value,
      0,
      true
    )

  const handleLiveCanvasPresentation = (payload: LiveCanvasPresentationPayload) => {
    if (payload.renderToken !== liveCanvasRenderToken) return
    if (stablePresentation.isActive()) return
    applyHorizontalBrowseCanvasPresentationOffset(
      waveformCanvasRef.value,
      overlayCanvasRef.value,
      Number(payload.offsetCssPx) || 0,
      false
    )
  }

  const queueLiveWaveformRender = (payload: {
    rangeStartSec: number
    rangeDurationSec: number
    rawData: RawWaveformData | null
    maxSamplesPerPixel: number
    allowScrollReuse: boolean
    preferRawPeaksOnly: boolean
    completeSeekTransition?: boolean
    preferPreviewStart?: boolean
    viewportOnly?: boolean
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
    const sourcePlaybackActive = options.playing.value && !options.dragging.value
    const stableWaveformSource = resolveStableWaveformSource()
    const stableOverscanCssPx = stableWaveformSource
      ? resolveHorizontalBrowseStableOverscanCssPx(width, pixelRatio)
      : 0
    const viewportOnly = payload.viewportOnly === true
    const renderWidth = width + stableOverscanCssPx * 2
    const renderDurationScale = renderWidth / Math.max(1, width)
    const renderRangeDurationSec = payload.rangeDurationSec * renderDurationScale
    const stableOverscanSec = (payload.rangeDurationSec * stableOverscanCssPx) / Math.max(1, width)
    setHorizontalBrowseLiveCanvasGeometry(
      waveformCanvasRef.value,
      gridCanvasRef.value,
      overlayCanvasRef.value,
      -stableOverscanCssPx,
      renderWidth,
      height,
      height + HORIZONTAL_BROWSE_DETAIL_OVERLAY_EXTEND_PX * 2
    )
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
    const playbackActive = sourcePlaybackActive && !stableWaveformSource
    const playbackSyncChanged =
      playbackActive &&
      !stableWaveformSource &&
      playbackSyncRevision !== lastQueuedPlaybackSyncRevision
    const renderPlaybackSyncRevision = stableWaveformSource
      ? resolveStableRenderRevision()
      : playbackSyncRevision
    const playbackRawRecovering = playbackActive && !!rawSlot && !displayReady.value
    const allowScrollReuse =
      payload.allowScrollReuse && !stableWaveformSource && !playbackSyncChanged
    const renderBpm = Number(options.previewBpm.value) || 0
    const renderFirstBeatMs = Number(options.previewFirstBeatMs.value) || 0
    const renderBarBeatOffset = Number(options.previewBarBeatOffset.value) || 0
    const renderTimeBasisOffsetMs = Number(options.previewTimeBasisOffsetMs.value) || 0
    const playbackRate = Math.max(0.25, Number(options.playbackRate()) || 1)
    const sourcePlaybackSeconds = Number(options.currentSeconds()) || 0
    const anchorStartedAtMs = performance.now()
    const stableAnchorSec = Math.max(
      0,
      payload.rangeStartSec + payload.rangeDurationSec * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
    )
    const visualGridPhase = resolveHorizontalBrowseLinkedGridVisualPhase({
      direction: options.direction(),
      active: waveformLayout !== 'full',
      clockActive: sourcePlaybackActive,
      bpm: renderBpm,
      firstBeatMs: renderFirstBeatMs,
      barBeatOffset: renderBarBeatOffset,
      currentSec: sourcePlaybackSeconds,
      playbackRate
    })
    const playbackSeconds = visualGridPhase.playbackSeconds
    const preferPreviewStart = payload.preferPreviewStart === true
    const suppressStablePlaybackRender =
      stableWaveformSource &&
      sourcePlaybackActive &&
      !preferPreviewStart &&
      !viewportOnly &&
      nowMs < stableViewportRenderPendingUntilMs
    const viewportRangeStartSec =
      preferPreviewStart || (!sourcePlaybackActive && !visualGridPhase.linked)
        ? payload.rangeStartSec
        : resolvePlaybackAlignedStart(playbackSeconds)
    const renderRangeStartSec = stableWaveformSource
      ? viewportRangeStartSec - stableOverscanSec
      : viewportRangeStartSec
    if (suppressStablePlaybackRender) {
      return false
    }
    if (stableWaveformSource) {
      liveCanvasBridge.stopPlayback()
    } else if (playbackSyncChanged) {
      playbackRawSettleUntilMs = nowMs + PLAYBACK_RAW_SETTLE_HOLD_MS
      lastQueuedPlaybackRawSlot = null
      liveCanvasBridge.stopPlayback()
    }
    if (!playbackActive) {
      playbackRawSettleUntilMs = 0
      lastQueuedPlaybackRawSlot = null
      lastQueuedMissingPlaybackRawSyncRevision = -1
      if (!stableWaveformSource) liveCanvasBridge.stopPlayback()
      if (!stableWaveformSource) clearLiveCanvasPresentationOffset()
    }
    lastQueuedPlaybackSyncRevision = playbackSyncRevision
    if (playbackActive && !rawSlot && !displayReady.value) {
      if (lastQueuedMissingPlaybackRawSyncRevision === playbackSyncRevision) {
        return false
      }
      lastQueuedMissingPlaybackRawSyncRevision = playbackSyncRevision
    } else if (rawSlot) {
      lastQueuedMissingPlaybackRawSyncRevision = -1
    }
    if (
      playbackActive &&
      rawSlot &&
      lastQueuedPlaybackRawSlot === rawSlot &&
      displayReady.value &&
      nowMs < playbackRawSettleUntilMs
    ) {
      return false
    }
    const renderToken = liveCanvasRenderToken + 1
    liveCanvasRenderToken = renderToken
    stablePresentation.queueRenderFrame(
      stableWaveformSource,
      renderToken,
      renderRangeStartSec,
      renderRangeDurationSec,
      viewportRangeStartSec,
      preferPreviewStart ? stableAnchorSec : playbackSeconds,
      anchorStartedAtMs,
      playbackRate,
      renderWidth,
      stableOverscanCssPx,
      pixelRatio
    )
    if (stableWaveformSource && viewportOnly) {
      stableViewportRenderPendingUntilMs = performance.now() + STABLE_VIEWPORT_RENDER_HOLD_MS
    }
    liveCanvasBridge.render({
      renderToken,
      renderPriority: stableWaveformSource ? 'immediate' : 'normal',
      renderViewportOnly: viewportOnly,
      width: renderWidth,
      height,
      pixelRatio,
      bpm: renderBpm,
      firstBeatMs: renderFirstBeatMs,
      barBeatOffset: visualGridPhase.barBeatOffset,
      timeBasisOffsetMs: renderTimeBasisOffsetMs,
      rangeStartSec: renderRangeStartSec,
      rangeDurationSec: renderRangeDurationSec,
      viewportWidth: width,
      viewportRangeStartSec,
      viewportRangeDurationSec: payload.rangeDurationSec,
      maxSamplesPerPixel: payload.maxSamplesPerPixel,
      showDetailHighlights: false,
      showCenterLine: false,
      showBackground: false,
      showBeatGrid: Number(options.previewBpm.value) > 0,
      allowScrollReuse,
      phaseAwareScrollReuse: allowScrollReuse && options.phaseAwareScrollReuse?.() === true,
      presentationOffsetMode: stableWaveformSource ? 'device-pixel' : 'free',
      stableWaveformSource,
      waveformLayout,
      waveformRenderStyle,
      preferRawPeaksOnly,
      showTimelinePlaceholder:
        canShowTimelinePlaceholder() && !hasDrawableRawFrames(payload.rawData),
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
      playbackSeconds,
      playbackSyncRevision: renderPlaybackSyncRevision,
      playbackRate,
      playbackRenderClockEpochMs: playbackActive
        ? visualGridPhase.playbackRenderClockEpochMs
        : null,
      playbackDurationSec: resolvePlaybackDurationSecForRender(payload.rawData),
      waveformGain: resolveWaveformGain()
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

  const drawWaveform = (
    drawOptions: { preferPreviewStart?: boolean; viewportOnly?: boolean } = {}
  ) => {
    const wrap = wrapRef.value
    const waveformCanvas = waveformCanvasRef.value
    if (!wrap || !waveformCanvas) return

    const duration = resolvePreviewDurationSec()
    if (!duration) {
      placeholderVisible.value = false
      clearCanvas()
      setDisplayReady(false)
      return
    }

    const visibleDuration = Math.max(0.001, resolveVisibleDurationSec() || duration || 0.001)
    options.previewStartSec.value = clampPreviewStart(options.previewStartSec.value)
    const renderStartSec =
      drawOptions.preferPreviewStart === true
        ? resolveSnappedRenderStartSec(visibleDuration)
        : resolvePlaybackDrivenRenderStartSec(visibleDuration)
    const wasDisplayReady = displayReady.value
    const stableWaveformSource = resolveStableWaveformSource()
    const playbackViewportMoving = options.playing.value && !options.dragging.value
    const playbackStartedThisDraw = playbackViewportMoving && !lastDrawPlaybackActive
    lastDrawPlaybackActive = playbackViewportMoving
    const canReusePlaybackScroll =
      playbackViewportMoving &&
      wasDisplayReady &&
      !suppressNextPlaybackScrollReuse &&
      !playbackStartedThisDraw
    const maxSamplesPerPixel = PREVIEW_MAX_SAMPLES_PER_PIXEL
    const activeMixxxSelection = resolveActiveMixxxSelection()
    const preferPreviewStart = drawOptions.preferPreviewStart === true
    const viewportOnly = drawOptions.viewportOnly === true
    const liveRawData = options.rawData.value

    let effectiveRawData: RawWaveformData | null
    let effectiveMixxxSelection: {
      data: MixxxWaveformData | null
      source: 'live' | 'placeholder' | 'none'
    }
    if (liveRawData) {
      effectiveRawData = liveRawData
      effectiveMixxxSelection = activeMixxxSelection.data
        ? activeMixxxSelection
        : { data: null, source: 'none' }
    } else {
      effectiveRawData = null
      effectiveMixxxSelection = activeMixxxSelection.data
        ? activeMixxxSelection
        : { data: null, source: 'none' }
    }

    const effectiveMixxxData = effectiveMixxxSelection.data
    const effectiveMixxxDrawable =
      !!effectiveMixxxData && effectiveMixxxSelection.source !== 'placeholder'
    const effectiveRawCoverage = isRawDataCoveringRange(
      effectiveRawData,
      renderStartSec,
      visibleDuration
    )
    const allowPlaybackScrollReuse = canReusePlaybackScroll && !stableWaveformSource
    const effectiveRawIntersection = isRawDataIntersectingRange(
      effectiveRawData,
      renderStartSec,
      visibleDuration
    )
    const drawableRawData = effectiveRawIntersection ? effectiveRawData : null
    const canRenderWithoutRawCoverage = effectiveMixxxSelection.source === 'live'
    const shouldHoldPlaybackFrame =
      playbackViewportMoving && !stableWaveformSource && wasDisplayReady

    const hasTimelinePlaceholderTarget =
      canShowTimelinePlaceholder() && !hasDrawableRawFrames(drawableRawData)

    if (!effectiveMixxxDrawable && !drawableRawData) {
      if (shouldHoldPlaybackFrame) {
        return
      }
      lastRenderedRawData = null
      placeholderVisible.value = hasTimelinePlaceholderTarget
      // 完全无高清波形可画：只清波形层；时间线 overlay 仍按当前 range 渲染。
      setDisplayReady(false)
      queueLiveWaveformRender({
        rangeStartSec: renderStartSec,
        rangeDurationSec: visibleDuration,
        rawData: null,
        maxSamplesPerPixel,
        allowScrollReuse: false,
        preferRawPeaksOnly: false,
        preferPreviewStart,
        viewportOnly
      })
    } else if (options.playing.value || options.dragging.value) {
      // 稳定 ref 才允许滚动复用；播放恢复期不能提交 partial raw，避免隐藏 full render 挤占 worker。
      const rawDataRefStable = drawableRawData != null && drawableRawData === lastRenderedRawData
      const allowPartialViewportPaint =
        Boolean(drawableRawData) &&
        !playbackViewportMoving &&
        (options.dragging.value || !options.playing.value || !wasDisplayReady)
      const canDrawWaveform =
        Boolean(drawableRawData) &&
        (effectiveRawCoverage ||
          (allowPlaybackScrollReuse && rawDataRefStable) ||
          allowPartialViewportPaint)
      if (!canDrawWaveform) {
        if (shouldHoldPlaybackFrame) {
          return
        }
        lastRenderedRawData = null
        placeholderVisible.value = hasTimelinePlaceholderTarget
        setDisplayReady(false)
        queueLiveWaveformRender({
          rangeStartSec: renderStartSec,
          rangeDurationSec: visibleDuration,
          rawData: null,
          maxSamplesPerPixel,
          allowScrollReuse: false,
          preferRawPeaksOnly: false,
          preferPreviewStart,
          viewportOnly
        })
      } else {
        const finishTiming = startHorizontalBrowseUserTiming(
          `frkb:hb:canvas:worker-live:${options.direction()}`
        )
        const queued = queueLiveWaveformRender({
          rangeStartSec: renderStartSec,
          rangeDurationSec: visibleDuration,
          rawData: drawableRawData,
          maxSamplesPerPixel,
          allowScrollReuse: allowPlaybackScrollReuse,
          preferRawPeaksOnly: false,
          completeSeekTransition: effectiveRawCoverage,
          preferPreviewStart,
          viewportOnly
        })
        if (queued) {
          lastRenderedRawData = drawableRawData
        }
        suppressNextPlaybackScrollReuse = false
        finishTiming()
      }
    } else if (!drawableRawData && !canRenderWithoutRawCoverage) {
      lastRenderedRawData = null
      placeholderVisible.value = canShowTimelinePlaceholder()
      setDisplayReady(false)
      queueLiveWaveformRender({
        rangeStartSec: renderStartSec,
        rangeDurationSec: visibleDuration,
        rawData: null,
        maxSamplesPerPixel,
        allowScrollReuse: false,
        preferRawPeaksOnly: false,
        preferPreviewStart,
        viewportOnly
      })
    } else {
      placeholderVisible.value = false
      const finishTiming = startHorizontalBrowseUserTiming(
        `frkb:hb:canvas:worker-live:${options.direction()}`
      )
      const queued = queueLiveWaveformRender({
        rangeStartSec: renderStartSec,
        rangeDurationSec: visibleDuration,
        rawData: drawableRawData,
        maxSamplesPerPixel,
        allowScrollReuse: allowPlaybackScrollReuse,
        preferRawPeaksOnly: false,
        completeSeekTransition: effectiveRawCoverage,
        preferPreviewStart,
        viewportOnly
      })
      if (queued) {
        lastRenderedRawData = drawableRawData
      }
      suppressNextPlaybackScrollReuse = false
      finishTiming()
    }
  }

  const scheduleDraw = () => {
    if (drawRaf) return
    drawRaf = requestAnimationFrame(() => {
      drawRaf = 0
      drawWaveform()
    })
  }

  const clearStableFullRenderTimer = () => {
    if (!stableFullRenderTimer) return
    clearTimeout(stableFullRenderTimer)
    stableFullRenderTimer = null
  }

  const scheduleStableFullRender = () => {
    clearStableFullRenderTimer()
    stableFullRenderTimer = setTimeout(() => {
      stableFullRenderTimer = null
      drawWaveform({ preferPreviewStart: true })
    }, STABLE_FULL_RENDER_DELAY_MS)
  }

  const drawWaveformNow = (
    drawOptions: { preferPreviewStart?: boolean; viewportOnly?: boolean } = {}
  ) => {
    if (drawRaf) {
      cancelAnimationFrame(drawRaf)
      drawRaf = 0
    }
    drawWaveform(drawOptions)
  }

  const hideStableCanvasPresentation = () => {
    clearStableFullRenderTimer()
    stableSurfaceForceHidden = true
    setWaveformSurfaceVisible(false, false)
    stablePresentation.clear()
    stablePresentationRevealAfterMs = performance.now() + STABLE_SEEK_REVEAL_HOLD_MS
    setDisplayReady(false)
    clearLiveCanvasPresentationOffset()
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

  const replaceLiveWaveformRaw = (data: RawWaveformData | null) => {
    liveCanvasBridge.replaceRaw(data)
  }

  const stopLiveWaveformPlayback = (preservePresentation = false) => {
    liveCanvasBridge.stopPlayback()
    if (!preservePresentation) clearLiveCanvasPresentationOffset()
  }

  const dispose = () => {
    clearStableFullRenderTimer()
    clearDisplayReadyRevealTimer()
    resetLiveWaveformData()
    liveCanvasAttached = false
    if (drawRaf) {
      cancelAnimationFrame(drawRaf)
      drawRaf = 0
    }
    liveCanvasBridge.dispose()
  }

  return {
    wrapRef,
    waveformSurfaceRef,
    waveformCanvasRef,
    gridCanvasRef,
    overlaySurfaceRef,
    overlayCanvasRef,
    resolvePreviewTimeScale,
    resolvePreviewDurationSec,
    resolveVisibleDurationSec,
    resolvePreviewAnchorSec,
    clampPreviewStart,
    resolveSnappedRenderStartSec,
    resolvePlaybackAlignedStart,
    resetWaveformRenderState,
    clearCanvas,
    invalidateWaveformTiles,
    mountWaveformCanvasWorker,
    scheduleDraw,
    drawWaveformNow,
    scheduleGridOverlayDraw,
    resetGridRenderer,
    resetLiveWaveformData,
    stopLiveWaveformPlayback,
    measureStableCanvasPresentation: stablePresentation.measure,
    applyStableCanvasPresentation: stablePresentation.apply,
    startStableCanvasPlayback: stablePresentation.startPlayback,
    stopStableCanvasPlayback: stablePresentation.stopPlayback,
    reanchorStableCanvasPlayback: stablePresentation.reanchorPlayback,
    hideStableCanvasPresentation,
    replaceLiveWaveformRaw,
    displayStartSec,
    displayReady,
    placeholderVisible,
    dispose
  }
}
