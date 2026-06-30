import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import type { DeckWaveformDragState } from '@renderer/composables/horizontalBrowse/horizontalBrowseDeckPlaybackState'

type DeckKey = HorizontalBrowseDeckKey

export type HorizontalBrowseLinkedDragBoundary = 'none' | 'start' | 'end'

export type HorizontalBrowseLinkedDragTargets = {
  sourceTargetSec: number
  otherTargetSec: number
  sourceDeltaSec: number
  otherDeltaSec: number
  expectedOtherDeltaSec: number
  deltaScale: number
  sourceVisualPlaybackRate: number
  otherVisualPlaybackRate: number
  sourceBoundary: HorizontalBrowseLinkedDragBoundary
  otherBoundary: HorizontalBrowseLinkedDragBoundary
}

type LinkedDragTargetParams = {
  deck: DeckKey
  otherDeck: DeckKey
  rawSourceTargetSec: number
  sourceDragState: DeckWaveformDragState
  otherDragState: DeckWaveformDragState
  resolveDeckDurationSeconds: (deck: DeckKey) => number
}

type LinkedDragBounds = {
  minSec: number
  maxSec: number
}

export const normalizeLinkedDragVisualPlaybackRate = (value: unknown) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.max(0.25, numeric) : 1
}

const resolveFiniteSeconds = (value: unknown) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

const resolveLinkedDragBounds = (
  dragState: DeckWaveformDragState,
  durationSec: number
): LinkedDragBounds => {
  const startSec = resolveFiniteSeconds(dragState.startAnchorSec)
  const safeDurationSec = Number.isFinite(Number(durationSec)) ? Number(durationSec) : 0
  return {
    minSec: Math.min(0, startSec),
    maxSec: safeDurationSec > 0 ? Math.max(safeDurationSec, startSec) : Number.MAX_SAFE_INTEGER
  }
}

const clampLinkedDragTarget = (
  rawSeconds: number,
  bounds: LinkedDragBounds
): { seconds: number; boundary: HorizontalBrowseLinkedDragBoundary } => {
  const numeric = Number(rawSeconds)
  const seconds = Number.isFinite(numeric) ? numeric : 0
  if (seconds < bounds.minSec) {
    return { seconds: bounds.minSec, boundary: 'start' }
  }
  if (seconds > bounds.maxSec) {
    return { seconds: bounds.maxSec, boundary: 'end' }
  }
  return { seconds, boundary: 'none' }
}

export const resolveHorizontalBrowseLinkedDragTargets = ({
  deck,
  otherDeck,
  rawSourceTargetSec,
  sourceDragState,
  otherDragState,
  resolveDeckDurationSeconds
}: LinkedDragTargetParams): HorizontalBrowseLinkedDragTargets => {
  const sourceVisualPlaybackRate = normalizeLinkedDragVisualPlaybackRate(
    sourceDragState.visualPlaybackRate
  )
  const otherVisualPlaybackRate = normalizeLinkedDragVisualPlaybackRate(
    otherDragState.visualPlaybackRate
  )
  const deltaScale = otherVisualPlaybackRate / sourceVisualPlaybackRate
  const sourceBounds = resolveLinkedDragBounds(sourceDragState, resolveDeckDurationSeconds(deck))
  const otherBounds = resolveLinkedDragBounds(otherDragState, resolveDeckDurationSeconds(otherDeck))
  const sourceTarget = clampLinkedDragTarget(rawSourceTargetSec, sourceBounds)
  const sourceTargetSec = resolveFiniteSeconds(rawSourceTargetSec)
  const sourceDeltaSec = sourceTargetSec - resolveFiniteSeconds(sourceDragState.startAnchorSec)
  const expectedOtherDeltaSec = sourceDeltaSec * deltaScale
  const rawOtherTargetSec =
    resolveFiniteSeconds(otherDragState.startAnchorSec) + expectedOtherDeltaSec
  const otherTarget = clampLinkedDragTarget(rawOtherTargetSec, otherBounds)

  return {
    sourceTargetSec,
    otherTargetSec: otherTarget.seconds,
    sourceDeltaSec,
    otherDeltaSec: otherTarget.seconds - resolveFiniteSeconds(otherDragState.startAnchorSec),
    expectedOtherDeltaSec,
    deltaScale,
    sourceVisualPlaybackRate,
    otherVisualPlaybackRate,
    sourceBoundary: sourceTarget.boundary,
    otherBoundary: otherTarget.boundary
  }
}
