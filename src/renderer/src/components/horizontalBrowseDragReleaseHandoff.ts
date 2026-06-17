const DEFAULT_DRAG_RELEASE_HANDOFF_MAX_MS = 450
const DEFAULT_DRAG_RELEASE_HANDOFF_EPSILON_SEC = 0.035

export type HorizontalBrowseDragReleaseHandoffKind =
  | 'seek-revision'
  | 'playback-sync'
  | 'stable-presentation'

type HorizontalBrowseDragReleaseHandoffOptions = {
  normalizeSeconds: (seconds: number) => number
  maxAgeMs?: number
  epsilonSec?: number
}

export const createHorizontalBrowseDragReleaseHandoff = ({
  normalizeSeconds,
  maxAgeMs = DEFAULT_DRAG_RELEASE_HANDOFF_MAX_MS,
  epsilonSec = DEFAULT_DRAG_RELEASE_HANDOFF_EPSILON_SEC
}: HorizontalBrowseDragReleaseHandoffOptions) => {
  let anchorSec: number | null = null
  let untilMs = 0
  let seekRevisionPending = false
  let playbackSyncPending = false
  let stablePresentationPending = false

  const clear = () => {
    anchorSec = null
    untilMs = 0
    seekRevisionPending = false
    playbackSyncPending = false
    stablePresentationPending = false
  }

  const begin = (seconds: number) => {
    anchorSec = normalizeSeconds(seconds)
    untilMs = performance.now() + maxAgeMs
    seekRevisionPending = true
    playbackSyncPending = true
    stablePresentationPending = true
  }

  const matches = (seconds: number) => {
    if (anchorSec === null) return false
    if (performance.now() > untilMs) {
      clear()
      return false
    }
    const safeSeconds = normalizeSeconds(seconds)
    return Math.abs(safeSeconds - anchorSec) <= epsilonSec
  }

  const consume = (kind: HorizontalBrowseDragReleaseHandoffKind, seconds: number) => {
    if (!matches(seconds)) return false
    if (kind === 'seek-revision') {
      seekRevisionPending = false
    } else if (kind === 'playback-sync') {
      playbackSyncPending = false
    } else {
      stablePresentationPending = false
    }
    if (!seekRevisionPending && !playbackSyncPending && !stablePresentationPending) clear()
    return true
  }

  return {
    begin,
    clear,
    matches,
    consume
  }
}
