import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { createRawPlaceholderMixxxData } from '@renderer/components/beatGridWaveformPlaceholder'
import { drawRgbWaveform } from '@renderer/components/rgbWaveformRenderer'
import { resolveCanvasScaleMetrics } from '@renderer/utils/canvasScale'
import { createHorizontalBrowseDetailLiveCanvasOverlayRenderer } from './horizontalBrowseDetailLiveCanvasOverlay'
import { createHorizontalBrowseDetailLiveCanvasRawStore } from './horizontalBrowseDetailLiveCanvasRawStore'
import { renderHorizontalBrowseTimelineFallback } from './horizontalBrowseDetailLiveCanvasTimelineFallback'
import {
  resolveOverlayRangeDurationSec,
  resolveOverlayRangeStartSec,
  resolvePresentationOffsetCssPx
} from './horizontalBrowseDetailLiveCanvasPresentation'
import {
  PLAYBACK_CLOCK_REANCHOR_MIN_FRAME_GAP_MS,
  PLAYBACK_INITIAL_FULL_RENDER_LEAD_DEFAULT_MS,
  PLAYBACK_RENDER_FALLBACK_TIMEOUT_MS,
  PLAYBACK_RENDER_INTERVAL_MS,
  PLAYBACK_RENDER_MIN_FRAME_GAP_MS,
  PLAYBACK_SCROLL_REUSE_MAX_FRAME_GAP_MS,
  PLAYBACK_SCROLL_REUSE_RECOVERY_FRAMES,
  buildPlaybackRenderRequest,
  clampPlaybackRenderLeadMs,
  hasPlaybackRenderClock,
  resolvePlaybackRenderClockStartedAtMs,
  resolvePlaybackSeconds
} from './horizontalBrowseDetailLiveCanvasPlayback'
import {
  canPreserveHorizontalBrowseWaveformAfterRenderMiss,
  canPreservePlaybackFrameOnMissingRaw
} from './horizontalBrowseDetailLiveCanvasRenderGuards'
import type {
  CanvasMetrics,
  FrameState,
  PlaybackAnimationState,
  WorkerAnimationFrameScope
} from './horizontalBrowseDetailLiveCanvasRenderState'
import type {
  HorizontalBrowseDetailLiveCanvasRenderRequest,
  HorizontalBrowseDetailLiveCanvasWorkerIncoming,
  HorizontalBrowseDetailLiveCanvasWorkerOutgoing
} from './horizontalBrowseDetailLiveCanvas.types'

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const normalizeWaveformGain = (value: number) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 1
  return clampNumber(numeric, 0, 16)
}
let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null
let lastFrame: FrameState | null = null
let lastWaveformScrollShiftScaledPx: number | null = null
let scrollScratchCanvas: OffscreenCanvas | null = null
let scrollScratchCtx: OffscreenCanvasRenderingContext2D | null = null
let segmentCanvas: OffscreenCanvas | null = null
let segmentCtx: OffscreenCanvasRenderingContext2D | null = null
let pendingRender: HorizontalBrowseDetailLiveCanvasRenderRequest | null = null
let renderTimer: ReturnType<typeof setTimeout> | null = null
let playbackAnimation: PlaybackAnimationState | null = null
let playbackAnimationToken = 0
let playbackTimer: ReturnType<typeof setTimeout> | null = null
let playbackRaf = 0
let playbackInitialFullRenderLeadMs = PLAYBACK_INITIAL_FULL_RENDER_LEAD_DEFAULT_MS
const COLUMN_SMOOTH_OVERSCAN_SCALED_PX = 2
const VIEWPORT_RENDER_GUARD_RATIO = 0.35
const postToMain = (message: HorizontalBrowseDetailLiveCanvasWorkerOutgoing) =>
  (
    self as typeof globalThis & {
      postMessage: (payload: HorizontalBrowseDetailLiveCanvasWorkerOutgoing) => void
    }
  ).postMessage(message)
const overlayRenderer = createHorizontalBrowseDetailLiveCanvasOverlayRenderer()

const resetFrameState = () => {
  lastFrame = lastWaveformScrollShiftScaledPx = null
}
const invalidateRawFrameReuse = () => {
  lastWaveformScrollShiftScaledPx = null
}
const rawStore = createHorizontalBrowseDetailLiveCanvasRawStore(invalidateRawFrameReuse)
const resolveWorkerAnimationFrameScope = () => self as WorkerAnimationFrameScope
const clearPlaybackFrameSchedule = () => {
  if (playbackTimer) {
    clearTimeout(playbackTimer)
    playbackTimer = null
  }
  if (playbackRaf) {
    const scope = resolveWorkerAnimationFrameScope()
    if (typeof scope.cancelAnimationFrame === 'function') {
      scope.cancelAnimationFrame(playbackRaf)
    }
    playbackRaf = 0
  }
}

const consumePlaybackFrameSchedule = () => {
  const raf = playbackRaf
  const timer = playbackTimer
  playbackRaf = 0
  playbackTimer = null
  if (timer) {
    clearTimeout(timer)
  }
  if (raf) {
    const scope = resolveWorkerAnimationFrameScope()
    if (typeof scope.cancelAnimationFrame === 'function') {
      scope.cancelAnimationFrame(raf)
    }
  }
}

const stopPlaybackAnimation = () => {
  playbackAnimationToken += 1
  playbackAnimation = null
  clearPlaybackFrameSchedule()
}

const stopPlaybackAnimationAndPendingRender = () => {
  stopPlaybackAnimation()
  pendingRender = null
  if (renderTimer) {
    clearTimeout(renderTimer)
    renderTimer = null
  }
}

const ensureCanvasMetrics = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest
): CanvasMetrics | null => {
  if (!canvas || !ctx) return null
  const metrics = resolveCanvasScaleMetrics(request.width, request.height, request.pixelRatio, {
    preserveFractionalCssSize: true
  })
  const previousWidth = canvas.width
  const previousHeight = canvas.height
  if (canvas.width !== metrics.scaledWidth) {
    canvas.width = metrics.scaledWidth
  }
  if (canvas.height !== metrics.scaledHeight) {
    canvas.height = metrics.scaledHeight
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.imageSmoothingEnabled = false
  return {
    ...metrics,
    resized: previousWidth !== metrics.scaledWidth || previousHeight !== metrics.scaledHeight
  }
}

const ensureScratchCanvas = (
  currentCanvas: OffscreenCanvas | null,
  currentCtx: OffscreenCanvasRenderingContext2D | null,
  scaledWidth: number,
  scaledHeight: number
) => {
  let nextCanvas = currentCanvas
  let nextCtx = currentCtx
  if (!nextCanvas) {
    nextCanvas = new OffscreenCanvas(scaledWidth, scaledHeight)
    nextCtx = nextCanvas.getContext('2d')
  }
  if (!nextCanvas || !nextCtx) return null
  if (nextCanvas.width !== scaledWidth || nextCanvas.height !== scaledHeight) {
    nextCanvas.width = scaledWidth
    nextCanvas.height = scaledHeight
  }
  return {
    canvas: nextCanvas,
    ctx: nextCtx
  }
}

const ensureScrollScratch = (scaledWidth: number, scaledHeight: number) => {
  const scratch = ensureScratchCanvas(
    scrollScratchCanvas,
    scrollScratchCtx,
    scaledWidth,
    scaledHeight
  )
  if (!scratch) return null
  scrollScratchCanvas = scratch.canvas
  scrollScratchCtx = scratch.ctx
  return scratch
}

const ensureSegmentScratch = (scaledWidth: number, scaledHeight: number) => {
  const scratch = ensureScratchCanvas(segmentCanvas, segmentCtx, scaledWidth, scaledHeight)
  if (!scratch) return null
  segmentCanvas = scratch.canvas
  segmentCtx = scratch.ctx
  return scratch
}

const resolveRawForRender = (request: HorizontalBrowseDetailLiveCanvasRenderRequest) =>
  rawStore.resolveForRender(request.rawSlot)
const resolveRawRevisionForRender = (rawData: RawWaveformData | null) => {
  return rawStore.resolveRevisionForRender(rawData)
}

const buildFrameState = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  metrics: CanvasMetrics,
  rawData: RawWaveformData | null
): FrameState => ({
  width: metrics.cssWidth,
  height: metrics.cssHeight,
  firstBeatMs: Number(request.firstBeatMs) || 0,
  timeBasisOffsetMs: Number(request.timeBasisOffsetMs) || 0,
  rangeStartSec: Number.isFinite(request.rangeStartSec) ? request.rangeStartSec : 0,
  rangeDurationSec: Math.max(0.0001, Number(request.rangeDurationSec) || 0.0001),
  rawData,
  rawRevision: resolveRawRevisionForRender(rawData),
  maxSamplesPerPixel: request.maxSamplesPerPixel,
  showDetailHighlights: request.showDetailHighlights,
  showCenterLine: request.showCenterLine,
  showBackground: request.showBackground,
  waveformLayout: request.waveformLayout,
  waveformRenderStyle: request.waveformRenderStyle,
  preferRawPeaksOnly: request.preferRawPeaksOnly,
  themeVariant: request.themeVariant,
  waveformGain: normalizeWaveformGain(request.waveformGain),
  playbackSyncRevision: Math.max(0, Math.floor(Number(request.playbackSyncRevision) || 0))
})

const createMixxxData = (rawData: RawWaveformData | null): MixxxWaveformData | null =>
  rawData ? createRawPlaceholderMixxxData(rawData) : null

const drawRange = (
  targetCtx: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  rangeStartSec: number,
  rangeDurationSec: number,
  state: FrameState
) =>
  drawRgbWaveform(targetCtx, {
    width,
    height,
    timeBasisOffsetMs: state.timeBasisOffsetMs,
    rangeStartSec,
    rangeDurationSec,
    mixxxData: createMixxxData(state.rawData),
    rawData: state.rawData,
    showBackground: state.showBackground,
    maxSamplesPerPixel: state.maxSamplesPerPixel,
    showDetailHighlights: state.showDetailHighlights,
    showCenterLine: state.showCenterLine,
    waveformLayout: state.waveformLayout,
    waveformRenderStyle: state.waveformRenderStyle,
    preferRawPeaksOnly: state.preferRawPeaksOnly,
    smoothColumns: state.waveformRenderStyle === 'columns' && state.waveformLayout !== 'full',
    themeVariant: state.themeVariant,
    waveformGain: state.waveformGain
  })

const canCommitBlankRawSegment = (
  state: FrameState,
  rangeStartSec: number,
  rangeDurationSec: number
) => {
  const rawData = state.rawData
  if (!rawData || rangeDurationSec <= 0) return false
  const frames = Math.max(
    0,
    Math.min(
      Math.floor(Number(rawData.frames) || 0),
      rawData.minLeft.length,
      rawData.maxLeft.length,
      rawData.minRight.length,
      rawData.maxRight.length
    )
  )
  const rate = Number(rawData.rate)
  if (!frames || !Number.isFinite(rate) || rate <= 0) return false
  const loadedFrames = Math.max(
    0,
    Math.min(Math.floor(Number(rawData.loadedFrames ?? frames) || 0), frames)
  )
  if (!loadedFrames) return false
  const timeBasisOffsetSec = Math.max(0, Number(state.timeBasisOffsetMs) || 0) / 1000
  const rawStartSec = Math.max(0, Number(rawData.startSec) || 0) + timeBasisOffsetSec
  const rawEndSec = rawStartSec + loadedFrames / rate
  const rangeEndSec = rangeStartSec + rangeDurationSec
  return rangeEndSec > rawStartSec && rangeStartSec < rawEndSec
}

const renderSegmentToScratch = (
  metrics: CanvasMetrics,
  state: FrameState,
  segmentScaledX: number,
  segmentScaledWidth: number
) => {
  const smoothingOverscanScaledPx =
    state.waveformRenderStyle === 'columns' && state.waveformLayout !== 'full'
      ? COLUMN_SMOOTH_OVERSCAN_SCALED_PX
      : 0
  const safeSegmentX = clampNumber(
    Math.floor(segmentScaledX),
    0,
    Math.max(0, metrics.scaledWidth - 1)
  )
  const safeSegmentWidth = clampNumber(
    Math.ceil(segmentScaledWidth),
    1,
    Math.max(1, metrics.scaledWidth - safeSegmentX)
  )
  const drawSegmentX = clampNumber(
    safeSegmentX - smoothingOverscanScaledPx,
    0,
    Math.max(0, metrics.scaledWidth - 1)
  )
  const drawSegmentEndX = clampNumber(
    safeSegmentX + safeSegmentWidth + smoothingOverscanScaledPx,
    drawSegmentX + 1,
    metrics.scaledWidth
  )
  const drawSegmentWidth = Math.max(1, drawSegmentEndX - drawSegmentX)
  const sourceX = safeSegmentX - drawSegmentX
  const segment = ensureSegmentScratch(drawSegmentWidth, metrics.scaledHeight)
  if (!segment) return false

  const segmentStartSec =
    state.rangeStartSec + (drawSegmentX / metrics.scaledWidth) * state.rangeDurationSec
  const segmentDurationSec = (drawSegmentWidth / metrics.scaledWidth) * state.rangeDurationSec

  segment.ctx.setTransform(1, 0, 0, 1, 0, 0)
  segment.ctx.clearRect(0, 0, segment.canvas.width, segment.canvas.height)
  segment.ctx.imageSmoothingEnabled = false
  const rendered = drawRange(
    segment.ctx,
    drawSegmentWidth,
    metrics.scaledHeight,
    segmentStartSec,
    segmentDurationSec,
    state
  )
  const blankSegment =
    !rendered && canCommitBlankRawSegment(state, segmentStartSec, segmentDurationSec)
  if ((!rendered && !blankSegment) || !segment.canvas) return false

  return {
    canvas: segment.canvas,
    safeSegmentX,
    safeSegmentWidth,
    sourceX
  }
}

const copySegmentToCanvas = (
  targetCtx: OffscreenCanvasRenderingContext2D,
  metrics: CanvasMetrics,
  segment: Exclude<ReturnType<typeof renderSegmentToScratch>, false>
) => {
  const destX = clampNumber(segment.safeSegmentX, 0, Math.max(0, metrics.scaledWidth - 1))
  const copyWidth = Math.max(1, Math.min(segment.safeSegmentWidth, metrics.scaledWidth - destX))
  targetCtx.setTransform(1, 0, 0, 1, 0, 0)
  targetCtx.imageSmoothingEnabled = false
  targetCtx.clearRect(destX, 0, copyWidth, metrics.scaledHeight)
  targetCtx.drawImage(
    segment.canvas,
    segment.sourceX,
    0,
    copyWidth,
    metrics.scaledHeight,
    destX,
    0,
    copyWidth,
    metrics.scaledHeight
  )
}

const drawSegment = (
  targetCtx: OffscreenCanvasRenderingContext2D,
  metrics: CanvasMetrics,
  state: FrameState,
  segmentScaledX: number,
  segmentScaledWidth: number
) => {
  const segment = renderSegmentToScratch(metrics, state, segmentScaledX, segmentScaledWidth)
  if (!segment) return false
  copySegmentToCanvas(targetCtx, metrics, segment)
  return true
}

const renderViewportSegment = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  metrics: CanvasMetrics,
  state: FrameState
) => {
  if (!ctx) return false
  const viewportWidth = Math.max(1, Number(request.viewportWidth) || metrics.cssWidth)
  if (Math.abs(viewportWidth - metrics.cssWidth) <= 0.5) {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, metrics.scaledWidth, metrics.scaledHeight)
    return drawRange(
      ctx,
      metrics.scaledWidth,
      metrics.scaledHeight,
      state.rangeStartSec,
      state.rangeDurationSec,
      state
    )
  }
  const viewportRangeStartSec = Number(request.viewportRangeStartSec)
  const viewportRangeDurationSec = Number(request.viewportRangeDurationSec)
  if (
    !Number.isFinite(viewportRangeStartSec) ||
    !Number.isFinite(viewportRangeDurationSec) ||
    viewportRangeDurationSec <= 0
  ) {
    return false
  }
  const rawSegmentX =
    ((viewportRangeStartSec - state.rangeStartSec) / Math.max(0.0001, state.rangeDurationSec)) *
    metrics.scaledWidth
  const rawSegmentWidth =
    (viewportRangeDurationSec / Math.max(0.0001, state.rangeDurationSec)) * metrics.scaledWidth
  const guardScaledPx = Math.min(
    metrics.scaledWidth,
    Math.max(metrics.scaleX * 32, rawSegmentWidth * VIEWPORT_RENDER_GUARD_RATIO)
  )
  const segmentX = Math.max(0, rawSegmentX - guardScaledPx)
  const segmentWidth = Math.min(metrics.scaledWidth - segmentX, rawSegmentWidth + guardScaledPx * 2)
  const clearX = clampNumber(Math.floor(segmentX) - 2, 0, Math.max(0, metrics.scaledWidth - 1))
  const clearEndX = clampNumber(
    Math.ceil(segmentX + segmentWidth) + 2,
    clearX + 1,
    metrics.scaledWidth
  )
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(clearX, 0, clearEndX - clearX, metrics.scaledHeight)
  return drawSegment(ctx, metrics, state, segmentX, segmentWidth)
}

const canReusePreviousFrame = (
  current: FrameState,
  metrics: CanvasMetrics,
  ignoreFirstBeatMs = false,
  ignoreRawRevision = false
) => {
  if (metrics.resized || !lastFrame) return false
  return (
    lastFrame.width === current.width &&
    lastFrame.height === current.height &&
    (ignoreFirstBeatMs || lastFrame.firstBeatMs === current.firstBeatMs) &&
    lastFrame.timeBasisOffsetMs === current.timeBasisOffsetMs &&
    lastFrame.rangeDurationSec === current.rangeDurationSec &&
    lastFrame.rawData === current.rawData &&
    (ignoreRawRevision || lastFrame.rawRevision === current.rawRevision) &&
    lastFrame.showDetailHighlights === current.showDetailHighlights &&
    lastFrame.showCenterLine === current.showCenterLine &&
    lastFrame.showBackground === current.showBackground &&
    lastFrame.waveformLayout === current.waveformLayout &&
    lastFrame.waveformRenderStyle === current.waveformRenderStyle &&
    lastFrame.preferRawPeaksOnly === current.preferRawPeaksOnly &&
    lastFrame.themeVariant === current.themeVariant &&
    lastFrame.waveformGain === current.waveformGain &&
    lastFrame.playbackSyncRevision === current.playbackSyncRevision
  )
}

const clearWaveformPixels = () => {
  if (canvas && ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }
  resetFrameState()
}

const clearCanvasPixels = () => {
  pendingRender = null
  stopPlaybackAnimation()
  clearWaveformPixels()
  overlayRenderer.clear()
}

const shouldUseStableColumnGrid = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  state: FrameState
) =>
  request.playbackActive === true &&
  state.waveformRenderStyle === 'columns' &&
  state.waveformLayout !== 'full'

const resolveStableColumnRangeStartSec = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  metrics: CanvasMetrics,
  state: FrameState,
  phaseShiftSec = 0
) => {
  if (!shouldUseStableColumnGrid(request, state)) return state.rangeStartSec
  const scaledPxPerSec = metrics.scaledWidth / Math.max(0.0001, state.rangeDurationSec)
  return (
    Math.round((state.rangeStartSec - phaseShiftSec) * scaledPxPerSec) / scaledPxPerSec +
    phaseShiftSec
  )
}

const renderFullFrame = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  metrics: CanvasMetrics,
  state: FrameState
) => {
  if (!ctx) return false
  const phaseAwareScrollReuse = request.phaseAwareScrollReuse === true
  const canReuseSameRawDataWithNewRevision =
    request.playbackActive === true && lastFrame?.rawData === state.rawData
  const resolveReusedFrameState = () =>
    canReuseSameRawDataWithNewRevision && lastFrame && lastFrame.rawRevision !== state.rawRevision
      ? { ...state, rawRevision: lastFrame.rawRevision }
      : state
  const resolvePhaseShiftSec = (previous: FrameState) =>
    phaseAwareScrollReuse ? (state.firstBeatMs - previous.firstBeatMs) / 1000 : 0
  lastWaveformScrollShiftScaledPx = null

  if (
    request.allowScrollReuse !== false &&
    canReusePreviousFrame(
      state,
      metrics,
      phaseAwareScrollReuse,
      canReuseSameRawDataWithNewRevision
    ) &&
    lastFrame &&
    Math.abs(state.rangeStartSec - lastFrame.rangeStartSec - resolvePhaseShiftSec(lastFrame)) <=
      0.000001
  ) {
    state.rangeStartSec = lastFrame.rangeStartSec + resolvePhaseShiftSec(lastFrame)
    lastFrame = resolveReusedFrameState()
    return true
  }

  let reused = false
  if (
    request.allowScrollReuse !== false &&
    canReusePreviousFrame(
      state,
      metrics,
      phaseAwareScrollReuse,
      canReuseSameRawDataWithNewRevision
    ) &&
    lastFrame
  ) {
    const phaseShiftSec = resolvePhaseShiftSec(lastFrame)
    const requestedRangeStartSec = resolveStableColumnRangeStartSec(
      request,
      metrics,
      state,
      phaseShiftSec
    )
    const requestedShiftScaledPx =
      ((requestedRangeStartSec - lastFrame.rangeStartSec - phaseShiftSec) /
        state.rangeDurationSec) *
      metrics.scaledWidth
    const shiftScaledPx = Math.round(requestedShiftScaledPx)
    const quantizedRangeStartSec =
      lastFrame.rangeStartSec +
      phaseShiftSec +
      (shiftScaledPx / metrics.scaledWidth) * state.rangeDurationSec
    const absShiftScaledPx = Math.abs(shiftScaledPx)
    if (absShiftScaledPx === 0) {
      state.rangeStartSec = lastFrame.rangeStartSec + phaseShiftSec
      lastWaveformScrollShiftScaledPx = 0
      reused = true
    } else if (absShiftScaledPx < metrics.scaledWidth) {
      state.rangeStartSec = quantizedRangeStartSec
      const scratch = ensureScrollScratch(metrics.scaledWidth, metrics.scaledHeight)
      if (scratch) {
        scratch.ctx.setTransform(1, 0, 0, 1, 0, 0)
        scratch.ctx.imageSmoothingEnabled = false
        scratch.ctx.clearRect(0, 0, metrics.scaledWidth, metrics.scaledHeight)
        if (canvas) {
          scratch.ctx.drawImage(canvas, 0, 0)
        }

        const segmentPaddingScaledPx = Math.max(2, Math.ceil(metrics.scaleX * 2))
        let segment: ReturnType<typeof renderSegmentToScratch> | false = false
        if (shiftScaledPx > 0) {
          const segmentX = Math.max(
            0,
            metrics.scaledWidth - absShiftScaledPx - segmentPaddingScaledPx
          )
          const segmentWidth = Math.max(1, metrics.scaledWidth - segmentX)
          segment = renderSegmentToScratch(metrics, state, segmentX, segmentWidth)
        } else {
          const segmentWidth = Math.max(
            1,
            Math.min(metrics.scaledWidth, absShiftScaledPx + segmentPaddingScaledPx)
          )
          segment = renderSegmentToScratch(metrics, state, 0, segmentWidth)
        }
        if (segment) {
          ctx.setTransform(1, 0, 0, 1, 0, 0)
          ctx.imageSmoothingEnabled = false
          ctx.clearRect(0, 0, metrics.scaledWidth, metrics.scaledHeight)

          const keepScaledWidth = Math.max(0, metrics.scaledWidth - absShiftScaledPx)
          if (keepScaledWidth > 0) {
            if (shiftScaledPx > 0) {
              ctx.drawImage(
                scratch.canvas,
                absShiftScaledPx,
                0,
                keepScaledWidth,
                metrics.scaledHeight,
                0,
                0,
                keepScaledWidth,
                metrics.scaledHeight
              )
            } else {
              ctx.drawImage(
                scratch.canvas,
                0,
                0,
                keepScaledWidth,
                metrics.scaledHeight,
                absShiftScaledPx,
                0,
                keepScaledWidth,
                metrics.scaledHeight
              )
            }
          }

          copySegmentToCanvas(ctx, metrics, segment)
          reused = true
        }
        if (reused) {
          lastWaveformScrollShiftScaledPx = shiftScaledPx
        }
      }
    }
  }

  if (!reused) {
    state.rangeStartSec = resolveStableColumnRangeStartSec(request, metrics, state)
    if (request.renderViewportOnly === true) {
      reused = renderViewportSegment(request, metrics, state)
    } else {
      const fullFrame = ensureSegmentScratch(metrics.scaledWidth, metrics.scaledHeight)
      if (fullFrame) {
        fullFrame.ctx.setTransform(1, 0, 0, 1, 0, 0)
        fullFrame.ctx.imageSmoothingEnabled = false
        fullFrame.ctx.clearRect(0, 0, fullFrame.canvas.width, fullFrame.canvas.height)
        reused = drawRange(
          fullFrame.ctx,
          metrics.scaledWidth,
          metrics.scaledHeight,
          state.rangeStartSec,
          state.rangeDurationSec,
          state
        )
        if (reused) {
          ctx.setTransform(1, 0, 0, 1, 0, 0)
          ctx.imageSmoothingEnabled = false
          ctx.clearRect(0, 0, metrics.scaledWidth, metrics.scaledHeight)
          ctx.drawImage(fullFrame.canvas, 0, 0)
        }
      }
    }
  }

  if (!reused) {
    return false
  }

  lastFrame =
    request.renderViewportOnly === true
      ? null
      : lastWaveformScrollShiftScaledPx === null
        ? state
        : resolveReusedFrameState()
  return true
}

const postPresentationOffset = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  metrics: CanvasMetrics,
  committedRangeStartSec: number,
  committedRangeDurationSec: number
) => {
  const offset = resolvePresentationOffsetCssPx(
    request,
    metrics,
    committedRangeStartSec,
    committedRangeDurationSec
  )
  postToMain({
    type: 'presentation',
    payload: { renderToken: request.renderToken, offsetCssPx: Number.isFinite(offset) ? offset : 0 }
  })
}

const processRender = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  notifyMain = true
) => {
  const metrics = ensureCanvasMetrics(request)
  const rawData = resolveRawForRender(request)
  const state = metrics ? buildFrameState(request, metrics, rawData) : null
  const renderState = state as FrameState | null
  const previousFrame = lastFrame
  const ready =
    !!metrics && !!rawData && renderFullFrame(request, metrics, renderState as FrameState)

  const holdMissingPlaybackRaw =
    !!metrics &&
    !!renderState &&
    !ready &&
    request.playbackActive === true &&
    request.rawSlot !== null &&
    !rawData &&
    canPreservePlaybackFrameOnMissingRaw(renderState, previousFrame)
  const preserved =
    holdMissingPlaybackRaw ||
    (!!metrics &&
      !!renderState &&
      !ready &&
      canPreserveHorizontalBrowseWaveformAfterRenderMiss(request, renderState, previousFrame))
  if (preserved) {
    lastFrame = previousFrame
    lastWaveformScrollShiftScaledPx = null
  } else if (metrics && renderState && !ready && !holdMissingPlaybackRaw) {
    clearWaveformPixels()
    if (request.showTimelinePlaceholder && ctx) {
      renderHorizontalBrowseTimelineFallback(ctx, request, metrics)
    }
  }
  // committed range 是本次实际留在 canvas 上的波形坐标；preserved 帧必须回报旧帧坐标。
  const committedRangeStartSec =
    preserved && previousFrame
      ? previousFrame.rangeStartSec
      : (renderState?.rangeStartSec ?? request.rangeStartSec)
  const committedRangeDurationSec =
    preserved && previousFrame
      ? previousFrame.rangeDurationSec
      : (renderState?.rangeDurationSec ?? request.rangeDurationSec)
  if (
    metrics &&
    renderState &&
    !overlayRenderer.render(
      request,
      request.stableWaveformSource === true
        ? committedRangeStartSec
        : resolveOverlayRangeStartSec(request),
      request.stableWaveformSource === true
        ? committedRangeDurationSec
        : resolveOverlayRangeDurationSec(request),
      lastWaveformScrollShiftScaledPx
    )
  ) {
    overlayRenderer.clear()
  }

  if (metrics && renderState) {
    postPresentationOffset(request, metrics, committedRangeStartSec, committedRangeDurationSec)
  }

  if (notifyMain) {
    postToMain({
      type: 'rendered',
      payload: {
        renderToken: request.renderToken,
        rangeStartSec: committedRangeStartSec,
        rangeDurationSec: committedRangeDurationSec,
        ready: ready || preserved,
        renderViewportOnly: request.renderViewportOnly === true
      }
    })
  }
}

const schedulePlaybackRender = (token: number) => {
  clearPlaybackFrameSchedule()
  const renderFrame = () => {
    consumePlaybackFrameSchedule()
    const animation = playbackAnimation
    if (!animation || animation.token !== token || token !== playbackAnimationToken) return
    const nowMs = performance.now()
    const frameGapMs = Math.max(0, nowMs - animation.lastRenderedAtMs)
    if (
      animation.request.rawSlot !== null &&
      frameGapMs > 0 &&
      frameGapMs < PLAYBACK_RENDER_MIN_FRAME_GAP_MS
    ) {
      const delayMs = Math.max(1, PLAYBACK_RENDER_MIN_FRAME_GAP_MS - frameGapMs)
      playbackTimer = setTimeout(renderFrame, delayMs)
      return
    }
    const frameGapTooLong = frameGapMs > PLAYBACK_SCROLL_REUSE_MAX_FRAME_GAP_MS
    const scrollReuseSuppressed = animation.scrollReuseSuppressedFrames > 0
    if (scrollReuseSuppressed) animation.scrollReuseSuppressedFrames -= 1
    if (
      frameGapMs > PLAYBACK_CLOCK_REANCHOR_MIN_FRAME_GAP_MS &&
      !hasPlaybackRenderClock(animation.request)
    ) {
      animation.baseSeconds = resolvePlaybackSeconds(
        animation.request,
        animation.baseSeconds,
        animation.startedAtMs,
        animation.lastRenderedAtMs
      )
      animation.startedAtMs = nowMs
    }
    if (frameGapTooLong)
      animation.scrollReuseSuppressedFrames = PLAYBACK_SCROLL_REUSE_RECOVERY_FRAMES
    const allowScrollReuse =
      !scrollReuseSuppressed && !frameGapTooLong && animation.request.allowScrollReuse !== false
    processRender(buildPlaybackRenderRequest(animation, allowScrollReuse, nowMs), false)
    animation.lastRenderedAtMs = nowMs
    if (playbackAnimation?.token === token && token === playbackAnimationToken) {
      schedulePlaybackRender(token)
    }
  }
  const scope = resolveWorkerAnimationFrameScope()
  if (typeof scope.requestAnimationFrame === 'function') {
    playbackRaf = scope.requestAnimationFrame(renderFrame)
  }
  playbackTimer = setTimeout(
    renderFrame,
    playbackRaf ? PLAYBACK_RENDER_FALLBACK_TIMEOUT_MS : PLAYBACK_RENDER_INTERVAL_MS
  )
}

const activatePlaybackAnimation = (request: HorizontalBrowseDetailLiveCanvasRenderRequest) => {
  const current = playbackAnimation
  const nowMs = performance.now()
  const incomingSeconds = Number(request.playbackSeconds) || 0
  const requestUsesRenderClock = hasPlaybackRenderClock(request)
  const incomingStartedAtMs = resolvePlaybackRenderClockStartedAtMs(request, nowMs)
  const forceIncomingSeconds =
    current &&
    Math.floor(Number(request.playbackSyncRevision) || 0) !==
      Math.floor(Number(current.request.playbackSyncRevision) || 0)
  const shouldRestartSchedule = !current || forceIncomingSeconds
  const token = shouldRestartSchedule || !current ? playbackAnimationToken + 1 : current.token
  const baseSeconds = current
    ? forceIncomingSeconds || requestUsesRenderClock
      ? incomingSeconds
      : resolvePlaybackSeconds(current.request, current.baseSeconds, current.startedAtMs, nowMs)
    : incomingSeconds
  const currentSuppressedFrames =
    current && !forceIncomingSeconds ? current.scrollReuseSuppressedFrames : 0
  const shouldWarmUpScrollReuse =
    request.playbackActive === true &&
    request.allowScrollReuse === false &&
    request.rawSlot !== null
  const scrollReuseSuppressedFrames = shouldWarmUpScrollReuse
    ? Math.max(currentSuppressedFrames, PLAYBACK_SCROLL_REUSE_RECOVERY_FRAMES)
    : currentSuppressedFrames
  const animationRequest = shouldWarmUpScrollReuse
    ? { ...request, allowScrollReuse: true }
    : request
  const canContinueCurrentAnimation =
    !!current &&
    !!lastFrame &&
    !forceIncomingSeconds &&
    request.rawSlot !== null &&
    current.request.rawSlot === request.rawSlot &&
    current.request.width === request.width &&
    current.request.height === request.height &&
    current.request.pixelRatio === request.pixelRatio &&
    current.request.rangeDurationSec === request.rangeDurationSec &&
    current.request.waveformLayout === request.waveformLayout &&
    current.request.waveformRenderStyle === request.waveformRenderStyle &&
    current.request.themeVariant === request.themeVariant &&
    normalizeWaveformGain(current.request.waveformGain) ===
      normalizeWaveformGain(request.waveformGain)
  if (canContinueCurrentAnimation) {
    current.request = animationRequest
    if (requestUsesRenderClock) {
      current.baseSeconds = baseSeconds
      current.startedAtMs = incomingStartedAtMs
    }
    current.scrollReuseSuppressedFrames = scrollReuseSuppressedFrames
    const continuedRenderRequest = buildPlaybackRenderRequest(
      current,
      request.allowScrollReuse !== false,
      nowMs
    )
    processRender(
      {
        ...continuedRenderRequest,
        renderToken: request.renderToken
      },
      true
    )
    current.lastRenderedAtMs = performance.now()
    if (!playbackTimer) {
      schedulePlaybackRender(current.token)
    }
    return
  }
  if (shouldRestartSchedule) {
    playbackAnimationToken = token
  }
  clearPlaybackFrameSchedule()
  playbackAnimation = {
    token,
    request: animationRequest,
    baseSeconds,
    startedAtMs: requestUsesRenderClock ? incomingStartedAtMs : nowMs,
    lastRenderedAtMs: nowMs,
    scrollReuseSuppressedFrames
  }
  const shouldPredictInitialFullRender =
    !requestUsesRenderClock && request.rawSlot !== null && request.allowScrollReuse === false
  const initialRenderLeadMs = shouldPredictInitialFullRender
    ? clampPlaybackRenderLeadMs(playbackInitialFullRenderLeadMs)
    : 0
  const initialRenderRequest = buildPlaybackRenderRequest(
    playbackAnimation,
    request.allowScrollReuse !== false,
    nowMs + initialRenderLeadMs
  )
  processRender(initialRenderRequest, true)
  if (shouldPredictInitialFullRender && playbackAnimation) {
    const committedAtMs = performance.now()
    const renderElapsedMs = Math.max(0, committedAtMs - nowMs)
    playbackInitialFullRenderLeadMs = clampPlaybackRenderLeadMs(
      playbackInitialFullRenderLeadMs * 0.65 + renderElapsedMs * 0.35
    )
    playbackAnimation.baseSeconds = initialRenderRequest.playbackSeconds
    playbackAnimation.startedAtMs = committedAtMs
    playbackAnimation.lastRenderedAtMs = committedAtMs
  }
  if (playbackAnimation?.token === token && !playbackTimer) {
    schedulePlaybackRender(token)
  }
}

const processRenderRequest = (request: HorizontalBrowseDetailLiveCanvasRenderRequest) => {
  const stableWaveformSource = request.stableWaveformSource === true
  const shouldAnimatePlayback = request.playbackActive === true && !stableWaveformSource

  if (shouldAnimatePlayback) {
    activatePlaybackAnimation(request)
    return
  }

  if (request.playbackActive !== true || stableWaveformSource) {
    stopPlaybackAnimation()
  }
  processRender(request)
}

const scheduleRender = (request: HorizontalBrowseDetailLiveCanvasRenderRequest) => {
  if (request.renderPriority === 'immediate') {
    if (renderTimer) {
      clearTimeout(renderTimer)
      renderTimer = null
    }
    pendingRender = null
    processRenderRequest(request)
    return
  }
  pendingRender = request
  if (renderTimer) return
  renderTimer = setTimeout(() => {
    renderTimer = null
    const nextRender = pendingRender
    pendingRender = null
    if (nextRender) {
      processRenderRequest(nextRender)
    }
  }, 0)
}

self.onmessage = (event: MessageEvent<HorizontalBrowseDetailLiveCanvasWorkerIncoming>) => {
  const message = event.data
  if (!message?.type) return

  if (message.type === 'attachCanvas') {
    canvas = message.payload.waveformCanvas
    ctx = canvas.getContext('2d')
    overlayRenderer.attach(message.payload.overlayCanvas)
    resetFrameState()
    return
  }

  if (message.type === 'clear') {
    clearCanvasPixels()
    return
  }

  if (message.type === 'clearRaw') {
    rawStore.clear()
    clearCanvasPixels()
    return
  }

  if (message.type === 'stopPlayback') {
    stopPlaybackAnimationAndPendingRender()
    return
  }

  if (message.type === 'replaceRaw') {
    rawStore.replace(message.payload.data)
    return
  }

  if (message.type === 'render') {
    scheduleRender(message.payload)
  }
}
