import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/components/horizontalBrowseNativeTransport'
import type {
  DeckWaveformDragEndPayload,
  DeckWaveformDragState
} from '@renderer/components/horizontalBrowseDeckPlaybackState'
import {
  commitHorizontalBrowseBoundaryLinkedDragRelease,
  commitHorizontalBrowseLinkedDragRelease,
  type CommitHorizontalBrowseDeckStatesToNative
} from '@renderer/components/horizontalBrowseLinkedDragReleaseCommit'
import type { HorizontalBrowseLinkedDragTargets } from '@renderer/components/horizontalBrowseLinkedDragTargets'
import type {
  HorizontalBrowseLinkedGridVisualTransactionDeckState,
  HorizontalBrowseLinkedGridVisualTransactionMode
} from '@renderer/components/horizontalBrowseLinkedGridVisualTransaction'

type DeckKey = HorizontalBrowseDeckKey

type LinkedRawWaveformDragEndParams = {
  deck: DeckKey
  payload: DeckWaveformDragEndPayload
  resolveOtherDeck: (deck: DeckKey) => DeckKey
  resolveDeckDragState: (deck: DeckKey) => DeckWaveformDragState
  resolveDeckLeader: (deck: DeckKey) => boolean
  resolveLinkedDragDelta: (
    deck: DeckKey,
    otherDeck: DeckKey,
    targetSec: number
  ) => HorizontalBrowseLinkedDragTargets
  finishDeckWaveformDragState: (
    deck: DeckKey,
    targetSec: number
  ) => {
    shouldResume: boolean
    pausePromise: Promise<void> | null
    token: number
  }
  notifyDeckSeekIntent: (deck: DeckKey, seconds: number) => void
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
  prepareDeckPlayheadIfNeeded: (deck: DeckKey) => Promise<void>
  startDeckRenderPlaybackClock: (deck: DeckKey, seconds: number) => void
  commitDeckStatesToNative: CommitHorizontalBrowseDeckStatesToNative
}

export const handleHorizontalBrowseLinkedRawWaveformDragEnd = ({
  deck,
  payload,
  resolveOtherDeck,
  resolveDeckDragState,
  resolveDeckLeader,
  resolveLinkedDragDelta,
  finishDeckWaveformDragState,
  notifyDeckSeekIntent,
  setLeader,
  alignToLeader,
  resolveTransportDeckSnapshot,
  commitLinkedGridVisualTransaction,
  prepareDeckPlayheadIfNeeded,
  startDeckRenderPlaybackClock,
  commitDeckStatesToNative
}: LinkedRawWaveformDragEndParams) => {
  const otherDeck = resolveOtherDeck(deck)
  const dragState = resolveDeckDragState(deck)
  const otherDragState = resolveDeckDragState(otherDeck)
  if (!dragState.active || !otherDragState.active) return false
  const sourceStartSec = dragState.startAnchorSec
  const otherStartSec = otherDragState.startAnchorSec
  const releaseLeaderDeck = resolveDeckLeader(deck)
    ? deck
    : resolveDeckLeader(otherDeck)
      ? otherDeck
      : null
  const linkedDelta = resolveLinkedDragDelta(deck, otherDeck, Number(payload.anchorSec) || 0)
  const targetSec = linkedDelta.sourceTargetSec
  const otherTargetSec = linkedDelta.otherTargetSec
  const shouldSnapSourceToBoundaryReference = linkedDelta.otherBoundary !== 'none'
  const sourceFinish = finishDeckWaveformDragState(deck, targetSec)
  const otherFinish = finishDeckWaveformDragState(otherDeck, otherTargetSec)
  if (!payload?.committed) {
    notifyDeckSeekIntent(deck, sourceStartSec)
    notifyDeckSeekIntent(otherDeck, otherStartSec)
    return true
  }
  const shouldResume = sourceFinish.shouldResume || otherFinish.shouldResume
  notifyDeckSeekIntent(deck, targetSec)
  notifyDeckSeekIntent(otherDeck, otherTargetSec)
  const stopIfStale = (_reason: string) => {
    const sourceToken = resolveDeckDragState(deck).token
    const otherToken = resolveDeckDragState(otherDeck).token
    return sourceToken !== sourceFinish.token || otherToken !== otherFinish.token
  }
  void (async () => {
    await sourceFinish.pausePromise
    await otherFinish.pausePromise
    if (stopIfStale('after-pause-token-mismatch')) return
    const committed = shouldSnapSourceToBoundaryReference
      ? await commitHorizontalBrowseBoundaryLinkedDragRelease({
          deck,
          otherDeck,
          targetSec,
          otherTargetSec,
          shouldResume,
          boundaryReferenceDeck: otherDeck,
          finalLeaderDeck: releaseLeaderDeck,
          setLeader,
          alignToLeader,
          resolveTransportDeckSnapshot,
          commitLinkedGridVisualTransaction,
          prepareDeckPlayheadIfNeeded,
          startDeckRenderPlaybackClock,
          commitDeckStatesToNative,
          stopIfStale
        })
      : await (async () => {
          if (releaseLeaderDeck) await setLeader(releaseLeaderDeck)
          return commitHorizontalBrowseLinkedDragRelease({
            deck,
            otherDeck,
            targetSec,
            otherTargetSec,
            shouldResume,
            prepareDeckPlayheadIfNeeded,
            startDeckRenderPlaybackClock,
            commitDeckStatesToNative,
            stopIfStale
          })
        })()
    void committed
  })().catch(() => undefined)
  return true
}
