import type { CanvasMetrics } from './horizontalBrowseDetailLiveCanvasRenderState'
import type { HorizontalBrowseDetailLiveCanvasRenderRequest } from './horizontalBrowseDetailLiveCanvas.types'

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
