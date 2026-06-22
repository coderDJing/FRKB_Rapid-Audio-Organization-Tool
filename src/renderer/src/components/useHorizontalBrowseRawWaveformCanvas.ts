import { ref, watch } from 'vue'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO } from '@renderer/components/horizontalBrowseWaveform.constants'
import { PREVIEW_MAX_SAMPLES_PER_PIXEL } from '@renderer/components/MixtapeBeatAlignDialog.constants'
import { clampNumber } from '@renderer/components/horizontalBrowseMath'
import { shouldUseAttackSafeRawPeaks } from '@renderer/components/horizontalBrowseRawWaveformCanvasPolicy'
import { startHorizontalBrowseUserTiming } from '@renderer/components/horizontalBrowseUserTiming'
import { resolveHorizontalBrowseWaveformThemeVariant } from '@renderer/components/horizontalBrowseWaveformDetail.utils'
import { createHorizontalBrowseDetailLiveCanvasBridge } from '@renderer/components/horizontalBrowseDetailLiveCanvasBridge'
import { HORIZONTAL_BROWSE_DETAIL_OVERLAY_EXTEND_PX } from '@renderer/components/horizontalBrowseDetailOverlayCanvas'
import {
  resolveHorizontalBrowseStableOverscanCssPx,
  resolvePixelSnappedCssSize
} from '@renderer/components/horizontalBrowseCanvasGeometry'
import { createHorizontalBrowseStableCanvasPresentationController } from '@renderer/components/horizontalBrowseStableCanvasPresentation'
import {
  isHorizontalBrowseRawDataCoveringRange,
  isHorizontalBrowseRawDataIntersectingRange,
  resolveHorizontalBrowsePlaybackDurationSec
} from '@renderer/components/horizontalBrowseRawWaveformCoverage'
import type { UseHorizontalBrowseRawWaveformCanvasOptions } from '@renderer/components/horizontalBrowseRawWaveformCanvasTypes'
import { normalizeSongHotCues } from '@shared/hotCues'
import { normalizeSongMemoryCues } from '@shared/memoryCues'
import { resolveHorizontalBrowseLinkedGridVisualPhase } from '@renderer/components/horizontalBrowseLinkedGridVisualPhase'
import { createHorizontalBrowseLiveCanvasBuffers } from '@renderer/components/horizontalBrowseLiveCanvasBuffers'
import {
  hasHorizontalBrowseDrawableRawFrames,
  resolveHorizontalBrowseWorkerLoopRange
} from '@renderer/components/horizontalBrowseRawWaveformRenderPayload'
import {
  createHorizontalBrowseRawWaveformDrawScheduler,
  type HorizontalBrowseRawWaveformDrawOptions,
  type HorizontalBrowseRawWaveformDrawScheduler
} from '@renderer/components/horizontalBrowseRawWaveformDrawScheduler'
import {
  canCompleteHorizontalBrowseDragPresentationRelease,
  isHorizontalBrowseDragPresentationReleaseExpired,
  resolveHorizontalBrowseDragReleaseRenderedViewportStartSec
} from '@renderer/components/horizontalBrowseDragPresentationRelease'
import {
  resolveHorizontalBrowseActiveMixxxSelection,
  resolveHorizontalBrowseCueAccentColor
} from '@renderer/components/horizontalBrowseRawWaveformCanvasData'
import { createHorizontalBrowseRawWaveformViewport } from '@renderer/components/horizontalBrowseRawWaveformViewport'
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
  const dragPresentationReleaseActive = ref(false)
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
  let dragPresentationActive = false
  let dragPresentationBaseOffsetCssPx = 0
  let dragPresentationReleasePending = false
  let dragPresentationReleaseViewportStartSec: number | null = null
  let dragPresentationReleaseStartedAtMs = 0
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
    scheduleDraw: () => drawWaveformNow(),
    debugLabel: () => options.direction()
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

  const syncWaveformSurfaceVisibility = (fadeIn: boolean) => {
    setWaveformSurfaceVisible(
      placeholderVisible.value || (!stableSurfaceForceHidden && displayReady.value),
      fadeIn
    )
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
    preserveSurfaceUntilNextReady = false
    suppressNextSurfaceFadeIn = false
    syncWaveformSurfaceVisibility(fadeIn)
  }

  const resolveWaveformGain = () => {
    const numeric = Number(options.waveformGain?.() ?? 1)
    if (!Number.isFinite(numeric)) return 1
    return clampNumber(numeric, 0, 16)
  }

  const resolveStableWaveformSource = () => options.stableWaveformSource?.() === true
  const resolveStableRenderRevision = () =>
    Math.max(0, Math.floor(Number(options.stableRenderRevision?.()) || 0))

  const clearDragPresentationRelease = () => {
    dragPresentationReleasePending = false
    dragPresentationReleaseActive.value = false
    dragPresentationReleaseViewportStartSec = null
    dragPresentationReleaseStartedAtMs = 0
    preserveSurfaceUntilNextReady = false
    suppressNextSurfaceFadeIn = false
  }

  const finishDragPresentationRelease = () => {
    dragPresentationReleasePending = false
    dragPresentationReleaseActive.value = false
    dragPresentationReleaseViewportStartSec = null
    dragPresentationReleaseStartedAtMs = 0
    preserveSurfaceUntilNextReady = false
  }

  const resolveRenderedViewportStartSec = (payload: LiveCanvasRenderedPayload) => {
    return resolveHorizontalBrowseDragReleaseRenderedViewportStartSec({
      stableWaveformSource: resolveStableWaveformSource(),
      rangeStartSec: payload.rangeStartSec,
      rangeDurationSec: payload.rangeDurationSec,
      visibleDurationSec: resolveVisibleDurationSec()
    })
  }

  const canCompleteDragPresentationRelease = (payload: LiveCanvasRenderedPayload) => {
    return canCompleteHorizontalBrowseDragPresentationRelease({
      pending: dragPresentationReleasePending,
      expectedStartSec: dragPresentationReleaseViewportStartSec,
      renderedViewportStartSec: resolveRenderedViewportStartSec(payload)
    })
  }

  const isDragPresentationReleaseExpired = () =>
    isHorizontalBrowseDragPresentationReleaseExpired(dragPresentationReleaseStartedAtMs)

  const resetLiveWaveformData = () => {
    clearStableFullRenderTimer()
    clearStablePlaybackRenderRetryTimer()
    dragPresentationActive = false
    clearDragPresentationRelease()
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
    stablePresentation.clear()
  }

  const clearCanvas = () => {
    clearStableFullRenderTimer()
    clearStablePlaybackRenderRetryTimer()
    dragPresentationActive = false
    clearDragPresentationRelease()
    placeholderVisible.value = false
    liveCanvasRenderToken += 1
    liveCanvasBridge.clear()
    lastRenderedRangeStartSec = null
    lastRenderedRangeDurationSec = null
    lastQueuedStableRenderRevision = -1
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
    liveCanvasAttached = liveCanvasBridge.mount(
      liveCanvasBuffers.waveformCanvases(),
      liveCanvasBuffers.overlayCanvases()
    )
    return liveCanvasAttached
  }

  const resolveRawSlotForRender = (rawData: RawWaveformData | null) => {
    if (!rawData) return null
    return 'live'
  }

  const handleLiveCanvasRendered = (payload: LiveCanvasRenderedPayload) => {
    if (dragPresentationActive) return
    if (payload.renderToken !== liveCanvasRenderToken) return
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
    if (dragPresentationReleasePending && payload.ready) {
      if (!canCompleteDragPresentationRelease(payload) && !isDragPresentationReleaseExpired()) {
        drawWaveformNow({ preferPreviewStart: true, viewportOnly: true })
        return
      }
      forceStableViewportStart = true
      clearLiveCanvasPresentationOffset()
      finishDragPresentationRelease()
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
    if (dragPresentationActive || dragPresentationReleasePending) return
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
    const allowScrollReuse = payload.allowScrollReuse && !playbackSyncChanged
    const renderBpm = Number(options.previewBpm.value) || 0
    const showBeatGrid = renderBpm > 0
    const renderFirstBeatMs = Number(options.previewFirstBeatMs.value) || 0
    const renderBarBeatOffset = Number(options.previewBarBeatOffset.value) || 0
    const renderTimeBasisOffsetMs = Number(options.previewTimeBasisOffsetMs.value) || 0
    const playbackRate = Math.max(0.25, Number(options.playbackRate()) || 1)
    const sourcePlaybackSeconds = Number(options.currentSeconds()) || 0
    const anchorStartedAtMs = performance.now()
    const visualGridPhase = resolveHorizontalBrowseLinkedGridVisualPhase({
      direction: options.direction(),
      active: waveformLayout !== 'full' && options.linkedGridActive?.() === true,
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
    if (!stableWaveformSource) {
      lastQueuedStableRenderRevision = -1
    } else if (renderPlaybackSyncRevision !== lastQueuedStableRenderRevision) {
      stablePresentation.clear()
      liveCanvasBridge.stopPlayback()
      preserveSurfaceUntilNextReady = true
      suppressNextSurfaceFadeIn = true
      setDisplayReady(false)
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
      playbackDurationSec: resolvePlaybackDurationSecForRender(payload.rawData),
      waveformGain: resolveWaveformGain()
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

  const resolveActiveMixxxSelection = () =>
    resolveHorizontalBrowseActiveMixxxSelection(options.mixxxData.value)

  const invalidateWaveformTiles = (invalidateOptions: { preserveDisplay?: boolean } = {}) => {
    liveCanvasRenderToken += 1
    if (invalidateOptions.preserveDisplay === true && displayReady.value) {
      preserveSurfaceUntilNextReady = true
      suppressNextSurfaceFadeIn = true
      return
    }
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
    const wasDisplayReady = displayReady.value
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
    const allowPlaybackScrollReuse = canReusePlaybackScroll
    const effectiveRawIntersection = isRawDataIntersectingRange(
      effectiveRawData,
      renderStartSec,
      visibleDuration
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
    clearDragPresentationRelease()
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
    if (
      safeViewportStartSec !== null &&
      resolveStableWaveformSource() &&
      stablePresentation.applyViewportRangeStart(safeViewportStartSec)
    ) {
      clearDragPresentationRelease()
      preserveSurfaceUntilNextReady = true
      suppressNextSurfaceFadeIn = true
      return {
        requiresRender: true
      }
    }
    dragPresentationReleasePending = true
    dragPresentationReleaseActive.value = true
    dragPresentationReleaseViewportStartSec = safeViewportStartSec
    dragPresentationReleaseStartedAtMs = performance.now()
    preserveSurfaceUntilNextReady = true
    suppressNextSurfaceFadeIn = true
    return {
      requiresRender: true
    }
  }

  const hideStableCanvasPresentation = () => {
    clearStableFullRenderTimer()
    if (displayReady.value) {
      preserveSurfaceUntilNextReady = true
      suppressNextSurfaceFadeIn = true
      stableSurfaceForceHidden = false
      stablePresentation.stopPlayback()
      stablePresentationRevealAfterMs = 0
      return
    }
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

  const replaceLiveWaveformRaw = (data: RawWaveformData | null) => liveCanvasBridge.replaceRaw(data)

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
    resolveRenderedCanvasViewportStartSec,
    dragPresentationReleaseActive,
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
