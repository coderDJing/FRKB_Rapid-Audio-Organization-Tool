import type { ISongHotCue, ISongMemoryCue } from 'src/types/globals'
import { normalizeSongHotCues } from '@shared/hotCues'
import { normalizeSongMemoryCues } from '@shared/memoryCues'
import { resolveCanvasScaleMetrics } from '@renderer/utils/canvasScale'
import {
  drawHorizontalBrowseDetailOverlay,
  HORIZONTAL_BROWSE_DETAIL_OVERLAY_EXTEND_PX
} from '@renderer/components/horizontalBrowseDetailOverlayCanvas'

type HorizontalBrowseDirection = 'up' | 'down'

type HorizontalBrowseLoopRange = {
  startSec: number
  endSec: number
}

type HorizontalBrowseDetailOverlayRenderInput = {
  canvas: HTMLCanvasElement
  wrap: HTMLDivElement
  direction: HorizontalBrowseDirection
  rangeStartSec: number
  rangeDurationSec: number
  cueSeconds?: number
  hotCues?: ISongHotCue[] | null
  memoryCues?: ISongMemoryCue[] | null
  loopRange?: HorizontalBrowseLoopRange | null
  allowScrollReuse?: boolean
}

type CanvasMetrics = {
  cssWidth: number
  cssHeight: number
  waveformCssHeight: number
  scaledWidth: number
  scaledHeight: number
  scaleX: number
  scaleY: number
  resized: boolean
}

type FrameState = {
  width: number
  height: number
  waveformHeight: number
  direction: HorizontalBrowseDirection
  rangeStartSec: number
  rangeDurationSec: number
  cueSeconds: number | null
  hotCueSignature: string
  memoryCueSignature: string
  loopStartSec: number | null
  loopEndSec: number | null
}

const OVERLAY_SEGMENT_PADDING_PX = 64

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
  const cssWidth = Math.max(1, wrap.clientWidth)
  const waveformCssHeight = Math.max(1, wrap.clientHeight)
  const cssHeight = waveformCssHeight + HORIZONTAL_BROWSE_DETAIL_OVERLAY_EXTEND_PX * 2
  const previousWidth = canvas.width
  const previousHeight = canvas.height
  const metrics = resolveCanvasScaleMetrics(cssWidth, cssHeight, window.devicePixelRatio || 1)

  if (previousWidth !== metrics.scaledWidth) {
    canvas.width = metrics.scaledWidth
  }
  if (previousHeight !== metrics.scaledHeight) {
    canvas.height = metrics.scaledHeight
  }

  applyCanvasScaleTransform(ctx, metrics.scaleX, metrics.scaleY)
  return {
    cssWidth,
    cssHeight,
    waveformCssHeight,
    scaledWidth: metrics.scaledWidth,
    scaledHeight: metrics.scaledHeight,
    scaleX: metrics.scaleX,
    scaleY: metrics.scaleY,
    resized: previousWidth !== metrics.scaledWidth || previousHeight !== metrics.scaledHeight
  }
}

const buildHotCueSignature = (hotCues?: ISongHotCue[] | null) =>
  normalizeSongHotCues(hotCues)
    .map((item) =>
      [item.slot, Number(item.sec) || 0, item.isLoop ? 1 : 0, Number(item.loopEndSec) || 0].join(
        ':'
      )
    )
    .join('|')

const buildMemoryCueSignature = (memoryCues?: ISongMemoryCue[] | null) =>
  normalizeSongMemoryCues(memoryCues)
    .map((item) =>
      [Number(item.sec) || 0, item.isLoop ? 1 : 0, Number(item.loopEndSec) || 0].join(':')
    )
    .join('|')

const buildFrameState = (
  input: HorizontalBrowseDetailOverlayRenderInput,
  metrics: CanvasMetrics
): FrameState => ({
  width: metrics.cssWidth,
  height: metrics.cssHeight,
  waveformHeight: metrics.waveformCssHeight,
  direction: input.direction,
  rangeStartSec: Number.isFinite(input.rangeStartSec) ? input.rangeStartSec : 0,
  rangeDurationSec: Math.max(0.0001, Number(input.rangeDurationSec) || 0.0001),
  cueSeconds: Number.isFinite(Number(input.cueSeconds)) ? Number(input.cueSeconds) : null,
  hotCueSignature: buildHotCueSignature(input.hotCues),
  memoryCueSignature: buildMemoryCueSignature(input.memoryCues),
  loopStartSec: input.loopRange ? Math.max(0, Number(input.loopRange.startSec) || 0) : null,
  loopEndSec: input.loopRange
    ? Math.max(0, Number(input.loopRange.endSec ?? input.loopRange.startSec) || 0)
    : null
})

const drawRange = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  waveformHeight: number,
  rangeStartSec: number,
  rangeDurationSec: number,
  xPixelScale: number,
  input: HorizontalBrowseDetailOverlayRenderInput
) => {
  drawHorizontalBrowseDetailOverlay({
    ctx,
    width,
    height,
    waveformHeight,
    overlayInsetPx: HORIZONTAL_BROWSE_DETAIL_OVERLAY_EXTEND_PX,
    direction: input.direction,
    rangeStartSec,
    rangeDurationSec,
    cueSeconds: input.cueSeconds,
    hotCues: input.hotCues,
    memoryCues: input.memoryCues,
    loopRange: input.loopRange,
    xPixelScale
  })
}

export const createHorizontalBrowseDetailOverlayRenderer = () => {
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

  const canReusePreviousFrame = (current: FrameState, metrics: CanvasMetrics) => {
    if (metrics.resized || !lastFrame) return false
    return (
      lastFrame.width === current.width &&
      lastFrame.height === current.height &&
      lastFrame.waveformHeight === current.waveformHeight &&
      lastFrame.direction === current.direction &&
      lastFrame.rangeDurationSec === current.rangeDurationSec &&
      lastFrame.cueSeconds === current.cueSeconds &&
      lastFrame.hotCueSignature === current.hotCueSignature &&
      lastFrame.memoryCueSignature === current.memoryCueSignature &&
      lastFrame.loopStartSec === current.loopStartSec &&
      lastFrame.loopEndSec === current.loopEndSec
    )
  }

  const drawSegment = (
    ctx: CanvasRenderingContext2D,
    metrics: CanvasMetrics,
    state: FrameState,
    input: HorizontalBrowseDetailOverlayRenderInput,
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
    drawRange(
      segment.ctx,
      safeSegmentWidth,
      metrics.cssHeight,
      metrics.waveformCssHeight,
      segmentStartSec,
      segmentDurationSec,
      metrics.scaleX,
      input
    )

    ctx.clearRect(safeSegmentX, 0, safeSegmentWidth, metrics.cssHeight)
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

  const draw = (input: HorizontalBrowseDetailOverlayRenderInput) => {
    const ctx = input.canvas.getContext('2d')
    if (!ctx) return

    const metrics = ensureCanvasMetrics(input.canvas, input.wrap, ctx)
    const state = buildFrameState(input, metrics)

    if (
      input.allowScrollReuse !== false &&
      canReusePreviousFrame(state, metrics) &&
      lastFrame &&
      Math.abs(state.rangeStartSec - lastFrame.rangeStartSec) <= 0.000001
    ) {
      lastFrame = state
      return
    }

    let reused = false
    if (input.allowScrollReuse !== false && canReusePreviousFrame(state, metrics) && lastFrame) {
      const shiftScaledPx =
        ((state.rangeStartSec - lastFrame.rangeStartSec) / state.rangeDurationSec) *
        metrics.scaledWidth
      const absShiftScaledPx = Math.abs(shiftScaledPx)
      if (absShiftScaledPx > 0.0001 && absShiftScaledPx < metrics.scaledWidth) {
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
            const segmentX = Math.max(0, Math.floor(keepCssWidth) - OVERLAY_SEGMENT_PADDING_PX)
            const segmentWidth = Math.max(1, metrics.cssWidth - segmentX)
            drawSegment(ctx, metrics, state, input, segmentX, segmentWidth)
          } else {
            const segmentWidth = Math.max(
              1,
              Math.min(metrics.cssWidth, Math.ceil(absShiftCssPx) + OVERLAY_SEGMENT_PADDING_PX)
            )
            drawSegment(ctx, metrics, state, input, 0, segmentWidth)
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
        metrics.waveformCssHeight,
        state.rangeStartSec,
        state.rangeDurationSec,
        metrics.scaleX,
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
