import {
  drawHorizontalBrowseDetailOverlay,
  HORIZONTAL_BROWSE_DETAIL_OVERLAY_EXTEND_PX
} from '@renderer/components/horizontalBrowseDetailOverlayCanvas'
import { resolveCanvasScaleMetrics } from '@renderer/utils/canvasScale'
import type { HorizontalBrowseDetailLiveCanvasRenderRequest } from './horizontalBrowseDetailLiveCanvas.types'

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

type OverlayCanvasMetrics = CanvasMetrics & {
  waveformCssHeight: number
}

type OverlayFrameState = {
  width: number
  height: number
  waveformHeight: number
  direction: 'up' | 'down'
  rangeStartSec: number
  rangeDurationSec: number
  timeBasisOffsetMs: number
  cueSeconds: number | null
  hotCueSignature: string
  memoryCueSignature: string
  loopStartSec: number | null
  loopEndSec: number | null
  cueAccentColor: string
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

export const createHorizontalBrowseDetailLiveCanvasOverlayRenderer = () => {
  let canvas: OffscreenCanvas | null = null
  let ctx: OffscreenCanvasRenderingContext2D | null = null
  let lastFrame: OverlayFrameState | null = null

  const reset = () => {
    lastFrame = null
  }

  const attach = (nextCanvas: OffscreenCanvas) => {
    canvas = nextCanvas
    ctx = canvas.getContext('2d')
    reset()
  }

  const clear = () => {
    reset()
    if (!canvas || !ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }

  const ensureCanvasMetrics = (
    request: HorizontalBrowseDetailLiveCanvasRenderRequest
  ): OverlayCanvasMetrics | null => {
    if (!canvas || !ctx) return null
    const waveformCssHeight = Math.max(1, Number(request.height) || 1)
    const cssHeight = waveformCssHeight + HORIZONTAL_BROWSE_DETAIL_OVERLAY_EXTEND_PX * 2
    const metrics = resolveCanvasScaleMetrics(request.width, cssHeight, request.pixelRatio)
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
      waveformCssHeight,
      resized: previousWidth !== metrics.scaledWidth || previousHeight !== metrics.scaledHeight
    }
  }

  const buildFrameState = (
    request: HorizontalBrowseDetailLiveCanvasRenderRequest,
    metrics: OverlayCanvasMetrics,
    rangeStartSec: number,
    rangeDurationSec: number
  ): OverlayFrameState => ({
    width: metrics.cssWidth,
    height: metrics.cssHeight,
    waveformHeight: metrics.waveformCssHeight,
    direction: request.direction,
    rangeStartSec,
    rangeDurationSec: Math.max(0.0001, Number(rangeDurationSec) || 0.0001),
    timeBasisOffsetMs: Math.max(0, Number(request.timeBasisOffsetMs) || 0),
    cueSeconds: Number.isFinite(Number(request.cueSeconds)) ? Number(request.cueSeconds) : null,
    hotCueSignature: request.hotCues
      .map((item) =>
        [
          item.slot,
          Number(item.sec) || 0,
          item.label || '',
          item.color || '',
          item.isLoop ? 1 : 0,
          Number(item.loopEndSec) || 0,
          item.source || ''
        ].join(':')
      )
      .join('|'),
    memoryCueSignature: request.memoryCues
      .map((item) =>
        [
          Number(item.sec) || 0,
          item.color || '',
          item.isLoop ? 1 : 0,
          Number(item.loopEndSec) || 0,
          item.source || ''
        ].join(':')
      )
      .join('|'),
    loopStartSec: request.loopRange ? Number(request.loopRange.startSec) || 0 : null,
    loopEndSec: request.loopRange ? Number(request.loopRange.endSec) || 0 : null,
    cueAccentColor: request.cueAccentColor
  })

  const canReuseFrame = (current: OverlayFrameState, metrics: OverlayCanvasMetrics) => {
    if (metrics.resized || !lastFrame) return false
    return (
      lastFrame.width === current.width &&
      lastFrame.height === current.height &&
      lastFrame.waveformHeight === current.waveformHeight &&
      lastFrame.direction === current.direction &&
      lastFrame.rangeDurationSec === current.rangeDurationSec &&
      lastFrame.timeBasisOffsetMs === current.timeBasisOffsetMs &&
      lastFrame.cueSeconds === current.cueSeconds &&
      lastFrame.hotCueSignature === current.hotCueSignature &&
      lastFrame.memoryCueSignature === current.memoryCueSignature &&
      lastFrame.loopStartSec === current.loopStartSec &&
      lastFrame.loopEndSec === current.loopEndSec &&
      lastFrame.cueAccentColor === current.cueAccentColor
    )
  }

  const drawOverlayRange = (
    targetCtx: OffscreenCanvasRenderingContext2D,
    request: HorizontalBrowseDetailLiveCanvasRenderRequest,
    width: number,
    height: number,
    waveformHeight: number,
    rangeStartSec: number,
    rangeDurationSec: number,
    xPixelScale: number
  ) => {
    drawHorizontalBrowseDetailOverlay({
      ctx: targetCtx,
      width,
      height,
      waveformHeight,
      overlayInsetPx: HORIZONTAL_BROWSE_DETAIL_OVERLAY_EXTEND_PX,
      direction: request.direction,
      rangeStartSec,
      rangeDurationSec,
      cueSeconds: request.cueSeconds ?? undefined,
      hotCues: request.hotCues,
      memoryCues: request.memoryCues,
      loopRange: request.loopRange,
      cueAccentColor: request.cueAccentColor,
      timeBasisOffsetMs: request.timeBasisOffsetMs,
      xPixelScale
    })
  }

  const render = (
    request: HorizontalBrowseDetailLiveCanvasRenderRequest,
    rangeStartSec: number,
    rangeDurationSec: number,
    _scrollShiftScaledPx: number | null
  ) => {
    const metrics = ensureCanvasMetrics(request)
    if (!metrics || !ctx) return false
    const state = buildFrameState(request, metrics, rangeStartSec, rangeDurationSec)

    if (
      canReuseFrame(state, metrics) &&
      lastFrame &&
      Math.abs(state.rangeStartSec - lastFrame.rangeStartSec) <= 0.000001
    ) {
      lastFrame = state
      return true
    }

    ctx.clearRect(0, 0, metrics.cssWidth, metrics.cssHeight)
    drawOverlayRange(
      ctx,
      request,
      metrics.cssWidth,
      metrics.cssHeight,
      metrics.waveformCssHeight,
      rangeStartSec,
      rangeDurationSec,
      metrics.scaleX
    )
    lastFrame = state
    return true
  }

  return {
    attach,
    clear,
    reset,
    render
  }
}
