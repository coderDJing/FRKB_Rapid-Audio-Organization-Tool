import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/components/horizontalBrowseNativeTransport'
import type {
  HorizontalBrowseLinkedGridVisualTransactionDeckState,
  HorizontalBrowseLinkedGridVisualTransactionMode
} from '@renderer/components/horizontalBrowseLinkedGridVisualTransaction'
import type {
  HorizontalBrowseDeckStateCommitOptions,
  HorizontalBrowseDeckTransportStateOverride
} from '@renderer/components/useHorizontalBrowseTransportMutations'

type DeckKey = HorizontalBrowseDeckKey

export type CommitHorizontalBrowseDeckStatesToNative = (
  overrides?: Partial<Record<DeckKey, HorizontalBrowseDeckTransportStateOverride>>,
  options?: HorizontalBrowseDeckStateCommitOptions
) => Promise<unknown>

type LinkedDragReleaseCommitParams = {
  deck: DeckKey
  otherDeck: DeckKey
  targetSec: number
  otherTargetSec: number
  shouldResume: boolean
  prepareDeckPlayheadIfNeeded: (deck: DeckKey) => Promise<void>
  startDeckRenderPlaybackClock: (deck: DeckKey, seconds: number) => void
  commitDeckStatesToNative: CommitHorizontalBrowseDeckStatesToNative
  stopIfStale: (reason: string) => boolean
}

type BoundaryLinkedDragReleaseCommitParams = LinkedDragReleaseCommitParams & {
  boundaryReferenceDeck: DeckKey
  finalLeaderDeck: DeckKey | null
  setLeader: (
    deck?: DeckKey | null,
    options?: { notifySnapshotListeners?: boolean }
  ) => Promise<unknown>
  alignToLeader: (
    deck: DeckKey,
    targetSec?: number,
    skipGridSnap?: boolean,
    options?: { notifySnapshotListeners?: boolean }
  ) => Promise<unknown>
  resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
  commitLinkedGridVisualTransaction?: (
    payload: {
      leader: DeckKey
      follower: DeckKey
      mode?: HorizontalBrowseLinkedGridVisualTransactionMode
      deckStates?: Partial<Record<DeckKey, HorizontalBrowseLinkedGridVisualTransactionDeckState>>
    },
    options?: { begin?: boolean }
  ) => Promise<boolean> | boolean
}

type LinkedDragReleaseCommitResult = {
  committed: boolean
  targetSec: number
  otherTargetSec: number
}

const resolveDeckTargetSec = (
  currentDeck: DeckKey,
  sourceDeck: DeckKey,
  sourceTargetSec: number,
  otherTargetSec: number
) => (currentDeck === sourceDeck ? sourceTargetSec : otherTargetSec)

const resolveSnapshotCurrentSeconds = (
  snapshot: HorizontalBrowseTransportDeckSnapshot,
  fallback: number
) => {
  const currentSec = Number(snapshot.currentSec)
  if (Number.isFinite(currentSec)) return currentSec
  const renderCurrentSec = Number(snapshot.renderCurrentSec)
  return Number.isFinite(renderCurrentSec) ? renderCurrentSec : fallback
}

const normalizePlaybackRate = (value: unknown) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.max(0.25, numeric) : 1
}

const buildLinkedDragReleaseOverrides = (
  sourceDeck: DeckKey,
  sourceTargetSec: number,
  otherTargetSec: number,
  observedAtMs: number,
  playing: boolean,
  playbackRates: Partial<Record<DeckKey, number>> = {}
): Partial<Record<DeckKey, HorizontalBrowseDeckTransportStateOverride>> => {
  const buildOverride = (targetDeck: DeckKey): HorizontalBrowseDeckTransportStateOverride => {
    const playbackRate = playbackRates[targetDeck]
    const override: HorizontalBrowseDeckTransportStateOverride = {
      currentSec: resolveDeckTargetSec(targetDeck, sourceDeck, sourceTargetSec, otherTargetSec),
      lastObservedAtMs: observedAtMs,
      playing
    }
    if (playbackRate !== undefined) {
      override.playbackRate = playbackRate
    }
    return override
  }
  return {
    top: buildOverride('top'),
    bottom: buildOverride('bottom')
  }
}

const buildLinkedGridVisualTransactionDeckStates = (
  snapshots: Record<DeckKey, HorizontalBrowseTransportDeckSnapshot>,
  currentSeconds: Record<DeckKey, number>,
  playbackActive: boolean
): Partial<Record<DeckKey, HorizontalBrowseLinkedGridVisualTransactionDeckState>> => {
  const startedAtMs = performance.now()
  return {
    top: {
      currentSeconds: currentSeconds.top,
      playbackRate: normalizePlaybackRate(snapshots.top.playbackRate),
      playbackActive,
      startedAtMs
    },
    bottom: {
      currentSeconds: currentSeconds.bottom,
      playbackRate: normalizePlaybackRate(snapshots.bottom.playbackRate),
      playbackActive,
      startedAtMs
    }
  }
}

export const commitHorizontalBrowseLinkedDragRelease = async ({
  deck,
  otherDeck,
  targetSec,
  otherTargetSec,
  shouldResume,
  prepareDeckPlayheadIfNeeded,
  startDeckRenderPlaybackClock,
  commitDeckStatesToNative,
  stopIfStale
}: LinkedDragReleaseCommitParams) => {
  const nowMs = performance.now()
  const baseOverrides = buildLinkedDragReleaseOverrides(
    deck,
    targetSec,
    otherTargetSec,
    nowMs,
    false
  )
  await commitDeckStatesToNative(baseOverrides, { allowPhaseAlignment: false })
  if (stopIfStale('after-batch-seek-token-mismatch')) {
    return { committed: false, targetSec, otherTargetSec }
  }
  if (!shouldResume) return { committed: true, targetSec, otherTargetSec }
  const playheadReadyPromise = Promise.all([
    prepareDeckPlayheadIfNeeded(deck),
    prepareDeckPlayheadIfNeeded(otherDeck)
  ])
    .then(() => true)
    .catch(() => false)
  if (stopIfStale('after-visual-frame-token-mismatch')) {
    return { committed: false, targetSec, otherTargetSec }
  }
  const playheadReady = await playheadReadyPromise
  if (stopIfStale('after-prepare-playhead-token-mismatch')) {
    return { committed: false, targetSec, otherTargetSec }
  }
  const resumeObservedAtMs = performance.now()
  const resumeOverrides = buildLinkedDragReleaseOverrides(
    deck,
    targetSec,
    otherTargetSec,
    resumeObservedAtMs,
    true
  )
  startDeckRenderPlaybackClock(deck, targetSec)
  startDeckRenderPlaybackClock(otherDeck, otherTargetSec)
  await commitDeckStatesToNative(resumeOverrides, { allowPhaseAlignment: false })
  void playheadReady
  const committed = !stopIfStale('after-batch-commit-token-mismatch')
  return { committed, targetSec, otherTargetSec }
}

export const commitHorizontalBrowseBoundaryLinkedDragRelease = async ({
  deck,
  otherDeck,
  targetSec,
  otherTargetSec,
  shouldResume,
  boundaryReferenceDeck,
  finalLeaderDeck,
  setLeader,
  alignToLeader,
  resolveTransportDeckSnapshot,
  commitLinkedGridVisualTransaction,
  prepareDeckPlayheadIfNeeded,
  startDeckRenderPlaybackClock,
  commitDeckStatesToNative,
  stopIfStale
}: BoundaryLinkedDragReleaseCommitParams): Promise<LinkedDragReleaseCommitResult> => {
  const nowMs = performance.now()
  const baseOverrides = buildLinkedDragReleaseOverrides(
    deck,
    targetSec,
    otherTargetSec,
    nowMs,
    false
  )
  await commitDeckStatesToNative(baseOverrides, {
    allowPhaseAlignment: false,
    notifySnapshotListeners: false,
    syncRenderState: false
  })
  if (stopIfStale('after-boundary-batch-seek-token-mismatch')) {
    return { committed: false, targetSec, otherTargetSec }
  }
  await setLeader(boundaryReferenceDeck, { notifySnapshotListeners: false })
  if (stopIfStale('after-boundary-leader-token-mismatch')) {
    return { committed: false, targetSec, otherTargetSec }
  }
  await alignToLeader(deck, targetSec, false, { notifySnapshotListeners: false })
  const alignedSourceSnapshot = resolveTransportDeckSnapshot(deck)
  const alignedOtherSnapshot = resolveTransportDeckSnapshot(otherDeck)
  const alignedTargetSec = resolveSnapshotCurrentSeconds(alignedSourceSnapshot, targetSec)
  const alignedOtherTargetSec = resolveSnapshotCurrentSeconds(alignedOtherSnapshot, otherTargetSec)
  const alignedPlaybackRates: Partial<Record<DeckKey, number>> = {
    [deck]: normalizePlaybackRate(alignedSourceSnapshot.playbackRate),
    [otherDeck]: normalizePlaybackRate(alignedOtherSnapshot.playbackRate)
  }
  if (stopIfStale('after-boundary-align-token-mismatch')) {
    return { committed: false, targetSec: alignedTargetSec, otherTargetSec: alignedOtherTargetSec }
  }
  if (finalLeaderDeck && finalLeaderDeck !== boundaryReferenceDeck) {
    await setLeader(finalLeaderDeck, { notifySnapshotListeners: false })
    if (stopIfStale('after-boundary-restore-leader-token-mismatch')) {
      return {
        committed: false,
        targetSec: alignedTargetSec,
        otherTargetSec: alignedOtherTargetSec
      }
    }
  }
  await commitLinkedGridVisualTransaction?.(
    {
      leader: boundaryReferenceDeck,
      follower: deck,
      mode: 'linked',
      deckStates: buildLinkedGridVisualTransactionDeckStates(
        {
          top: resolveTransportDeckSnapshot('top'),
          bottom: resolveTransportDeckSnapshot('bottom')
        },
        {
          top: resolveDeckTargetSec('top', deck, alignedTargetSec, alignedOtherTargetSec),
          bottom: resolveDeckTargetSec('bottom', deck, alignedTargetSec, alignedOtherTargetSec)
        },
        false
      )
    },
    { begin: false }
  )
  if (stopIfStale('after-boundary-visual-transaction-token-mismatch')) {
    return { committed: false, targetSec: alignedTargetSec, otherTargetSec: alignedOtherTargetSec }
  }
  const alignedObservedAtMs = performance.now()
  const alignedOverrides = buildLinkedDragReleaseOverrides(
    deck,
    alignedTargetSec,
    alignedOtherTargetSec,
    alignedObservedAtMs,
    false,
    alignedPlaybackRates
  )
  await commitDeckStatesToNative(alignedOverrides, { allowPhaseAlignment: false })
  if (stopIfStale('after-boundary-aligned-commit-token-mismatch')) {
    return { committed: false, targetSec: alignedTargetSec, otherTargetSec: alignedOtherTargetSec }
  }
  if (!shouldResume) {
    return { committed: true, targetSec: alignedTargetSec, otherTargetSec: alignedOtherTargetSec }
  }
  const playheadReadyPromise = Promise.all([
    prepareDeckPlayheadIfNeeded(deck),
    prepareDeckPlayheadIfNeeded(otherDeck)
  ])
    .then(() => true)
    .catch(() => false)
  if (stopIfStale('after-boundary-visual-frame-token-mismatch')) {
    return { committed: false, targetSec: alignedTargetSec, otherTargetSec: alignedOtherTargetSec }
  }
  const playheadReady = await playheadReadyPromise
  if (stopIfStale('after-boundary-prepare-playhead-token-mismatch')) {
    return { committed: false, targetSec: alignedTargetSec, otherTargetSec: alignedOtherTargetSec }
  }
  const resumeObservedAtMs = performance.now()
  const resumeOverrides = buildLinkedDragReleaseOverrides(
    deck,
    alignedTargetSec,
    alignedOtherTargetSec,
    resumeObservedAtMs,
    true,
    alignedPlaybackRates
  )
  startDeckRenderPlaybackClock(deck, alignedTargetSec)
  startDeckRenderPlaybackClock(otherDeck, alignedOtherTargetSec)
  await commitDeckStatesToNative(resumeOverrides, { allowPhaseAlignment: false })
  void playheadReady
  const committed = !stopIfStale('after-boundary-batch-commit-token-mismatch')
  return { committed, targetSec: alignedTargetSec, otherTargetSec: alignedOtherTargetSec }
}
