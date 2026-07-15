import {
  drawHorizontalBrowseDetailOverlay,
  HORIZONTAL_BROWSE_DETAIL_OVERLAY_EXTEND_PX
} from '@renderer/composables/horizontalBrowse/horizontalBrowseDetailOverlayCanvas'
import { resolveCanvasScaleMetrics } from '@renderer/utils/canvasScale'
import type { HorizontalBrowseDetailLiveCanvasRenderRequest } from './horizontalBrowseDetailLiveCanvas.types'
import {
  createUnifiedSongBeatGridRuntime,
  type UnifiedSongBeatGridRuntime
} from '@shared/songBeatGridRuntime'

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
  beatGridMapSignature: string
  beatGridEditMode: boolean
  beatGridVisibleFromSec: number | null
  beatGridSelectedBoundarySec: number | null
  showBeatGrid: boolean
  playbackDurationSec: number
  themeVariant: 'light' | 'dark'
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

const MAJOR_GRID_LINE_WIDTH = 1.85
const MINOR_GRID_LINE_WIDTH = 1.45
const GRID_LINE_DIRECTIONAL_PROTRUSION_PX = 3
const CLIP_BOUNDARY_LINE_WIDTH = 1
const CLIP_BOUNDARY_SELECTED_LINE_WIDTH = 1
const CLIP_BOUNDARY_SELECTED_CAP_WIDTH = 7
const CLIP_BOUNDARY_SELECTED_CAP_HEIGHT = 1

type GridLineStyle = {
  core: string
  halo: string
  haloExtraWidth: number
}

const resolveGridPalette = (themeVariant: 'light' | 'dark') =>
  themeVariant === 'light'
    ? {
        majorGrid: {
          core: 'rgba(8, 13, 23, 0.78)',
          halo: 'rgba(255, 255, 255, 0.52)',
          haloExtraWidth: 1.15
        },
        minorGrid: {
          core: 'rgba(8, 13, 23, 0.58)',
          halo: 'rgba(255, 255, 255, 0.38)',
          haloExtraWidth: 0.85
        },
        clipBoundary: {
          core: 'rgba(217, 137, 33, 0.95)',
          halo: 'rgba(217, 137, 33, 0.95)',
          haloExtraWidth: 0
        },
        selectedClipBoundary: {
          core: 'rgba(255, 177, 59, 1)',
          halo: 'rgba(255, 177, 59, 1)',
          haloExtraWidth: 0
        }
      }
    : {
        majorGrid: {
          core: 'rgba(255, 255, 255, 0.84)',
          halo: 'rgba(0, 0, 0, 0.4)',
          haloExtraWidth: 1.15
        },
        minorGrid: {
          core: 'rgba(255, 255, 255, 0.68)',
          halo: 'rgba(0, 0, 0, 0.32)',
          haloExtraWidth: 0.85
        },
        clipBoundary: {
          core: 'rgba(255, 184, 77, 0.96)',
          halo: 'rgba(255, 184, 77, 0.96)',
          haloExtraWidth: 0
        },
        selectedClipBoundary: {
          core: 'rgba(255, 214, 92, 1)',
          halo: 'rgba(255, 214, 92, 1)',
          haloExtraWidth: 0
        }
      }

const resolveFirstVisibleDynamicLineIndex = (
  lines: UnifiedSongBeatGridRuntime['lines'],
  startSec: number
) => {
  let left = 0
  let right = lines.length - 1
  let answer = lines.length
  while (left <= right) {
    const middle = (left + right) >> 1
    if (lines[middle].sec >= startSec) {
      answer = middle
      right = middle - 1
    } else {
      left = middle + 1
    }
  }
  return answer
}

const drawBeatGridOverlay = (
  ctx: OffscreenCanvasRenderingContext2D,
  width: number,
  waveformTop: number,
  waveformHeight: number,
  direction: 'up' | 'down',
  overlayHeight: number,
  runtime: UnifiedSongBeatGridRuntime | null,
  playbackDurationSec: number,
  rangeStartSec: number,
  rangeDurationSec: number,
  themeVariant: 'light' | 'dark',
  beatGridEditMode: boolean,
  beatGridVisibleFromSec: number | null,
  beatGridSelectedBoundarySec: number | null
): void => {
  if (rangeDurationSec <= 0) return

  const palette = resolveGridPalette(themeVariant)
  const rangeEndSec = rangeStartSec + rangeDurationSec
  const durationSec = Math.max(0, Number(playbackDurationSec) || 0)
  const drawStartSec = Math.max(0, rangeStartSec)
  const drawEndSec = durationSec > 0 ? Math.min(durationSec, rangeEndSec) : rangeEndSec
  if (drawEndSec <= drawStartSec) return
  const editVisibleFromSec =
    beatGridEditMode && Number.isFinite(Number(beatGridVisibleFromSec))
      ? Math.max(0, Number(beatGridVisibleFromSec))
      : null
  const lineDrawStartSec =
    editVisibleFromSec === null ? drawStartSec : Math.max(drawStartSec, editVisibleFromSec)
  const drawLeft = ((drawStartSec - rangeStartSec) / rangeDurationSec) * width
  const drawRight = ((drawEndSec - rangeStartSec) / rangeDurationSec) * width
  const resolveLineLeft = (x: number, safeWidth: number) => x - safeWidth * 0.5
  const resolveLineCenter = (x: number, safeWidth: number) =>
    resolveLineLeft(x, safeWidth) + safeWidth * 0.5
  const drawVerticalLineLayer = (x: number, lineWidth: number, color: string) => {
    const safeWidth = Math.max(1, lineWidth)
    const halfWidth = safeWidth * 0.5
    const drawCenterX = resolveLineCenter(x, safeWidth)
    if (drawCenterX < drawLeft - halfWidth || drawCenterX > drawRight + halfWidth) return
    const rawLeft = resolveLineLeft(x, safeWidth)
    const left = Math.max(0, drawLeft, rawLeft)
    const right = Math.min(width, drawRight, rawLeft + safeWidth)
    if (right <= left) return
    ctx.fillStyle = color
    const lineTop =
      direction === 'up' ? waveformTop - GRID_LINE_DIRECTIONAL_PROTRUSION_PX : waveformTop
    const lineHeight = waveformHeight + GRID_LINE_DIRECTIONAL_PROTRUSION_PX
    ctx.fillRect(left, lineTop, right - left, lineHeight)
  }

  const drawVerticalLine = (x: number, lineWidth: number, style: GridLineStyle) => {
    drawVerticalLineLayer(x, lineWidth + style.haloExtraWidth, style.halo)
    drawVerticalLineLayer(x, lineWidth, style.core)
  }

  const drawClipBoundary = (x: number, style: GridLineStyle, selected: boolean) => {
    const safeWidth = Math.max(
      1,
      selected ? CLIP_BOUNDARY_SELECTED_LINE_WIDTH : CLIP_BOUNDARY_LINE_WIDTH
    )
    const halfWidth = safeWidth * 0.5
    const drawCenterX = resolveLineCenter(x, safeWidth)
    if (drawCenterX < drawLeft - halfWidth || drawCenterX > drawRight + halfWidth) return
    const rawLeft = resolveLineLeft(x, safeWidth)
    const left = Math.max(0, drawLeft, rawLeft)
    const right = Math.min(width, drawRight, rawLeft + safeWidth)
    if (right <= left) return
    ctx.fillStyle = style.core
    ctx.fillRect(left, 0, right - left, Math.max(1, overlayHeight))
    if (!selected) return
    const capWidth = Math.min(CLIP_BOUNDARY_SELECTED_CAP_WIDTH, Math.max(1, drawRight - drawLeft))
    const capHeight = Math.min(CLIP_BOUNDARY_SELECTED_CAP_HEIGHT, Math.max(1, overlayHeight))
    const capLeft = Math.max(
      0,
      drawLeft,
      Math.min(drawCenterX - capWidth * 0.5, drawRight - capWidth)
    )
    ctx.fillRect(capLeft, 0, capWidth, capHeight)
    ctx.fillRect(capLeft, Math.max(0, overlayHeight - capHeight), capWidth, capHeight)
  }

  if (runtime) {
    const lines = runtime.lines
    const firstLineIndex = resolveFirstVisibleDynamicLineIndex(lines, lineDrawStartSec - 0.001)
    for (let index = firstLineIndex; index < lines.length; index += 1) {
      const line = lines[index]
      const beatTime = line.sec
      if (beatTime > drawEndSec + 0.001) break
      const x = ((beatTime - rangeStartSec) / rangeDurationSec) * width
      if (line.level === 'downbeat') {
        drawVerticalLine(x, MAJOR_GRID_LINE_WIDTH, palette.majorGrid)
      } else {
        drawVerticalLine(x, MINOR_GRID_LINE_WIDTH, palette.minorGrid)
      }
    }
    for (const boundarySec of runtime.clipBoundaries) {
      if (boundarySec < drawStartSec - 0.001 || boundarySec > drawEndSec + 0.001) continue
      const x = ((boundarySec - rangeStartSec) / rangeDurationSec) * width
      const selected =
        beatGridSelectedBoundarySec !== null &&
        Math.abs(boundarySec - beatGridSelectedBoundarySec) <= 0.001
      drawClipBoundary(x, selected ? palette.selectedClipBoundary : palette.clipBoundary, selected)
    }
  }
}

export const createHorizontalBrowseDetailLiveCanvasOverlayRenderer = () => {
  let canvas: OffscreenCanvas | null = null
  let ctx: OffscreenCanvasRenderingContext2D | null = null
  let lastFrame: OverlayFrameState | null = null
  let dynamicRuntimeCache: {
    signature: string
    durationSec: number
    runtime: UnifiedSongBeatGridRuntime | null
  } | null = null

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
    const cssWidth = Math.max(
      1,
      Number(
        request.stableWaveformSource === true
          ? request.width
          : request.viewportWidth || request.width
      ) || 1
    )
    const cssHeight = waveformCssHeight + HORIZONTAL_BROWSE_DETAIL_OVERLAY_EXTEND_PX * 2
    const metrics = resolveCanvasScaleMetrics(cssWidth, cssHeight, request.pixelRatio, {
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
    beatGridMapSignature: String(request.beatGridMap?.signature || ''),
    beatGridEditMode: request.beatGridEditMode === true,
    beatGridVisibleFromSec: Number.isFinite(Number(request.beatGridVisibleFromSec))
      ? Number(request.beatGridVisibleFromSec)
      : null,
    beatGridSelectedBoundarySec: Number.isFinite(Number(request.beatGridSelectedBoundarySec))
      ? Number(request.beatGridSelectedBoundarySec)
      : null,
    showBeatGrid: request.showBeatGrid === true,
    playbackDurationSec: Math.max(0, Number(request.playbackDurationSec) || 0),
    themeVariant: request.themeVariant,
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
      lastFrame.beatGridMapSignature === current.beatGridMapSignature &&
      lastFrame.beatGridEditMode === current.beatGridEditMode &&
      lastFrame.beatGridVisibleFromSec === current.beatGridVisibleFromSec &&
      lastFrame.beatGridSelectedBoundarySec === current.beatGridSelectedBoundarySec &&
      lastFrame.showBeatGrid === current.showBeatGrid &&
      lastFrame.playbackDurationSec === current.playbackDurationSec &&
      lastFrame.themeVariant === current.themeVariant &&
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
      themeVariant: request.themeVariant,
      xPixelScale
    })
  }

  const resolveGridRuntime = (
    beatGridMap: HorizontalBrowseDetailLiveCanvasRenderRequest['beatGridMap'],
    durationSec: number
  ) => {
    const signature = String(beatGridMap?.signature || '')
    const safeDurationSec = Math.max(0, Number(durationSec) || 0)
    if (!signature || safeDurationSec <= 0) return null
    if (
      dynamicRuntimeCache &&
      dynamicRuntimeCache.signature === signature &&
      dynamicRuntimeCache.durationSec === safeDurationSec
    ) {
      return dynamicRuntimeCache.runtime
    }
    const runtime = createUnifiedSongBeatGridRuntime(beatGridMap, safeDurationSec)
    dynamicRuntimeCache = {
      signature,
      durationSec: safeDurationSec,
      runtime
    }
    return runtime
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
    if (request.showBeatGrid) {
      const playbackDurationSec = Number(request.playbackDurationSec) || 0
      drawBeatGridOverlay(
        ctx,
        metrics.cssWidth,
        HORIZONTAL_BROWSE_DETAIL_OVERLAY_EXTEND_PX,
        metrics.waveformCssHeight,
        request.direction,
        metrics.cssHeight,
        resolveGridRuntime(request.beatGridMap, playbackDurationSec),
        playbackDurationSec,
        rangeStartSec,
        rangeDurationSec,
        request.themeVariant,
        request.beatGridEditMode === true,
        Number.isFinite(Number(request.beatGridVisibleFromSec))
          ? Number(request.beatGridVisibleFromSec)
          : null,
        Number.isFinite(Number(request.beatGridSelectedBoundarySec))
          ? Number(request.beatGridSelectedBoundarySec)
          : null
      )
    }
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
