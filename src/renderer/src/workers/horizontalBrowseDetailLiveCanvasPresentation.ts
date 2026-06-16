import type { HorizontalBrowseDetailLiveCanvasRenderRequest } from './horizontalBrowseDetailLiveCanvas.types'
import type { CanvasMetrics } from './horizontalBrowseDetailLiveCanvasRenderState'

export const resolveOverlayRangeStartSec = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest
) =>
  Number.isFinite(Number(request.viewportRangeStartSec))
    ? Number(request.viewportRangeStartSec)
    : request.rangeStartSec

export const resolveOverlayRangeDurationSec = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest
) =>
  Number.isFinite(Number(request.viewportRangeDurationSec)) &&
  Number(request.viewportRangeDurationSec) > 0
    ? Number(request.viewportRangeDurationSec)
    : request.rangeDurationSec

export const resolvePresentationOffsetCssPx = (
  request: HorizontalBrowseDetailLiveCanvasRenderRequest,
  metrics: CanvasMetrics,
  committedRangeStartSec: number,
  committedRangeDurationSec: number
) => {
  const rawOffset =
    request.presentationOffsetMode === 'none' || committedRangeDurationSec <= 0
      ? 0
      : ((committedRangeStartSec - request.rangeStartSec) * metrics.cssWidth) /
        committedRangeDurationSec
  return request.presentationOffsetMode === 'device-pixel'
    ? Math.round(rawOffset * metrics.scaleX) / metrics.scaleX
    : rawOffset
}
