import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { createRawPlaceholderMixxxData } from '@renderer/components/mixtapeBeatAlignWaveformPlaceholder'
import { drawBeatAlignRekordboxWaveform } from '@renderer/components/mixtapeBeatAlignWaveform'
import { resolveCanvasScaleMetrics } from '@renderer/utils/canvasScale'
import { createHorizontalBrowseDetailLiveCanvasOverlayRenderer } from './horizontalBrowseDetailLiveCanvasOverlay'
import type {
  HorizontalBrowseDetailLiveCanvasRawMeta,
  HorizontalBrowseDetailLiveCanvasRenderRequest,
  HorizontalBrowseDetailLiveCanvasWorkerIncoming,
  HorizontalBrowseDetailLiveCanvasWorkerOutgoing
} from './horizontalBrowseDetailLiveCanvas.types'

type CanvasMetrics = {
  cssWidth: number
  cssHeight: number
  pixelRatio: number
  scaledWidth: number
  scaledHeight: number
  scaleX: number
  scaleY: number
  resized: boolean
}

type FrameState = {
  width: number
  height: number
  bpm: number
  firstBeatMs: number
  barBeatOffset: number
  timeBasisOffsetMs: number
  rangeStartSec: number
  rangeDurationSec: number
  rawData: RawWaveformData | null
  rawRevision: number
  maxSamplesPerPixel: number
  showDetailHighlights: boolean
  showCenterLine: boolean
  showBackground: boolean
  showBeatGrid: boolean
  waveformLayout: 'top-half' | 'bottom-half'
  preferRawPeaksOnly: boolean
  themeVariant: 'light' | 'dark'
}

type PlaybackAnimationState = {
  token: number
  request: HorizontalBrowseDetailLiveCanvasRenderRequest
  baseSeconds: number
  startedAtMs: number
}

type WorkerAnimationFrameScope = typeof globalThis & {
  requestAnimationFrame?: (callback: FrameRequestCallback) => number
  cancelAnimationFrame?: (handle: number) => void
}

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const PLAYHEAD_RATIO = 0.5
const PLAYBACK_RENDER_INTERVAL_MS = 16
const PLAYBACK_SYNC_TOLERANCE_SEC = 0.02

let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null
const overlayRenderer = createHorizontalBrowseDetailLiveCanvasOverlayRenderer()
let liveRawData: RawWaveformData | null = null
let retainedRawData: RawWaveformData | null = null
let liveRawRevision = 0
let retainedRawRevision = 0
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
let lastWaveformRenderMode = 'none'

const postToMain = (message: HorizontalBrowseDetailLiveCanvasWorkerOutgoing) => {
  const scope = self as typeof globalThis & {
    postMessage: (payload: HorizontalBrowseDetailLiveCanvasWorkerOutgoing) => void
  }
  scope.postMessage(message)
}

const resetFrameState = () => {
  lastFrame = null
  lastWaveformScrollShiftScaledPx = null
  lastWaveformRenderMode = 'reset'
}

const bumpLiveRawRevision = () => {
  liveRawRevision += 1
}

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

const stopPlaybackAnimation = () => {
  playbackAnimationToken += 1
  playbackAnimation = null
  clearPlaybackFrameSchedule()
}

const clampPlaybackRangeStart = (value: number, duration: number, visibleDuration: number) => {
  if (!duration || !visibleDuration) return 0
  const leadingPad = visibleDuration * PLAYHEAD_RATIO
  const trailingPad = visibleDuration * (1 - PLAYHEAD_RATIO)
  return clampNumber(value, -leadingPad, Math.max(-leadingPad, duration - trailingPad))
}

const resolvePlaybackSeconds = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  baseSeconds: number,
  startedAtMs: number,
  nowMs = performance.now()
) => {
  const elapsedSec = Math.max(0, nowMs - startedAtMs) / 1000
  const playbackRate = Math.max(0, Number(request.playbackRate) || 1)
  const durationSec = Math.max(0, Number(request.playbackDurationSec) || 0)
  const seconds = baseSeconds + elapsedSec * playbackRate
  return durationSec ? clampNumber(seconds, 0, durationSec) : Math.max(0, seconds)
}

const resolvePlaybackRangeStartSec = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  playbackSeconds: number
) => {
  const durationSec = Math.max(0, Number(request.playbackDurationSec) || 0)
  return clampPlaybackRangeStart(
    playbackSeconds - request.rangeDurationSec * PLAYHEAD_RATIO,
    durationSec,
    request.rangeDurationSec
  )
}

const applyCanvasScaleTransform = (
  targetCtx: OffscreenCanvasRenderingContext2D,
  scaleX: number,
  scaleY: number
) => {
  targetCtx.setTransform(1, 0, 0, 1, 0, 0)
  targetCtx.imageSmoothingEnabled = false
  targetCtx.setTransform(scaleX, 0, 0, scaleY, 0, 0)
}

const ensureCanvasMetrics = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest
): CanvasMetrics | null => {
  if (!canvas || !ctx) return null
  const metrics = resolveCanvasScaleMetrics(request.width, request.height, request.pixelRatio)
  const previousWidth = canvas.width
  const previousHeight = canvas.height
  if (canvas.width !== metrics.scaledWidth) {
    canvas.width = metrics.scaledWidth
  }
  if (canvas.height !== metrics.scaledHeight) {
    canvas.height = metrics.scaledHeight
  }
  applyCanvasScaleTransform(ctx, metrics.scaleX, metrics.scaleY)
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

const createEmptyRawData = (meta: HorizontalBrowseDetailLiveCanvasRawMeta): RawWaveformData => {
  const frames = Math.max(0, Math.floor(Number(meta.frames) || 0))
  return {
    duration: Math.max(0, Number(meta.duration) || 0),
    sampleRate: Math.max(0, Number(meta.sampleRate) || 0),
    rate: Math.max(0, Number(meta.rate) || 0),
    frames,
    startSec: Math.max(0, Number(meta.startSec) || 0),
    loadedFrames: Math.max(0, Math.floor(Number(meta.loadedFrames) || 0)),
    minLeft: new Float32Array(frames),
    maxLeft: new Float32Array(frames),
    minRight: new Float32Array(frames),
    maxRight: new Float32Array(frames)
  }
}

const hasSameRawMeta = (current: RawWaveformData, meta: HorizontalBrowseDetailLiveCanvasRawMeta) =>
  current.sampleRate === meta.sampleRate &&
  current.rate === meta.rate &&
  Math.abs((current.startSec ?? 0) - meta.startSec) <= 0.0001 &&
  Math.abs(current.duration - meta.duration) <= 0.0001

const growRawArray = (source: Float32Array, frames: number) => {
  const target = new Float32Array(frames)
  target.set(source.subarray(0, Math.min(source.length, frames)))
  return target
}

const ensureLiveRawCapacity = (
  meta: HorizontalBrowseDetailLiveCanvasRawMeta,
  retainCurrent = false
) => {
  const frames = Math.max(0, Math.floor(Number(meta.frames) || 0))
  if (!frames) return

  if (!liveRawData || !hasSameRawMeta(liveRawData, meta)) {
    if (retainCurrent && liveRawData) {
      retainedRawData = liveRawData
      retainedRawRevision = liveRawRevision
    }
    liveRawData = createEmptyRawData({ ...meta, frames })
    bumpLiveRawRevision()
    resetFrameState()
    return
  }

  if (liveRawData.frames >= frames) {
    if (typeof meta.loadedFrames === 'number') {
      const nextLoadedFrames = Math.max(
        Number(liveRawData.loadedFrames) || 0,
        Math.floor(meta.loadedFrames)
      )
      if (nextLoadedFrames !== liveRawData.loadedFrames) {
        liveRawData.loadedFrames = nextLoadedFrames
        bumpLiveRawRevision()
      }
    }
    return
  }

  liveRawData = {
    duration: Math.max(liveRawData.duration, meta.duration),
    sampleRate: meta.sampleRate,
    rate: meta.rate,
    frames,
    startSec: meta.startSec,
    loadedFrames: liveRawData.loadedFrames,
    minLeft: growRawArray(liveRawData.minLeft, frames),
    maxLeft: growRawArray(liveRawData.maxLeft, frames),
    minRight: growRawArray(liveRawData.minRight, frames),
    maxRight: growRawArray(liveRawData.maxRight, frames)
  }
  bumpLiveRawRevision()
  resetFrameState()
}

const replaceLiveRawData = (rawData: RawWaveformData | null) => {
  liveRawData = rawData
    ? {
        duration: Math.max(0, Number(rawData.duration) || 0),
        sampleRate: Math.max(0, Number(rawData.sampleRate) || 0),
        rate: Math.max(0, Number(rawData.rate) || 0),
        frames: Math.max(0, Number(rawData.frames) || 0),
        startSec: Math.max(0, Number(rawData.startSec) || 0),
        loadedFrames: Math.max(0, Number(rawData.loadedFrames ?? rawData.frames) || 0),
        minLeft: rawData.minLeft,
        maxLeft: rawData.maxLeft,
        minRight: rawData.minRight,
        maxRight: rawData.maxRight
      }
    : null
  retainedRawData = null
  retainedRawRevision = 0
  bumpLiveRawRevision()
  resetFrameState()
}

const updateLiveRawMeta = (meta: Partial<HorizontalBrowseDetailLiveCanvasRawMeta>) => {
  if (!liveRawData) return
  let changed = false
  if (typeof meta.duration === 'number' && meta.duration > 0) {
    changed = changed || liveRawData.duration !== meta.duration
    liveRawData.duration = meta.duration
  }
  if (typeof meta.startSec === 'number') {
    changed = changed || Math.abs((liveRawData.startSec ?? 0) - meta.startSec) > 0.0001
    liveRawData.startSec = Math.max(0, meta.startSec)
  }
  if (typeof meta.frames === 'number' && meta.frames > 0) {
    const nextFrames = Math.min(Math.floor(meta.frames), liveRawData.minLeft.length)
    changed = changed || liveRawData.frames !== nextFrames
    liveRawData.frames = nextFrames
  }
  if (typeof meta.loadedFrames === 'number') {
    const nextLoadedFrames = Math.min(
      Math.floor(meta.loadedFrames),
      liveRawData.frames,
      liveRawData.minLeft.length
    )
    changed = changed || liveRawData.loadedFrames !== nextLoadedFrames
    liveRawData.loadedFrames = nextLoadedFrames
  }
  if (changed) {
    bumpLiveRawRevision()
  }
}

const applyLiveRawChunk = (
  payload: Extract<
    HorizontalBrowseDetailLiveCanvasWorkerIncoming,
    { type: 'applyRawChunk' }
  >['payload']
) => {
  ensureLiveRawCapacity(
    {
      duration: payload.duration,
      sampleRate: payload.sampleRate,
      rate: payload.rate,
      frames: payload.frames,
      startSec: payload.startSec,
      loadedFrames: payload.loadedFrames
    },
    true
  )
  if (!liveRawData) return

  const startFrame = Math.max(0, Math.floor(Number(payload.startFrame) || 0))
  const chunkFrames = Math.max(0, Math.floor(Number(payload.chunkFrames) || 0))
  const copyFrames = Math.min(
    chunkFrames,
    payload.minLeft.length,
    payload.maxLeft.length,
    payload.minRight.length,
    payload.maxRight.length,
    Math.max(0, liveRawData.minLeft.length - startFrame)
  )
  if (!copyFrames) return

  liveRawData.minLeft.set(payload.minLeft.subarray(0, copyFrames), startFrame)
  liveRawData.maxLeft.set(payload.maxLeft.subarray(0, copyFrames), startFrame)
  liveRawData.minRight.set(payload.minRight.subarray(0, copyFrames), startFrame)
  liveRawData.maxRight.set(payload.maxRight.subarray(0, copyFrames), startFrame)
  liveRawData.loadedFrames = Math.max(
    Number(liveRawData.loadedFrames) || 0,
    Math.min(liveRawData.frames, startFrame + copyFrames, Math.floor(payload.loadedFrames || 0))
  )
  bumpLiveRawRevision()
}

const resolveRawForRender = (request: HorizontalBrowseDetailLiveCanvasRenderRequest) => {
  if (request.rawSlot === 'live') return liveRawData
  if (request.rawSlot === 'retained') return retainedRawData
  return null
}

const resolveRawRevisionForRender = (rawData: RawWaveformData | null) => {
  if (rawData && rawData === liveRawData) return liveRawRevision
  if (rawData && rawData === retainedRawData) return retainedRawRevision
  return 0
}

const buildFrameState = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  metrics: CanvasMetrics,
  rawData: RawWaveformData | null
): FrameState => ({
  width: metrics.cssWidth,
  height: metrics.cssHeight,
  bpm: Number(request.bpm) || 0,
  firstBeatMs: Number(request.firstBeatMs) || 0,
  barBeatOffset: Number(request.barBeatOffset) || 0,
  timeBasisOffsetMs: Number(request.timeBasisOffsetMs) || 0,
  rangeStartSec: Number.isFinite(request.rangeStartSec) ? request.rangeStartSec : 0,
  rangeDurationSec: Math.max(0.0001, Number(request.rangeDurationSec) || 0.0001),
  rawData,
  rawRevision: resolveRawRevisionForRender(rawData),
  maxSamplesPerPixel: request.maxSamplesPerPixel,
  showDetailHighlights: request.showDetailHighlights,
  showCenterLine: request.showCenterLine,
  showBackground: request.showBackground,
  showBeatGrid: false,
  waveformLayout: request.waveformLayout,
  preferRawPeaksOnly: request.preferRawPeaksOnly,
  themeVariant: request.themeVariant
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
  drawBeatAlignRekordboxWaveform(targetCtx, {
    width,
    height,
    bpm: state.bpm,
    firstBeatMs: state.firstBeatMs,
    barBeatOffset: state.barBeatOffset,
    timeBasisOffsetMs: state.timeBasisOffsetMs,
    rangeStartSec,
    rangeDurationSec,
    mixxxData: createMixxxData(state.rawData),
    rawData: state.rawData,
    showBackground: state.showBackground,
    showBeatGrid: state.showBeatGrid,
    maxSamplesPerPixel: state.maxSamplesPerPixel,
    showDetailHighlights: state.showDetailHighlights,
    showCenterLine: state.showCenterLine,
    waveformLayout: state.waveformLayout,
    preferRawPeaksOnly: state.preferRawPeaksOnly,
    themeVariant: state.themeVariant
  })

const drawSegment = (
  targetCtx: OffscreenCanvasRenderingContext2D,
  metrics: CanvasMetrics,
  state: FrameState,
  segmentX: number,
  segmentWidth: number
) => {
  const safeSegmentX = clampNumber(Math.floor(segmentX), 0, Math.max(0, metrics.cssWidth - 1))
  const safeSegmentWidth = clampNumber(
    Math.ceil(segmentWidth),
    1,
    Math.max(1, metrics.cssWidth - safeSegmentX)
  )
  const scaledSegmentWidth = Math.max(1, Math.ceil(safeSegmentWidth * metrics.scaleX))
  const segment = ensureSegmentScratch(scaledSegmentWidth, metrics.scaledHeight)
  if (!segment) return false

  const segmentStartSec =
    state.rangeStartSec + (safeSegmentX / metrics.cssWidth) * state.rangeDurationSec
  const segmentDurationSec = (safeSegmentWidth / metrics.cssWidth) * state.rangeDurationSec

  applyCanvasScaleTransform(segment.ctx, metrics.scaleX, metrics.scaleY)
  segment.ctx.clearRect(0, 0, safeSegmentWidth, metrics.cssHeight)
  const rendered = drawRange(
    segment.ctx,
    safeSegmentWidth,
    metrics.cssHeight,
    segmentStartSec,
    segmentDurationSec,
    state
  )
  targetCtx.clearRect(safeSegmentX, 0, safeSegmentWidth, metrics.cssHeight)
  if (!rendered || !segment.canvas) return false

  targetCtx.drawImage(
    segment.canvas,
    0,
    0,
    scaledSegmentWidth,
    metrics.scaledHeight,
    safeSegmentX,
    0,
    safeSegmentWidth,
    metrics.cssHeight
  )
  return true
}

const canReusePreviousFrame = (
  current: FrameState,
  metrics: CanvasMetrics,
  ignoreFirstBeatMs = false
) => {
  if (metrics.resized || !lastFrame) return false
  return (
    lastFrame.width === current.width &&
    lastFrame.height === current.height &&
    lastFrame.bpm === current.bpm &&
    (ignoreFirstBeatMs || lastFrame.firstBeatMs === current.firstBeatMs) &&
    lastFrame.barBeatOffset === current.barBeatOffset &&
    lastFrame.timeBasisOffsetMs === current.timeBasisOffsetMs &&
    lastFrame.rangeDurationSec === current.rangeDurationSec &&
    lastFrame.rawData === current.rawData &&
    lastFrame.rawRevision === current.rawRevision &&
    lastFrame.showDetailHighlights === current.showDetailHighlights &&
    lastFrame.showCenterLine === current.showCenterLine &&
    lastFrame.showBackground === current.showBackground &&
    lastFrame.showBeatGrid === current.showBeatGrid &&
    lastFrame.waveformLayout === current.waveformLayout &&
    lastFrame.preferRawPeaksOnly === current.preferRawPeaksOnly &&
    lastFrame.themeVariant === current.themeVariant
  )
}

const canReuseDirtySegment = (current: FrameState, metrics: CanvasMetrics) => {
  if (metrics.resized || !lastFrame) return false
  return (
    lastFrame.width === current.width &&
    lastFrame.height === current.height &&
    lastFrame.bpm === current.bpm &&
    lastFrame.firstBeatMs === current.firstBeatMs &&
    lastFrame.barBeatOffset === current.barBeatOffset &&
    lastFrame.timeBasisOffsetMs === current.timeBasisOffsetMs &&
    lastFrame.rangeStartSec === current.rangeStartSec &&
    lastFrame.rangeDurationSec === current.rangeDurationSec &&
    lastFrame.rawData === current.rawData &&
    lastFrame.rawRevision === current.rawRevision &&
    lastFrame.showDetailHighlights === current.showDetailHighlights &&
    lastFrame.showCenterLine === current.showCenterLine &&
    lastFrame.showBackground === current.showBackground &&
    lastFrame.showBeatGrid === current.showBeatGrid &&
    lastFrame.waveformLayout === current.waveformLayout &&
    lastFrame.preferRawPeaksOnly === current.preferRawPeaksOnly &&
    lastFrame.themeVariant === current.themeVariant
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

const renderFullFrame = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  metrics: CanvasMetrics,
  state: FrameState
) => {
  if (!ctx) return false
  const phaseAwareScrollReuse = request.phaseAwareScrollReuse === true
  const resolvePhaseShiftSec = (previous: FrameState) =>
    phaseAwareScrollReuse ? (state.firstBeatMs - previous.firstBeatMs) / 1000 : 0
  lastWaveformScrollShiftScaledPx = null

  if (
    request.allowScrollReuse !== false &&
    canReusePreviousFrame(state, metrics, phaseAwareScrollReuse) &&
    lastFrame &&
    Math.abs(state.rangeStartSec - lastFrame.rangeStartSec - resolvePhaseShiftSec(lastFrame)) <=
      0.000001
  ) {
    state.rangeStartSec = lastFrame.rangeStartSec + resolvePhaseShiftSec(lastFrame)
    lastWaveformRenderMode = 'unchanged'
    if (state.rawData && state.rawData === liveRawData) {
      retainedRawData = liveRawData
      retainedRawRevision = liveRawRevision
    }
    lastFrame = state
    return true
  }

  let reused = false
  if (
    request.allowScrollReuse !== false &&
    canReusePreviousFrame(state, metrics, phaseAwareScrollReuse) &&
    lastFrame
  ) {
    const phaseShiftSec = resolvePhaseShiftSec(lastFrame)
    const requestedShiftScaledPx =
      ((state.rangeStartSec - lastFrame.rangeStartSec - phaseShiftSec) / state.rangeDurationSec) *
      metrics.scaledWidth
    const shiftScaledPx = Math.round(requestedShiftScaledPx)
    const absShiftScaledPx = Math.abs(shiftScaledPx)
    if (absShiftScaledPx === 0) {
      state.rangeStartSec = lastFrame.rangeStartSec + phaseShiftSec
      lastWaveformScrollShiftScaledPx = 0
      lastWaveformRenderMode = 'scroll-reuse'
      reused = true
    } else if (absShiftScaledPx < metrics.scaledWidth) {
      state.rangeStartSec =
        lastFrame.rangeStartSec +
        phaseShiftSec +
        (shiftScaledPx / metrics.scaledWidth) * state.rangeDurationSec
      const scratch = ensureScrollScratch(metrics.scaledWidth, metrics.scaledHeight)
      if (scratch) {
        scratch.ctx.setTransform(1, 0, 0, 1, 0, 0)
        scratch.ctx.imageSmoothingEnabled = false
        scratch.ctx.clearRect(0, 0, metrics.scaledWidth, metrics.scaledHeight)
        if (canvas) {
          scratch.ctx.drawImage(canvas, 0, 0)
        }

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

        applyCanvasScaleTransform(ctx, metrics.scaleX, metrics.scaleY)
        const absShiftCssPx = absShiftScaledPx / metrics.scaleX
        if (shiftScaledPx > 0) {
          const keepCssWidth = Math.max(0, metrics.cssWidth - absShiftCssPx)
          const segmentX = Math.max(0, Math.floor(keepCssWidth) - 2)
          const segmentWidth = Math.max(1, metrics.cssWidth - segmentX)
          reused = drawSegment(ctx, metrics, state, segmentX, segmentWidth)
        } else {
          const segmentWidth = Math.max(1, Math.min(metrics.cssWidth, Math.ceil(absShiftCssPx) + 2))
          reused = drawSegment(ctx, metrics, state, 0, segmentWidth)
        }
        if (reused) {
          lastWaveformScrollShiftScaledPx = shiftScaledPx
          lastWaveformRenderMode = 'scroll-reuse'
        }
      }
    }
  }

  if (!reused) {
    ctx.clearRect(0, 0, metrics.cssWidth, metrics.cssHeight)
    reused = drawRange(
      ctx,
      metrics.cssWidth,
      metrics.cssHeight,
      state.rangeStartSec,
      state.rangeDurationSec,
      state
    )
    if (reused) {
      lastWaveformRenderMode = 'full'
    }
  }

  if (!reused) {
    lastWaveformRenderMode = 'failed'
    resetFrameState()
    return false
  }

  if (state.rawData && state.rawData === liveRawData) {
    retainedRawData = liveRawData
    retainedRawRevision = liveRawRevision
  }
  lastFrame = state
  return true
}

const renderDirtyRange = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  metrics: CanvasMetrics,
  state: FrameState
) => {
  if (!ctx) return false
  lastWaveformScrollShiftScaledPx = null
  if (!canReuseDirtySegment(state, metrics)) {
    return renderFullFrame(request, metrics, state)
  }

  const dirtyStartSec = Number(request.dirtyStartSec)
  const dirtyEndSec = Number(request.dirtyEndSec)
  if (!Number.isFinite(dirtyStartSec) || !Number.isFinite(dirtyEndSec)) {
    return renderFullFrame(request, metrics, state)
  }

  const viewStartSec = state.rangeStartSec
  const viewEndSec = state.rangeStartSec + state.rangeDurationSec
  const clampedStartSec = clampNumber(dirtyStartSec, viewStartSec, viewEndSec)
  const clampedEndSec = clampNumber(dirtyEndSec, clampedStartSec, viewEndSec)
  if (clampedEndSec <= clampedStartSec) {
    lastWaveformRenderMode = 'dirty-empty'
    lastFrame = state
    return true
  }

  const pxPerSec = metrics.cssWidth / Math.max(0.0001, state.rangeDurationSec)
  const paddingPx = 2
  const dirtyStartPx =
    ((clampedStartSec - viewStartSec) / Math.max(0.0001, state.rangeDurationSec)) * metrics.cssWidth
  const dirtyEndPx =
    ((clampedEndSec - viewStartSec) / Math.max(0.0001, state.rangeDurationSec)) * metrics.cssWidth
  const segmentX = Math.max(0, Math.floor(dirtyStartPx - paddingPx))
  const segmentEndX = Math.min(
    metrics.cssWidth,
    Math.ceil(dirtyEndPx + paddingPx + Math.max(1, pxPerSec))
  )
  const segmentWidth = Math.max(1, segmentEndX - segmentX)
  const rendered = drawSegment(ctx, metrics, state, segmentX, segmentWidth)
  if (rendered) {
    lastWaveformRenderMode = 'dirty-segment'
    if (state.rawData && state.rawData === liveRawData) {
      retainedRawData = liveRawData
      retainedRawRevision = liveRawRevision
    }
    lastFrame = state
  } else {
    lastWaveformRenderMode = 'dirty-failed'
  }
  return rendered
}

const renderTimelineFallback = () => {
  if (!ctx) return
  clearWaveformPixels()
  lastWaveformRenderMode = 'timeline-only'
}

const processRender = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  notifyMain = true
) => {
  const metrics = ensureCanvasMetrics(request)
  const rawData = resolveRawForRender(request)
  const state = metrics ? buildFrameState(request, metrics, rawData) : null
  const renderState = state as FrameState | null
  const ready =
    !!metrics &&
    !!rawData &&
    (typeof request.dirtyStartSec === 'number' || typeof request.dirtyEndSec === 'number'
      ? renderDirtyRange(request, metrics, renderState as FrameState)
      : renderFullFrame(request, metrics, renderState as FrameState))

  if (metrics && renderState && !ready) {
    renderTimelineFallback()
  }

  if (
    metrics &&
    renderState &&
    !overlayRenderer.render(
      request,
      renderState.rangeStartSec,
      renderState.rangeDurationSec,
      lastWaveformScrollShiftScaledPx
    )
  ) {
    overlayRenderer.clear()
  }

  if (notifyMain) {
    postToMain({
      type: 'rendered',
      payload: {
        renderToken: request.renderToken,
        rangeStartSec: renderState?.rangeStartSec ?? request.rangeStartSec,
        rangeDurationSec: renderState?.rangeDurationSec ?? request.rangeDurationSec,
        ready
      }
    })
  }
}

const buildPlaybackRenderRequest = (
  animation: PlaybackAnimationState
): HorizontalBrowseDetailLiveCanvasRenderRequest => {
  const playbackSeconds = resolvePlaybackSeconds(
    animation.request,
    animation.baseSeconds,
    animation.startedAtMs
  )
  return {
    ...animation.request,
    playbackSeconds,
    allowScrollReuse: true,
    phaseAwareScrollReuse: true,
    rangeStartSec: resolvePlaybackRangeStartSec(animation.request, playbackSeconds),
    dirtyStartSec: undefined,
    dirtyEndSec: undefined
  }
}

const schedulePlaybackRender = (token: number) => {
  clearPlaybackFrameSchedule()
  const renderFrame = () => {
    playbackRaf = 0
    playbackTimer = null
    const animation = playbackAnimation
    if (!animation || animation.token !== token || token !== playbackAnimationToken) return
    processRender(buildPlaybackRenderRequest(animation), false)
    if (playbackAnimation?.token === token && token === playbackAnimationToken) {
      schedulePlaybackRender(token)
    }
  }
  const scope = resolveWorkerAnimationFrameScope()
  if (typeof scope.requestAnimationFrame === 'function') {
    playbackRaf = scope.requestAnimationFrame(renderFrame)
    return
  }
  playbackTimer = setTimeout(renderFrame, PLAYBACK_RENDER_INTERVAL_MS)
}

const activatePlaybackAnimation = (request: HorizontalBrowseDetailLiveCanvasRenderRequest) => {
  const current = playbackAnimation
  const token = current?.token ?? playbackAnimationToken + 1
  const nowMs = performance.now()
  const incomingSeconds = Math.max(0, Number(request.playbackSeconds) || 0)
  const forceIncomingSeconds =
    current &&
    Math.floor(Number(request.playbackSyncRevision) || 0) !==
      Math.floor(Number(current.request.playbackSyncRevision) || 0)
  const baseSeconds = current
    ? (() => {
        if (forceIncomingSeconds) {
          return incomingSeconds
        }
        const predictedSeconds = resolvePlaybackSeconds(
          current.request,
          current.baseSeconds,
          current.startedAtMs,
          nowMs
        )
        return Math.abs(predictedSeconds - incomingSeconds) <= PLAYBACK_SYNC_TOLERANCE_SEC
          ? predictedSeconds
          : incomingSeconds
      })()
    : incomingSeconds
  if (!current) {
    playbackAnimationToken = token
  }
  playbackAnimation = {
    token,
    request,
    baseSeconds,
    startedAtMs: nowMs
  }
  processRender(buildPlaybackRenderRequest(playbackAnimation))
  if (playbackAnimation?.token === token && !playbackTimer) {
    schedulePlaybackRender(token)
  }
}

const processRenderRequest = (request: HorizontalBrowseDetailLiveCanvasRenderRequest) => {
  const shouldAnimatePlayback =
    request.playbackActive === true &&
    typeof request.dirtyStartSec !== 'number' &&
    typeof request.dirtyEndSec !== 'number'

  if (shouldAnimatePlayback) {
    activatePlaybackAnimation(request)
    return
  }

  stopPlaybackAnimation()
  processRender(request)
}

const scheduleRender = (request: HorizontalBrowseDetailLiveCanvasRenderRequest) => {
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
    liveRawData = null
    retainedRawData = null
    liveRawRevision = 0
    retainedRawRevision = 0
    clearCanvasPixels()
    return
  }

  if (message.type === 'resetRaw') {
    ensureLiveRawCapacity(message.payload, message.payload.retainCurrent === true)
    return
  }

  if (message.type === 'ensureRawCapacity') {
    ensureLiveRawCapacity(message.payload)
    return
  }

  if (message.type === 'applyRawChunk') {
    applyLiveRawChunk(message.payload)
    return
  }

  if (message.type === 'replaceRaw') {
    replaceLiveRawData(message.payload.data)
    return
  }

  if (message.type === 'updateRawMeta') {
    updateLiveRawMeta(message.payload)
    return
  }

  if (message.type === 'render') {
    scheduleRender(message.payload)
  }
}
