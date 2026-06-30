import { ref, watch } from 'vue'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveform.constants'
import { PREVIEW_MAX_SAMPLES_PER_PIXEL } from '@renderer/components/MixtapeBeatAlignDialog.constants'
import { shouldUseAttackSafeRawPeaks } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformCanvasPolicy'
import { startHorizontalBrowseUserTiming } from '@renderer/composables/horizontalBrowse/horizontalBrowseUserTiming'
import { resolveHorizontalBrowseWaveformThemeVariant } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveformDetail.utils'
import { createHorizontalBrowseDetailLiveCanvasBridge } from '@renderer/composables/horizontalBrowse/horizontalBrowseDetailLiveCanvasBridge'
import { HORIZONTAL_BROWSE_DETAIL_OVERLAY_EXTEND_PX } from '@renderer/composables/horizontalBrowse/horizontalBrowseDetailOverlayCanvas'
import {
  resolveHorizontalBrowseStableOverscanCssPx,
  resolvePixelSnappedCssSize
} from '@renderer/composables/horizontalBrowse/horizontalBrowseCanvasGeometry'
import { createHorizontalBrowseStableCanvasPresentationController } from '@renderer/composables/horizontalBrowse/horizontalBrowseStableCanvasPresentation'
import type { UseHorizontalBrowseRawWaveformCanvasOptions } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformCanvasTypes'
import { normalizeSongHotCues } from '@shared/hotCues'
import { normalizeSongMemoryCues } from '@shared/memoryCues'
import { resolveHorizontalBrowseLinkedGridVisualPhase } from '@renderer/composables/horizontalBrowse/horizontalBrowseLinkedGridVisualPhase'
import { createHorizontalBrowseLiveCanvasBuffers } from '@renderer/composables/horizontalBrowse/horizontalBrowseLiveCanvasBuffers'
import {
  hasHorizontalBrowseDrawableRawFrames,
  resolveHorizontalBrowseWorkerLoopRange
} from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformRenderPayload'
import {
  createHorizontalBrowseRawWaveformDrawScheduler,
  type HorizontalBrowseRawWaveformDrawOptions,
  type HorizontalBrowseRawWaveformDrawScheduler
} from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformDrawScheduler'
import { createHorizontalBrowseRawWaveformDragReleaseState } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformDragReleaseState'
import { resolveHorizontalBrowseCueAccentColor } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformCanvasData'
import {
  canReplacePendingHorizontalBrowseStableRevisionRender,
  clearHorizontalBrowseRawWaveformGridCanvas,
  isHorizontalBrowseRawDataCoveringRenderRange,
  isHorizontalBrowseRawDataIntersectingRenderRange,
  resolveHorizontalBrowseActiveMixxxSelectionForCanvas,
  resolveHorizontalBrowsePlaybackDurationSecForRender,
  resolveHorizontalBrowseRawSlotForRender,
  resolveHorizontalBrowseStableRevisionRenderKind,
  resolveHorizontalBrowseWaveformGain,
  type HorizontalBrowseStableRevisionRenderKind as StableRevisionRenderKind
} from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformCanvasHelpers'
import { createHorizontalBrowseRawWaveformViewport } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformViewport'
import type { HorizontalBrowseDetailLiveCanvasWorkerOutgoing } from '@renderer/workers/horizontalBrowseDetailLiveCanvas.types'
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
const STABLE_SEEK_REVEAL_HOLD_MS = 0
const WAVEFORM_SURFACE_FADE_IN_MS = 50

export const useHorizontalBrowseRawWaveformCanvas = (
  options: UseHorizontalBrowseRawWaveformCanvasOptions
) => {
  const wrapRef = ref<HTMLDivElement | null>(null)
  const liveCanvasBuffers = createHorizontalBrowseLiveCanvasBuffers()
  const { waveformSurfaceRef, waveformCanvasRef, waveformCanvasBackRef, gridCanvasRef } =
    liveCanvasBuffers
  const { overlaySurfaceRef, overlayCanvasRef, overlayCanvasBackRef } = liveCanvasBuffers
  let drawScheduler: HorizontalBrowseRawWaveformDrawScheduler | null = null
  let liveCanvasRenderToken = 0
  let liveCanvasAttached = false
  let suppressNextPlaybackScrollReuse = false
  let lastRenderedRawData: RawWaveformData | null = null
  let lastDrawPlaybackActive = false
  const scheduleDraw = (drawOptions: HorizontalBrowseRawWaveformDrawOptions = {}) =>
    drawScheduler?.scheduleDraw(drawOptions)
  const drawWaveformNow = (drawOptions: HorizontalBrowseRawWaveformDrawOptions = {}) =>
    drawScheduler?.drawNow(drawOptions)
  const clearStablePlaybackRenderRetryTimer = () =>
    drawScheduler?.clearStablePlaybackRenderRetryTimer()
  const scheduleStablePlaybackRenderRetry = (retryAfterMs: number) =>
    drawScheduler?.scheduleStablePlaybackRenderRetry(retryAfterMs)
  // worker overlay 独立渲染，即使 displayReady=false，也会跟随当前 range 立即更新。
  const displayStartSec = ref(0)
  const displayReady = ref(false)
  const placeholderVisible = ref(false)
  let lastQueuedPlaybackSyncRevision = -1
  let playbackRawSettleUntilMs = 0
  let lastQueuedPlaybackRawSlot: 'live' | null = null
  let lastQueuedMissingPlaybackRawSyncRevision = -1
  let lastQueuedStableRenderRevision = -1
  let stableFullRenderTimer: ReturnType<typeof setTimeout> | null = null
  let stableViewportRenderPendingUntilMs = 0
  let displayReadyRevealTimer: ReturnType<typeof setTimeout> | null = null
  let displayReadyRevealGeneration = 0
  let stablePresentationRevealAfterMs = 0
  let stableSurfaceForceHidden = false
  let surfaceVisible: boolean | null = null
  let stableRevisionHandoffSurfaceActive = false
  let pendingStableRevisionRender: {
    revision: number
    token: number
    kind: StableRevisionRenderKind
  } | null = null
  let dragPresentationActive = false
  let dragPresentationBaseOffsetCssPx = 0
  let preserveSurfaceUntilNextReady = false
  let suppressNextSurfaceFadeIn = false
  let lastRenderedRangeStartSec: number | null = null
  let lastRenderedRangeDurationSec: number | null = null

  const stablePresentation = createHorizontalBrowseStableCanvasPresentationController({
    isActive: () => resolveStableWaveformSource(),
    isPlaying: () => options.playing.value,
    isDragging: () => options.dragging.value,
    currentSeconds: () => Number(options.currentSeconds()) || 0,
    playbackRate: () => Number(options.playbackRate()) || 1,
    renderRevision: () => resolveStableRenderRevision(),
    resolveViewportRangeStartSec: (seconds) => resolvePlaybackAlignedStart(seconds),
    waveformCanvas: () => liveCanvasBuffers.presentationWaveformCanvas(),
    overlayCanvas: () => liveCanvasBuffers.presentationOverlayCanvas(),
    scheduleDraw: () => drawWaveformNow()
  })

  const liveCanvasBridge = createHorizontalBrowseDetailLiveCanvasBridge({
    onRendered: (payload) => handleLiveCanvasRendered(payload),
    onPresentation: (payload) => handleLiveCanvasPresentation(payload)
  })
  const {
    resolvePreviewTimeScale,
    resolvePreviewDurationSec,
    canShowTimelinePlaceholder,
    resolveVisibleDurationSec,
    resolvePreviewAnchorSec,
    clampPreviewStart,
    resolveSnappedRenderStartSec,
    resolvePlaybackDrivenRenderStartSec,
    resolveWaveformLayout,
    resolvePlaybackAlignedStart
  } = createHorizontalBrowseRawWaveformViewport(options)
  const dragReleaseState = createHorizontalBrowseRawWaveformDragReleaseState({
    playing: options.playing,
    dragging: options.dragging,
    currentSeconds: options.currentSeconds,
    resolvePlaybackAlignedStart,
    resolveVisibleDurationSec,
    resolveStableWaveformSource: () => resolveStableWaveformSource(),
    drawWaveformNow
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
      element.style.transition =
        visible && fadeIn ? `opacity ${WAVEFORM_SURFACE_FADE_IN_MS}ms linear` : 'none'
      element.style.opacity = visible ? '1' : '0'
    })
  }

  const hasReusablePreservedSurface = () => preserveSurfaceUntilNextReady

  const resolveDisplayReadyForReuse = () => displayReady.value || hasReusablePreservedSurface()

  const syncWaveformSurfaceVisibility = (fadeIn: boolean) => {
    setWaveformSurfaceVisible(
      placeholderVisible.value ||
        (!stableSurfaceForceHidden && (displayReady.value || preserveSurfaceUntilNextReady)),
      fadeIn
    )
  }

  const clearStableRevisionReplacementState = () => {
    stableRevisionHandoffSurfaceActive = false
    pendingStableRevisionRender = null
  }

  watch(
    [waveformSurfaceRef, overlaySurfaceRef],
    () => {
      surfaceVisible = null
      liveCanvasBuffers.syncVisibility()
      syncWaveformSurfaceVisibility(false)
    },
    { flush: 'post' }
  )

  const setDisplayReady = (ready: boolean) => {
    if (!ready) {
      clearDisplayReadyRevealTimer()
      displayReadyRevealGeneration += 1
      displayReady.value = false
      if (preserveSurfaceUntilNextReady) return
      clearStableRevisionReplacementState()
      syncWaveformSurfaceVisibility(false)
      return
    }
    const nowMs = performance.now()
    const fadeIn = !suppressNextSurfaceFadeIn
    if (fadeIn && nowMs < stablePresentationRevealAfterMs) {
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
          clearStableRevisionReplacementState()
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
    if (ready) {
      clearStableRevisionReplacementState()
    }
    preserveSurfaceUntilNextReady = false
    suppressNextSurfaceFadeIn = false
    syncWaveformSurfaceVisibility(fadeIn)
  }

  const resolveStableWaveformSource = () => options.stableWaveformSource?.() === true
  const resolveStableRenderRevision = () =>
    Math.max(0, Math.floor(Number(options.stableRenderRevision?.()) || 0))

  const resetLiveWaveformData = () => {
    clearStableFullRenderTimer()
    clearStablePlaybackRenderRetryTimer()
    dragPresentationActive = false
    dragReleaseState.reset()
    preserveSurfaceUntilNextReady = false
    suppressNextSurfaceFadeIn = false
    clearStableRevisionReplacementState()
    liveCanvasRenderToken += 1
    liveCanvasBridge.clearRaw()
    suppressNextPlaybackScrollReuse = false
    lastDrawPlaybackActive = false
    lastRenderedRawData = null
    playbackRawSettleUntilMs = 0
    lastQueuedPlaybackRawSlot = null
    lastQueuedMissingPlaybackRawSyncRevision = -1
    lastQueuedStableRenderRevision = -1
    lastRenderedRangeStartSec = null
    lastRenderedRangeDurationSec = null
    stablePresentation.clear()
    clearLiveCanvasPresentationOffset()
    setDisplayReady(false)
  }

  const resetWaveformRenderState = (resetOptions: { preserveDisplay?: boolean } = {}) => {
    clearStableFullRenderTimer()
    clearStablePlaybackRenderRetryTimer()
    const preserveDisplay = resetOptions.preserveDisplay === true && displayReady.value
    if (!preserveDisplay) {
      liveCanvasRenderToken += 1
      clearStableRevisionReplacementState()
      setDisplayReady(false)
      liveCanvasBridge.clear()
      lastRenderedRawData = null
      suppressNextPlaybackScrollReuse = true
    }
    playbackRawSettleUntilMs = 0
    lastQueuedPlaybackRawSlot = null
    lastQueuedMissingPlaybackRawSyncRevision = -1
    lastQueuedStableRenderRevision = -1
    lastRenderedRangeStartSec = null
    lastRenderedRangeDurationSec = null
    clearStableRevisionReplacementState()
    stablePresentation.clear()
  }

  const clearCanvas = () => {
    clearStableFullRenderTimer()
    clearStablePlaybackRenderRetryTimer()
    dragPresentationActive = false
    dragReleaseState.reset()
    preserveSurfaceUntilNextReady = false
    suppressNextSurfaceFadeIn = false
    clearStableRevisionReplacementState()
    placeholderVisible.value = false
    liveCanvasRenderToken += 1
    liveCanvasBridge.clear()
    lastRenderedRangeStartSec = null
    lastRenderedRangeDurationSec = null
    lastQueuedStableRenderRevision = -1
    stablePresentation.clear()
    clearLiveCanvasPresentationOffset()
    setDisplayReady(false)
    clearHorizontalBrowseRawWaveformGridCanvas(gridCanvasRef.value)
  }

  const clearGridCanvas = () => {
    clearHorizontalBrowseRawWaveformGridCanvas(gridCanvasRef.value)
  }

  const ensureLiveCanvasMounted = () => {
    if (liveCanvasAttached) return true
    liveCanvasAttached = liveCanvasBridge.mount(
      liveCanvasBuffers.waveformCanvases(),
      liveCanvasBuffers.overlayCanvases()
    )
    return liveCanvasAttached
  }

  const handleLiveCanvasRendered = (payload: LiveCanvasRenderedPayload) => {
    if (dragPresentationActive) return
    if (payload.renderToken !== liveCanvasRenderToken) return
    const pendingStableRender = pendingStableRevisionRender
    if (pendingStableRender?.token === payload.renderToken) {
      pendingStableRevisionRender = null
    }
    const placeholderPresentationReady = !payload.ready && placeholderVisible.value
    const preservePreviousSurfaceOnNotReady =
      !payload.ready &&
      !placeholderPresentationReady &&
      (preserveSurfaceUntilNextReady ||
        (payload.stableWaveformSource === true && displayReady.value))
    if (payload.ready) {
      lastRenderedRangeStartSec = payload.rangeStartSec
      lastRenderedRangeDurationSec = payload.rangeDurationSec
    } else if (!preservePreviousSurfaceOnNotReady) {
      lastRenderedRangeStartSec = null
      lastRenderedRangeDurationSec = null
    }
    let forceStableViewportStart = false
    if (dragReleaseState.pending && payload.ready) {
      const canCompleteRelease = dragReleaseState.canComplete(payload)
      const releaseExpired = dragReleaseState.isExpired()
      const playingReadyRelease = options.playing.value && !options.dragging.value
      const canForceStableRelease =
        releaseExpired &&
        payload.stableWaveformSource === true &&
        dragReleaseState.viewportStartSec !== null
      if (!canCompleteRelease && !releaseExpired && !playingReadyRelease) {
        drawWaveformNow({ preferPreviewStart: true })
        return
      }
      const forcedStableRelease =
        canForceStableRelease && !canCompleteRelease && !playingReadyRelease
      forceStableViewportStart = true
      clearLiveCanvasPresentationOffset()
      dragReleaseState.finish({ requiresFreshFrame: forcedStableRelease })
    }
    displayStartSec.value = payload.rangeStartSec
    const renderTargetIndex = Number.isInteger(payload.renderTargetIndex)
      ? Number(payload.renderTargetIndex)
      : null
    const stableViewportOnlyRender =
      payload.ready && payload.stableWaveformSource === true && payload.renderViewportOnly === true
    const presentationPayload = placeholderPresentationReady
      ? {
          ...payload,
          ready: true
        }
      : payload
    if (!payload.ready) {
      if (preservePreviousSurfaceOnNotReady) return
      if (placeholderPresentationReady) {
        if (payload.stableWaveformSource === true && renderTargetIndex !== null) {
          liveCanvasBuffers.withPresentationTarget(renderTargetIndex, () =>
            stablePresentation.handleRendered(presentationPayload, {
              forceViewportRangeStart: forceStableViewportStart
            })
          )
          liveCanvasBuffers.activate(renderTargetIndex)
        } else {
          stablePresentation.handleRendered(presentationPayload, {
            forceViewportRangeStart: forceStableViewportStart
          })
        }
      }
      setDisplayReady(false)
      return
    }
    if (payload.stableWaveformSource === true && renderTargetIndex !== null) {
      liveCanvasBuffers.withPresentationTarget(renderTargetIndex, () =>
        stablePresentation.handleRendered(presentationPayload, {
          forceViewportRangeStart: forceStableViewportStart
        })
      )
      if (!stableViewportOnlyRender) {
        liveCanvasBuffers.activate(renderTargetIndex)
      }
    } else {
      stablePresentation.handleRendered(presentationPayload, {
        forceViewportRangeStart: forceStableViewportStart
      })
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

  const clearLiveCanvasPresentationOffset = () => liveCanvasBuffers.applyPresentationOffset(0, true)

  const handleLiveCanvasPresentation = (payload: LiveCanvasPresentationPayload) => {
    if (dragPresentationActive || dragReleaseState.pending) return
    if (payload.renderToken !== liveCanvasRenderToken) return
    if (stablePresentation.isActive()) return
    liveCanvasBuffers.applyPresentationOffset(Number(payload.offsetCssPx) || 0, true)
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
    const viewportOnly = payload.viewportOnly === true && !stableWaveformSource
    const renderWidth = width + stableOverscanCssPx * 2
    const renderDurationScale = renderWidth / Math.max(1, width)
    const renderRangeDurationSec = payload.rangeDurationSec * renderDurationScale
    const stableOverscanSec = (payload.rangeDurationSec * stableOverscanCssPx) / Math.max(1, width)
    const playheadCanvasX =
      stableOverscanCssPx + wrapWidth * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
    liveCanvasBuffers.setGeometry(
      -stableOverscanCssPx,
      renderWidth,
      height,
      height + HORIZONTAL_BROWSE_DETAIL_OVERLAY_EXTEND_PX * 2
    )
    const rawSlot = resolveHorizontalBrowseRawSlotForRender(payload.rawData)
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
    const allowScrollReuse = payload.allowScrollReuse && !playbackSyncChanged
    const renderBpm = Number(options.previewBpm.value) || 0
    const showBeatGrid = renderBpm > 0
    const renderFirstBeatMs = Number(options.previewFirstBeatMs.value) || 0
    const renderBarBeatOffset = Number(options.previewBarBeatOffset.value) || 0
    const renderTimeBasisOffsetMs = Number(options.previewTimeBasisOffsetMs.value) || 0
    const playbackRate = Math.max(0.25, Number(options.playbackRate()) || 1)
    const sourcePlaybackSeconds = Number(options.currentSeconds()) || 0
    const anchorStartedAtMs = performance.now()
    const linkedGridPhaseLocked = dragReleaseState.pending || dragReleaseState.active.value
    const visualGridPhase = resolveHorizontalBrowseLinkedGridVisualPhase({
      direction: options.direction(),
      active: waveformLayout !== 'full' && options.linkedGridActive?.() === true,
      clockActive: sourcePlaybackActive,
      bpm: renderBpm,
      firstBeatMs: renderFirstBeatMs,
      barBeatOffset: renderBarBeatOffset,
      currentSec: sourcePlaybackSeconds,
      playbackRate,
      phaseLocked: linkedGridPhaseLocked
    })
    const playbackSeconds = visualGridPhase.playbackSeconds
    const preferPreviewStart = payload.preferPreviewStart === true
    const suppressStablePlaybackRender =
      stableWaveformSource &&
      sourcePlaybackActive &&
      !preferPreviewStart &&
      !viewportOnly &&
      nowMs < stableViewportRenderPendingUntilMs
    const stableRevisionRenderKind = resolveHorizontalBrowseStableRevisionRenderKind(
      preferPreviewStart,
      viewportOnly
    )
    const stableRevisionChanged =
      stableWaveformSource && renderPlaybackSyncRevision !== lastQueuedStableRenderRevision
    const baseViewportRangeStartSec =
      preferPreviewStart || (!sourcePlaybackActive && !visualGridPhase.linked)
        ? payload.rangeStartSec
        : resolvePlaybackAlignedStart(playbackSeconds)
    const renderAnchorSec =
      preferPreviewStart || (!sourcePlaybackActive && !visualGridPhase.linked)
        ? Math.max(
            0,
            baseViewportRangeStartSec +
              payload.rangeDurationSec * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
          )
        : playbackSeconds
    const renderRangeStartSec =
      renderAnchorSec -
      (playheadCanvasX / Math.max(1, renderWidth)) * Math.max(0.0001, renderRangeDurationSec)
    const viewportRangeStartSec = stableWaveformSource
      ? renderRangeStartSec + stableOverscanSec
      : renderRangeStartSec
    const duplicateStableRevisionRenderPending =
      stableWaveformSource &&
      !stableRevisionChanged &&
      !!pendingStableRevisionRender &&
      pendingStableRevisionRender.revision === renderPlaybackSyncRevision &&
      !displayReady.value &&
      preserveSurfaceUntilNextReady
    if (
      duplicateStableRevisionRenderPending &&
      pendingStableRevisionRender &&
      !canReplacePendingHorizontalBrowseStableRevisionRender(
        pendingStableRevisionRender.kind,
        stableRevisionRenderKind
      )
    ) {
      return false
    }
    if (suppressStablePlaybackRender) {
      scheduleStablePlaybackRenderRetry(stableViewportRenderPendingUntilMs)
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
    const previousDisplayReady = resolveDisplayReadyForReuse()
    if (!stableWaveformSource) {
      lastQueuedStableRenderRevision = -1
      clearStableRevisionReplacementState()
    } else if (stableRevisionChanged) {
      liveCanvasBridge.stopPlayback()
    }
    const renderToken = liveCanvasRenderToken + 1
    liveCanvasRenderToken = renderToken
    if (stableWaveformSource) {
      lastQueuedStableRenderRevision = renderPlaybackSyncRevision
    }
    stablePresentation.queueRenderFrame(
      stableWaveformSource,
      renderToken,
      renderPlaybackSyncRevision,
      sourcePlaybackActive,
      renderRangeStartSec,
      renderRangeDurationSec,
      viewportRangeStartSec,
      renderAnchorSec,
      anchorStartedAtMs,
      playbackRate,
      renderWidth,
      stableOverscanCssPx,
      pixelRatio
    )
    if (stableWaveformSource) {
      pendingStableRevisionRender = {
        revision: renderPlaybackSyncRevision,
        token: renderToken,
        kind: stableRevisionRenderKind
      }
    }
    if (stableRevisionChanged) {
      const handoffMeasurement =
        previousDisplayReady && sourcePlaybackActive
          ? stablePresentation.measure(playbackSeconds, {
              allowRevisionHandoff: true,
              useFrameViewportForRevisionHandoff: true
            })
          : null
      preserveSurfaceUntilNextReady = previousDisplayReady
      suppressNextSurfaceFadeIn = previousDisplayReady
      stableRevisionHandoffSurfaceActive =
        previousDisplayReady && handoffMeasurement?.presentable === true
      setDisplayReady(false)
    }
    if (stableWaveformSource && viewportOnly) {
      stableViewportRenderPendingUntilMs = performance.now() + STABLE_VIEWPORT_RENDER_HOLD_MS
    }
    const renderSourceIndex = liveCanvasBuffers.activeIndex()
    const renderTargetIndex = stableWaveformSource
      ? liveCanvasBuffers.inactiveIndex()
      : renderSourceIndex
    const renderRequest = {
      renderToken,
      renderPriority: stableWaveformSource ? 'immediate' : 'normal',
      renderTargetIndex,
      renderSourceIndex,
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
      showBeatGrid,
      allowScrollReuse,
      phaseAwareScrollReuse: allowScrollReuse && options.phaseAwareScrollReuse?.() === true,
      presentationOffsetMode: stableWaveformSource ? 'device-pixel' : 'free',
      stableWaveformSource,
      waveformLayout,
      waveformRenderStyle,
      preferRawPeaksOnly,
      // 网格和真实波形优先级高于空时间轴占位，避免中间态叠在一起。
      showTimelinePlaceholder:
        canShowTimelinePlaceholder() &&
        !showBeatGrid &&
        !hasHorizontalBrowseDrawableRawFrames(payload.rawData),
      themeVariant: resolveHorizontalBrowseWaveformThemeVariant(),
      rawSlot,
      direction: options.direction(),
      cueSeconds: Number.isFinite(Number(options.cueSeconds()))
        ? Number(options.cueSeconds())
        : null,
      hotCues: normalizeSongHotCues(options.hotCues()),
      memoryCues: normalizeSongMemoryCues(options.memoryCues()),
      loopRange: resolveHorizontalBrowseWorkerLoopRange(options.loopRange()),
      cueAccentColor: resolveHorizontalBrowseCueAccentColor(),
      playbackActive,
      playbackSeconds,
      playbackSyncRevision: renderPlaybackSyncRevision,
      playbackRate,
      playbackRenderClockEpochMs: playbackActive
        ? visualGridPhase.playbackRenderClockEpochMs
        : null,
      playbackDurationSec: resolveHorizontalBrowsePlaybackDurationSecForRender(
        payload.rawData,
        resolvePreviewDurationSec(),
        resolveTimeBasisOffsetSec()
      ),
      waveformGain: resolveHorizontalBrowseWaveformGain(options.waveformGain?.())
    } satisfies Parameters<typeof liveCanvasBridge.render>[0]
    liveCanvasBridge.render(renderRequest)
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

  const invalidateWaveformTiles = (invalidateOptions: { preserveDisplay?: boolean } = {}) => {
    liveCanvasRenderToken += 1
    if (invalidateOptions.preserveDisplay === true && resolveDisplayReadyForReuse()) {
      preserveSurfaceUntilNextReady = true
      suppressNextSurfaceFadeIn = true
      return
    }
    clearStableRevisionReplacementState()
    liveCanvasBridge.clear()
  }

  const drawWaveform = (drawOptions: HorizontalBrowseRawWaveformDrawOptions = {}) => {
    if (dragPresentationActive) {
      return
    }
    const wrap = wrapRef.value
    const waveformCanvas = liveCanvasBuffers.activeWaveformCanvas()
    if (!wrap || !waveformCanvas) {
      return
    }

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
    const wasDisplayReady = resolveDisplayReadyForReuse()
    const stableWaveformSource = resolveStableWaveformSource()
    const playbackViewportMoving = options.playing.value && !options.dragging.value
    const playbackStartedThisDraw = playbackViewportMoving && !lastDrawPlaybackActive
    lastDrawPlaybackActive = playbackViewportMoving
    const canReusePlaybackScroll =
      playbackViewportMoving &&
      wasDisplayReady &&
      !suppressNextPlaybackScrollReuse &&
      (!playbackStartedThisDraw || stableWaveformSource)
    const maxSamplesPerPixel = PREVIEW_MAX_SAMPLES_PER_PIXEL
    const activeMixxxSelection = resolveHorizontalBrowseActiveMixxxSelectionForCanvas(
      options.mixxxData.value
    )
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
    const timeBasisOffsetSec = resolveTimeBasisOffsetSec()
    const effectiveRawCoverage = isHorizontalBrowseRawDataCoveringRenderRange(
      effectiveRawData,
      renderStartSec,
      visibleDuration,
      timeBasisOffsetSec
    )
    const allowPlaybackScrollReuse = canReusePlaybackScroll
    const effectiveRawIntersection = isHorizontalBrowseRawDataIntersectingRenderRange(
      effectiveRawData,
      renderStartSec,
      visibleDuration,
      timeBasisOffsetSec
    )
    const drawableRawData = effectiveRawIntersection ? effectiveRawData : null
    const canRenderWithoutRawCoverage = effectiveMixxxSelection.source === 'live'
    const shouldHoldPlaybackFrame =
      playbackViewportMoving && !stableWaveformSource && wasDisplayReady
    const hasBeatGridTarget = Number(options.previewBpm.value) > 0

    const hasTimelinePlaceholderTarget =
      canShowTimelinePlaceholder() &&
      !hasBeatGridTarget &&
      !hasHorizontalBrowseDrawableRawFrames(drawableRawData)
    const shouldShowEmptySurface = hasTimelinePlaceholderTarget || hasBeatGridTarget

    if (!effectiveMixxxDrawable && !drawableRawData) {
      if (shouldHoldPlaybackFrame) {
        return
      }
      lastRenderedRawData = null
      placeholderVisible.value = shouldShowEmptySurface
      // 完全无高清波形可画：只清波形层；worker 仍按当前 range 渲染网格或时间轴占位。
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
        placeholderVisible.value = shouldShowEmptySurface
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
      placeholderVisible.value = shouldShowEmptySurface
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

  drawScheduler = createHorizontalBrowseRawWaveformDrawScheduler({ draw: drawWaveform })

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

  const resolveWaveformCanvasTranslateX = () => liveCanvasBuffers.resolveActiveTranslateX()

  const resolveRenderedCanvasViewportStartSec = () =>
    liveCanvasBuffers.resolveActiveViewportStartSec(
      lastRenderedRangeStartSec,
      lastRenderedRangeDurationSec
    )

  const beginDragCanvasPresentation = () => {
    const viewportStartSec = resolveRenderedCanvasViewportStartSec()
    dragPresentationActive = true
    dragReleaseState.reset()
    preserveSurfaceUntilNextReady = false
    suppressNextSurfaceFadeIn = false
    clearStableRevisionReplacementState()
    dragPresentationBaseOffsetCssPx = resolveWaveformCanvasTranslateX()
    stablePresentation.stopPlayback()
    liveCanvasBridge.stopPlayback()
    return {
      viewportStartSec
    }
  }

  const applyDragCanvasPresentationOffset = (offsetCssPx: number) => {
    if (!dragPresentationActive) return
    const appliedOffsetCssPx = dragPresentationBaseOffsetCssPx + (Number(offsetCssPx) || 0)
    liveCanvasBuffers.applyPresentationOffset(appliedOffsetCssPx, true)
  }

  const endDragCanvasPresentation = (viewportStartSec?: number) => {
    if (!dragPresentationActive) {
      return {
        requiresRender: false
      }
    }
    const safeViewportStartSec = Number.isFinite(Number(viewportStartSec))
      ? Number(viewportStartSec)
      : null
    dragPresentationActive = false
    dragPresentationBaseOffsetCssPx = 0
    dragReleaseState.resetForDragEnd(safeViewportStartSec)
    if (
      safeViewportStartSec !== null &&
      resolveStableWaveformSource() &&
      stablePresentation.applyViewportRangeStart(safeViewportStartSec)
    ) {
      dragReleaseState.reset()
      preserveSurfaceUntilNextReady = true
      suppressNextSurfaceFadeIn = true
      return {
        requiresRender: true
      }
    }
    dragReleaseState.startPending(safeViewportStartSec)
    preserveSurfaceUntilNextReady = true
    suppressNextSurfaceFadeIn = true
    return {
      requiresRender: true
    }
  }

  const hideStableCanvasPresentation = () => {
    clearStableFullRenderTimer()
    if (resolveDisplayReadyForReuse()) {
      preserveSurfaceUntilNextReady = true
      suppressNextSurfaceFadeIn = true
      stableSurfaceForceHidden = false
      stablePresentation.stopPlayback()
      stablePresentationRevealAfterMs = 0
      syncWaveformSurfaceVisibility(false)
      return
    }
    stableSurfaceForceHidden = true
    setWaveformSurfaceVisible(false, false)
    clearStableRevisionReplacementState()
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
    drawScheduler?.dispose()
    liveCanvasBridge.dispose()
  }

  return {
    wrapRef,
    waveformSurfaceRef,
    waveformCanvasRef,
    waveformCanvasBackRef,
    gridCanvasRef,
    overlaySurfaceRef,
    overlayCanvasRef,
    overlayCanvasBackRef,
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
    beginDragCanvasPresentation,
    applyDragCanvasPresentationOffset,
    endDragCanvasPresentation,
    syncDragPresentationReleaseViewportStart: dragReleaseState.syncViewportStart,
    consumeDragPresentationReleaseRequiresFreshFrame: dragReleaseState.consumeRequiresFreshFrame,
    resolveRenderedCanvasViewportStartSec,
    dragPresentationReleaseActive: dragReleaseState.active,
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
