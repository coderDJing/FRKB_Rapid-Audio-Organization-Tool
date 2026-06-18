import type { HorizontalBrowseStableCanvasPresentationMeasureResult } from './horizontalBrowseStableCanvasPresentation'

export const STABLE_PLAYBACK_START_REANCHOR_SUPPRESS_MS = 220
export const STABLE_PLAYBACK_POSITION_JUMP_SEC = 0.25
export const STABLE_SEEK_REUSE_MAX_OFFSET_CSS_PX = Number.POSITIVE_INFINITY

export const createHorizontalBrowseStablePlaybackReanchorGate = () => {
  let suppressedUntilMs = 0
  return {
    suppress() {
      suppressedUntilMs = performance.now() + STABLE_PLAYBACK_START_REANCHOR_SUPPRESS_MS
    },
    canReanchor() {
      return performance.now() >= suppressedUntilMs
    }
  }
}

type PrepareStableCanvasJumpOptions = {
  seconds: number
  measure: (seconds: number) => HorizontalBrowseStableCanvasPresentationMeasureResult
  hide: () => void
  maxOffsetCssPx?: number
}

const canReuseStableCanvasMeasure = (
  measure: HorizontalBrowseStableCanvasPresentationMeasureResult,
  maxOffsetCssPx = STABLE_SEEK_REUSE_MAX_OFFSET_CSS_PX
) =>
  measure.presentable &&
  Math.abs(Number(measure.offsetCssPx) || 0) <= Math.max(0, Number(maxOffsetCssPx) || 0)

export const prepareHorizontalBrowseStableCanvasJump = ({
  seconds,
  measure,
  hide,
  maxOffsetCssPx
}: PrepareStableCanvasJumpOptions) => {
  const measured = measure(Number(seconds) || 0)
  const canReuseStableFrame = canReuseStableCanvasMeasure(measured, maxOffsetCssPx)
  if (!canReuseStableFrame) {
    hide()
    return false
  }
  return true
}
