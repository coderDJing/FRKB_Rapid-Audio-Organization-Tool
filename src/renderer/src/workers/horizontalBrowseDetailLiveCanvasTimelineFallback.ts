import type { CanvasMetrics } from './horizontalBrowseDetailLiveCanvasRenderState'
import type { HorizontalBrowseDetailLiveCanvasRenderRequest } from './horizontalBrowseDetailLiveCanvas.types'

const MINOR_TICK_SEC = 5
const MAJOR_TICK_SEC = 30
const ANCHOR_TICK_SEC = 60

const resolvePalette = (themeVariant: 'light' | 'dark') =>
  themeVariant === 'light'
    ? {
        minor: 'rgba(15, 23, 42, 0.18)',
        major: 'rgba(15, 23, 42, 0.31)',
        anchor: 'rgba(15, 23, 42, 0.44)',
        halo: 'rgba(255, 255, 255, 0.5)',
        center: 'rgba(15, 23, 42, 0.48)',
        centerHalo: 'rgba(255, 255, 255, 0.72)'
      }
    : {
        minor: 'rgba(255, 255, 255, 0.18)',
        major: 'rgba(255, 255, 255, 0.31)',
        anchor: 'rgba(255, 255, 255, 0.44)',
        halo: 'rgba(0, 0, 0, 0.4)',
        center: 'rgba(255, 255, 255, 0.52)',
        centerHalo: 'rgba(0, 0, 0, 0.54)'
      }

export const renderHorizontalBrowseTimelineFallback = (
  ctx: OffscreenCanvasRenderingContext2D,
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  metrics: CanvasMetrics
) => {
  const rangeStartSec = Number(request.rangeStartSec) || 0
  const rangeDurationSec = Math.max(0.001, Number(request.rangeDurationSec) || 0)
  const rangeEndSec = rangeStartSec + rangeDurationSec
  const durationSec = Math.max(0, Number(request.playbackDurationSec) || 0)
  const drawStartSec = Math.max(0, rangeStartSec)
  const drawEndSec = durationSec > 0 ? Math.min(durationSec, rangeEndSec) : rangeEndSec
  if (drawEndSec <= drawStartSec) return
  const drawLeft = ((drawStartSec - rangeStartSec) / rangeDurationSec) * metrics.cssWidth
  const drawRight = ((drawEndSec - rangeStartSec) / rangeDurationSec) * metrics.cssWidth
  const firstTickSec = Math.ceil(drawStartSec / MINOR_TICK_SEC) * MINOR_TICK_SEC
  const palette = resolvePalette(request.themeVariant)

  ctx.setTransform(metrics.scaleX, 0, 0, metrics.scaleY, 0, 0)
  ctx.imageSmoothingEnabled = false

  const drawVerticalLine = (x: number, width: number, color: string) => {
    const lineWidth = Math.max(1, width)
    const left = Math.max(drawLeft, Math.min(drawRight, Math.round(x) - lineWidth / 2))
    if (left > drawRight) return
    const clippedWidth = Math.min(lineWidth, drawRight - left)
    if (clippedWidth <= 0) return
    ctx.fillStyle = color
    ctx.fillRect(left, 0, clippedWidth, metrics.cssHeight)
  }

  const drawCenterLine = (height: number, color: string) => {
    const top = Math.max(
      0,
      Math.min(metrics.cssHeight, Math.round(metrics.cssHeight / 2 - height / 2))
    )
    if (top > metrics.cssHeight) return
    ctx.fillStyle = color
    ctx.fillRect(drawLeft, top, Math.max(0, drawRight - drawLeft), height)
  }

  for (let second = firstTickSec; second <= drawEndSec + 0.001; second += MINOR_TICK_SEC) {
    if (second < drawStartSec - 0.001) continue
    const x = ((second - rangeStartSec) / rangeDurationSec) * metrics.cssWidth
    const isAnchor = second % ANCHOR_TICK_SEC === 0
    const isMajor = second % MAJOR_TICK_SEC === 0
    if (isAnchor) {
      drawVerticalLine(x, 3, palette.halo)
      drawVerticalLine(x, 1.75, palette.anchor)
    } else if (isMajor) {
      drawVerticalLine(x, 2.2, palette.halo)
      drawVerticalLine(x, 1.25, palette.major)
    } else {
      drawVerticalLine(x, 1, palette.minor)
    }
  }

  drawCenterLine(4, palette.centerHalo)
  drawCenterLine(2, palette.center)
}
