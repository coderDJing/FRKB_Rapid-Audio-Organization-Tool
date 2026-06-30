const DEFAULT_DRAG_PRESENTATION_RELEASE_MAX_HOLD_MS = 240
const DEFAULT_DRAG_PRESENTATION_RELEASE_RANGE_EPSILON_SEC = 0.006

type RenderedViewportStartOptions = {
  stableWaveformSource: boolean
  rangeStartSec: number
  rangeDurationSec: number
  visibleDurationSec: number
}

type CanCompleteReleaseOptions = {
  pending: boolean
  expectedStartSec: number | null
  renderedViewportStartSec: number
  epsilonSec?: number
}

export const resolveHorizontalBrowseDragReleaseRenderedViewportStartSec = ({
  stableWaveformSource,
  rangeStartSec,
  rangeDurationSec,
  visibleDurationSec
}: RenderedViewportStartOptions) => {
  if (!stableWaveformSource) return rangeStartSec
  const overscanSec = Math.max(0, rangeDurationSec - visibleDurationSec) * 0.5
  return rangeStartSec + overscanSec
}

export const canCompleteHorizontalBrowseDragPresentationRelease = ({
  pending,
  expectedStartSec,
  renderedViewportStartSec,
  epsilonSec = DEFAULT_DRAG_PRESENTATION_RELEASE_RANGE_EPSILON_SEC
}: CanCompleteReleaseOptions) => {
  if (!pending) return false
  if (expectedStartSec === null) return true
  return Math.abs(renderedViewportStartSec - expectedStartSec) <= epsilonSec
}

export const isHorizontalBrowseDragPresentationReleaseExpired = (
  startedAtMs: number,
  nowMs = performance.now(),
  maxHoldMs = DEFAULT_DRAG_PRESENTATION_RELEASE_MAX_HOLD_MS
) => startedAtMs > 0 && nowMs - startedAtMs >= maxHoldMs
