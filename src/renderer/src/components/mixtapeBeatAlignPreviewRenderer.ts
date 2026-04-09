import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import { drawBeatAlignRekordboxWaveform } from '@renderer/components/mixtapeBeatAlignWaveform'
import { resolveCanvasScaleMetrics } from '@renderer/utils/canvasScale'

type BeatAlignPreviewRenderInput = {
  canvas: HTMLCanvasElement
  wrap: HTMLDivElement
  bpm: number
  firstBeatMs: number
  barBeatOffset: number
  rangeStartSec: number
  rangeDurationSec: number
  mixxxData: MixxxWaveformData | null
  rawData: RawWaveformData | null
  maxSamplesPerPixel: number
  showDetailHighlights: boolean
  showCenterLine: boolean
  showBackground?: boolean
  showBeatGrid?: boolean
  allowScrollReuse?: boolean
  waveformLayout?: 'full' | 'top-half' | 'bottom-half'
  preferRawPeaksOnly?: boolean
}

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
  rangeStartSec: number
  rangeDurationSec: number
  mixxxData: MixxxWaveformData | null
  rawData: RawWaveformData | null
  maxSamplesPerPixel: number
  showDetailHighlights: boolean
  showCenterLine: boolean
  showBackground: boolean
  showBeatGrid: boolean
  waveformLayout: 'full' | 'top-half' | 'bottom-half'
  preferRawPeaksOnly: boolean
}

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const applyCanvasScaleTransform = (
  ctx: CanvasRenderingContext2D,
  scaleX: number,
  scaleY: number
) => {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0)
}

const ensureCanvasMetrics = (
  canvas: HTMLCanvasElement,
  wrap: HTMLDivElement,
  ctx: CanvasRenderingContext2D
): CanvasMetrics => {
  const cssWidth = Math.max(1, Math.floor(wrap.clientWidth))
  const cssHeight = Math.max(1, Math.floor(wrap.clientHeight))
  const previousWidth = canvas.width
  const previousHeight = canvas.height
  const metrics = resolveCanvasScaleMetrics(cssWidth, cssHeight, window.devicePixelRatio || 1)
  const scaledWidth = metrics.scaledWidth
  const scaledHeight = metrics.scaledHeight
  if (previousWidth !== scaledWidth) {
    canvas.width = scaledWidth
  }
  if (previousHeight !== scaledHeight) {
    canvas.height = scaledHeight
  }
  applyCanvasScaleTransform(ctx, metrics.scaleX, metrics.scaleY)
  return {
    cssWidth,
    cssHeight,
    pixelRatio: metrics.pixelRatio,
    scaledWidth,
    scaledHeight,
    scaleX: metrics.scaleX,
    scaleY: metrics.scaleY,
    resized: previousWidth !== scaledWidth || previousHeight !== scaledHeight
  }
}

const buildFrameState = (
  input: BeatAlignPreviewRenderInput,
  metrics: CanvasMetrics
): FrameState => ({
  width: metrics.cssWidth,
  height: metrics.cssHeight,
  bpm: Number(input.bpm) || 0,
  firstBeatMs: Number(input.firstBeatMs) || 0,
  barBeatOffset: Number(input.barBeatOffset) || 0,
  rangeStartSec: Number.isFinite(input.rangeStartSec) ? input.rangeStartSec : 0,
  rangeDurationSec: Math.max(0.0001, Number(input.rangeDurationSec) || 0.0001),
  mixxxData: input.mixxxData,
  rawData: input.rawData,
  maxSamplesPerPixel: input.maxSamplesPerPixel,
  showDetailHighlights: input.showDetailHighlights,
  showCenterLine: input.showCenterLine,
  showBackground: input.showBackground !== false,
  showBeatGrid: input.showBeatGrid !== false,
  waveformLayout: input.waveformLayout || 'full',
  preferRawPeaksOnly: input.preferRawPeaksOnly === true
})

export const createBeatAlignPreviewRenderer = () => {
  let lastFrame: FrameState | null = null
  let scrollScratchCanvas: HTMLCanvasElement | null = null
  let scrollScratchCtx: CanvasRenderingContext2D | null = null
  let segmentCanvas: HTMLCanvasElement | null = null
  let segmentCtx: CanvasRenderingContext2D | null = null

  const ensureScrollScratch = (scaledWidth: number, scaledHeight: number) => {
    if (!scrollScratchCanvas) {
      scrollScratchCanvas = document.createElement('canvas')
      scrollScratchCtx = scrollScratchCanvas.getContext('2d')
    }
    if (!scrollScratchCanvas || !scrollScratchCtx) return null
    if (scrollScratchCanvas.width !== scaledWidth || scrollScratchCanvas.height !== scaledHeight) {
      scrollScratchCanvas.width = scaledWidth
      scrollScratchCanvas.height = scaledHeight
    }
    return {
      canvas: scrollScratchCanvas,
      ctx: scrollScratchCtx
    }
  }

  const ensureSegmentCanvas = (scaledWidth: number, scaledHeight: number) => {
    if (!segmentCanvas) {
      segmentCanvas = document.createElement('canvas')
      segmentCtx = segmentCanvas.getContext('2d')
    }
    if (!segmentCanvas || !segmentCtx) return null
    if (segmentCanvas.width !== scaledWidth || segmentCanvas.height !== scaledHeight) {
      segmentCanvas.width = scaledWidth
      segmentCanvas.height = scaledHeight
    }
    return {
      canvas: segmentCanvas,
      ctx: segmentCtx
    }
  }

  const drawRange = (
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    rangeStartSec: number,
    rangeDurationSec: number,
    input: BeatAlignPreviewRenderInput
  ) => {
    drawBeatAlignRekordboxWaveform(ctx, {
      width,
      height,
      bpm: input.bpm,
      firstBeatMs: input.firstBeatMs,
      barBeatOffset: input.barBeatOffset,
      rangeStartSec,
      rangeDurationSec,
      mixxxData: input.mixxxData,
      rawData: input.rawData,
      showBackground: input.showBackground !== false,
      showBeatGrid: input.showBeatGrid !== false,
      maxSamplesPerPixel: input.maxSamplesPerPixel,
      showDetailHighlights: input.showDetailHighlights,
      showCenterLine: input.showCenterLine,
      waveformLayout: input.waveformLayout || 'full',
      preferRawPeaksOnly: input.preferRawPeaksOnly === true
    })
  }

  const drawSegment = (
    ctx: CanvasRenderingContext2D,
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
    const segment = ensureSegmentCanvas(scaledSegmentWidth, metrics.scaledHeight)
    if (!segment) return

    const segmentStartSec =
      state.rangeStartSec + (safeSegmentX / metrics.cssWidth) * state.rangeDurationSec
    const segmentDurationSec = (safeSegmentWidth / metrics.cssWidth) * state.rangeDurationSec

    applyCanvasScaleTransform(segment.ctx, metrics.scaleX, metrics.scaleY)
    segment.ctx.clearRect(0, 0, safeSegmentWidth, metrics.cssHeight)
    drawBeatAlignRekordboxWaveform(segment.ctx, {
      width: safeSegmentWidth,
      height: metrics.cssHeight,
      bpm: state.bpm,
      firstBeatMs: state.firstBeatMs,
      barBeatOffset: state.barBeatOffset,
      rangeStartSec: segmentStartSec,
      rangeDurationSec: segmentDurationSec,
      mixxxData: state.mixxxData,
      rawData: state.rawData,
      showBackground: state.showBackground,
      showBeatGrid: state.showBeatGrid,
      maxSamplesPerPixel: state.maxSamplesPerPixel,
      showDetailHighlights: state.showDetailHighlights,
      showCenterLine: state.showCenterLine,
      waveformLayout: state.waveformLayout,
      preferRawPeaksOnly: state.preferRawPeaksOnly
    })
    ctx.drawImage(
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
  }

  const canReusePreviousFrame = (current: FrameState, metrics: CanvasMetrics) => {
    if (metrics.resized || !lastFrame) return false
    return (
      lastFrame.width === current.width &&
      lastFrame.height === current.height &&
      lastFrame.bpm === current.bpm &&
      lastFrame.firstBeatMs === current.firstBeatMs &&
      lastFrame.barBeatOffset === current.barBeatOffset &&
      lastFrame.rangeDurationSec === current.rangeDurationSec &&
      lastFrame.mixxxData === current.mixxxData &&
      lastFrame.rawData === current.rawData &&
      lastFrame.maxSamplesPerPixel === current.maxSamplesPerPixel &&
      lastFrame.showDetailHighlights === current.showDetailHighlights &&
      lastFrame.showCenterLine === current.showCenterLine &&
      lastFrame.showBackground === current.showBackground &&
      lastFrame.showBeatGrid === current.showBeatGrid &&
      lastFrame.waveformLayout === current.waveformLayout
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
      lastFrame.rangeStartSec === current.rangeStartSec &&
      lastFrame.rangeDurationSec === current.rangeDurationSec &&
      lastFrame.mixxxData === current.mixxxData &&
      lastFrame.rawData === current.rawData &&
      lastFrame.maxSamplesPerPixel === current.maxSamplesPerPixel &&
      lastFrame.showDetailHighlights === current.showDetailHighlights &&
      lastFrame.showCenterLine === current.showCenterLine &&
      lastFrame.showBackground === current.showBackground &&
      lastFrame.showBeatGrid === current.showBeatGrid &&
      lastFrame.waveformLayout === current.waveformLayout &&
      lastFrame.preferRawPeaksOnly === current.preferRawPeaksOnly
    )
  }

  const draw = (input: BeatAlignPreviewRenderInput) => {
    const ctx = input.canvas.getContext('2d')
    if (!ctx) return

    const metrics = ensureCanvasMetrics(input.canvas, input.wrap, ctx)
    const state = buildFrameState(input, metrics)

    let reused = false
    if (input.allowScrollReuse !== false && canReusePreviousFrame(state, metrics) && lastFrame) {
      const shiftScaledPx = Math.round(
        ((state.rangeStartSec - lastFrame.rangeStartSec) / state.rangeDurationSec) *
          metrics.scaledWidth
      )
      const absShiftScaledPx = Math.abs(shiftScaledPx)
      if (absShiftScaledPx >= 1 && absShiftScaledPx < metrics.scaledWidth) {
        const scratch = ensureScrollScratch(metrics.scaledWidth, metrics.scaledHeight)
        if (scratch) {
          scratch.ctx.setTransform(1, 0, 0, 1, 0, 0)
          scratch.ctx.imageSmoothingEnabled = false
          scratch.ctx.clearRect(0, 0, metrics.scaledWidth, metrics.scaledHeight)
          scratch.ctx.drawImage(input.canvas, 0, 0)

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
            const segmentX = Math.max(0, Math.floor(keepCssWidth) - 1)
            const segmentWidth = Math.max(1, metrics.cssWidth - segmentX)
            drawSegment(ctx, metrics, state, segmentX, segmentWidth)
          } else {
            const segmentWidth = Math.max(
              1,
              Math.min(metrics.cssWidth, Math.ceil(absShiftCssPx) + 1)
            )
            drawSegment(ctx, metrics, state, 0, segmentWidth)
          }
          reused = true
        }
      }
    }

    if (!reused) {
      ctx.clearRect(0, 0, metrics.cssWidth, metrics.cssHeight)
      drawRange(
        ctx,
        metrics.cssWidth,
        metrics.cssHeight,
        state.rangeStartSec,
        state.rangeDurationSec,
        input
      )
    }

    lastFrame = state
  }

  const drawDirtyRange = (
    input: BeatAlignPreviewRenderInput,
    dirtyStartSec: number,
    dirtyEndSec: number
  ) => {
    const ctx = input.canvas.getContext('2d')
    if (!ctx) return

    const metrics = ensureCanvasMetrics(input.canvas, input.wrap, ctx)
    const state = buildFrameState(input, metrics)
    if (!canReuseDirtySegment(state, metrics)) {
      draw(input)
      return
    }

    const viewStartSec = state.rangeStartSec
    const viewEndSec = state.rangeStartSec + state.rangeDurationSec
    const clampedStartSec = clampNumber(dirtyStartSec, viewStartSec, viewEndSec)
    const clampedEndSec = clampNumber(dirtyEndSec, clampedStartSec, viewEndSec)
    if (clampedEndSec <= clampedStartSec) {
      lastFrame = state
      return
    }

    const pxPerSec = metrics.cssWidth / Math.max(0.0001, state.rangeDurationSec)
    const paddingPx = 2
    const dirtyStartPx =
      ((clampedStartSec - viewStartSec) / Math.max(0.0001, state.rangeDurationSec)) *
      metrics.cssWidth
    const dirtyEndPx =
      ((clampedEndSec - viewStartSec) / Math.max(0.0001, state.rangeDurationSec)) * metrics.cssWidth
    const segmentX = Math.max(0, Math.floor(dirtyStartPx - paddingPx))
    const segmentEndX = Math.min(
      metrics.cssWidth,
      Math.ceil(dirtyEndPx + paddingPx + Math.max(1, pxPerSec))
    )
    const segmentWidth = Math.max(1, segmentEndX - segmentX)
    drawSegment(ctx, metrics, state, segmentX, segmentWidth)
    lastFrame = state
  }

  const reset = () => {
    lastFrame = null
  }

  const dispose = () => {
    lastFrame = null
    scrollScratchCanvas = null
    scrollScratchCtx = null
    segmentCanvas = null
    segmentCtx = null
  }

  return {
    draw,
    drawDirtyRange,
    reset,
    dispose
  }
}
