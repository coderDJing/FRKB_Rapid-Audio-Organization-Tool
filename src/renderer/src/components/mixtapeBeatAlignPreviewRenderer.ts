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
  waveformLayout?: 'full' | 'top-half' | 'bottom-half'
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
}

const SCROLL_SHIFT_EPSILON_PX = 0.05

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

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
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.setTransform(metrics.scaleX, 0, 0, metrics.scaleY, 0, 0)
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
      waveformLayout: input.waveformLayout || 'full'
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

    segment.ctx.setTransform(metrics.scaleX, 0, 0, metrics.scaleY, 0, 0)
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
      waveformLayout: state.waveformLayout
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

  const draw = (input: BeatAlignPreviewRenderInput) => {
    const ctx = input.canvas.getContext('2d')
    if (!ctx) return

    const metrics = ensureCanvasMetrics(input.canvas, input.wrap, ctx)
    const rangeStartSec = Number.isFinite(input.rangeStartSec) ? input.rangeStartSec : 0
    const rangeDurationSec = Math.max(0.0001, Number(input.rangeDurationSec) || 0.0001)
    const state: FrameState = {
      width: metrics.cssWidth,
      height: metrics.cssHeight,
      bpm: Number(input.bpm) || 0,
      firstBeatMs: Number(input.firstBeatMs) || 0,
      barBeatOffset: Number(input.barBeatOffset) || 0,
      rangeStartSec,
      rangeDurationSec,
      mixxxData: input.mixxxData,
      rawData: input.rawData,
      maxSamplesPerPixel: input.maxSamplesPerPixel,
      showDetailHighlights: input.showDetailHighlights,
      showCenterLine: input.showCenterLine,
      showBackground: input.showBackground !== false,
      showBeatGrid: input.showBeatGrid !== false,
      waveformLayout: input.waveformLayout || 'full'
    }

    let reused = false
    if (canReusePreviousFrame(state, metrics) && lastFrame) {
      const shiftPx =
        ((state.rangeStartSec - lastFrame.rangeStartSec) / state.rangeDurationSec) *
        metrics.cssWidth
      const absShiftPx = Math.abs(shiftPx)
      if (absShiftPx >= SCROLL_SHIFT_EPSILON_PX && absShiftPx < metrics.cssWidth - 0.5) {
        const scratch = ensureScrollScratch(metrics.scaledWidth, metrics.scaledHeight)
        if (scratch) {
          scratch.ctx.setTransform(1, 0, 0, 1, 0, 0)
          scratch.ctx.clearRect(0, 0, metrics.scaledWidth, metrics.scaledHeight)
          scratch.ctx.drawImage(input.canvas, 0, 0)

          ctx.clearRect(0, 0, metrics.cssWidth, metrics.cssHeight)

          const keepWidth = Math.max(0, metrics.cssWidth - absShiftPx)
          if (keepWidth > 0) {
            if (shiftPx > 0) {
              ctx.drawImage(
                scratch.canvas,
                absShiftPx * metrics.scaleX,
                0,
                keepWidth * metrics.scaleX,
                metrics.scaledHeight,
                0,
                0,
                keepWidth,
                metrics.cssHeight
              )
            } else {
              ctx.drawImage(
                scratch.canvas,
                0,
                0,
                keepWidth * metrics.scaleX,
                metrics.scaledHeight,
                absShiftPx,
                0,
                keepWidth,
                metrics.cssHeight
              )
            }
          }

          if (shiftPx > 0) {
            const segmentX = Math.max(0, Math.floor(keepWidth) - 1)
            const segmentWidth = Math.max(1, metrics.cssWidth - segmentX)
            drawSegment(ctx, metrics, state, segmentX, segmentWidth)
          } else {
            const segmentWidth = Math.max(1, Math.min(metrics.cssWidth, Math.ceil(absShiftPx) + 1))
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
    reset,
    dispose
  }
}
