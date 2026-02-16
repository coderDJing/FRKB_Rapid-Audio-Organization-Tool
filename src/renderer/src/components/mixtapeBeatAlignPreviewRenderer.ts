import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import { drawBeatAlignRekordboxWaveform } from '@renderer/components/mixtapeBeatAlignWaveform'

type BeatAlignPreviewRenderInput = {
  canvas: HTMLCanvasElement
  wrap: HTMLDivElement
  bpm: number
  firstBeatMs: number
  barBeatOffset: number
  rangeStartSec: number
  rangeDurationSec: number
  mixxxData: MixxxWaveformData | null
  maxSamplesPerPixel: number
  showDetailHighlights: boolean
  showCenterLine: boolean
}

type CanvasMetrics = {
  cssWidth: number
  cssHeight: number
  pixelRatio: number
  scaledWidth: number
  scaledHeight: number
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
  maxSamplesPerPixel: number
  showDetailHighlights: boolean
  showCenterLine: boolean
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
  const pixelRatio = window.devicePixelRatio || 1
  const scaledWidth = Math.max(1, Math.floor(cssWidth * pixelRatio))
  const scaledHeight = Math.max(1, Math.floor(cssHeight * pixelRatio))
  const resized = canvas.width !== scaledWidth || canvas.height !== scaledHeight
  if (resized) {
    canvas.width = scaledWidth
    canvas.height = scaledHeight
  }
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
  return {
    cssWidth,
    cssHeight,
    pixelRatio,
    scaledWidth,
    scaledHeight,
    resized
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
      showBackground: false,
      maxSamplesPerPixel: input.maxSamplesPerPixel,
      showDetailHighlights: input.showDetailHighlights,
      showCenterLine: input.showCenterLine
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
    const scaledSegmentWidth = Math.max(1, Math.ceil(safeSegmentWidth * metrics.pixelRatio))
    const segment = ensureSegmentCanvas(scaledSegmentWidth, metrics.scaledHeight)
    if (!segment) return

    const segmentStartSec =
      state.rangeStartSec + (safeSegmentX / metrics.cssWidth) * state.rangeDurationSec
    const segmentDurationSec = (safeSegmentWidth / metrics.cssWidth) * state.rangeDurationSec

    segment.ctx.setTransform(metrics.pixelRatio, 0, 0, metrics.pixelRatio, 0, 0)
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
      showBackground: false,
      maxSamplesPerPixel: state.maxSamplesPerPixel,
      showDetailHighlights: state.showDetailHighlights,
      showCenterLine: state.showCenterLine
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
      lastFrame.maxSamplesPerPixel === current.maxSamplesPerPixel &&
      lastFrame.showDetailHighlights === current.showDetailHighlights &&
      lastFrame.showCenterLine === current.showCenterLine
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
      maxSamplesPerPixel: input.maxSamplesPerPixel,
      showDetailHighlights: input.showDetailHighlights,
      showCenterLine: input.showCenterLine
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
                absShiftPx * metrics.pixelRatio,
                0,
                keepWidth * metrics.pixelRatio,
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
                keepWidth * metrics.pixelRatio,
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
