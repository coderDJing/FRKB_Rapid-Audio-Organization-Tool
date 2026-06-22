import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'
import type {
  DeckWaveformDragEndPayload,
  DeckWaveformDragState
} from '@renderer/components/horizontalBrowseDeckPlaybackState'
import {
  commitHorizontalBrowseLinkedDragRelease,
  type CommitHorizontalBrowseDeckStatesToNative
} from '@renderer/components/horizontalBrowseLinkedDragReleaseCommit'

type DeckKey = HorizontalBrowseDeckKey

type LinkedDragDelta = {
  otherTargetSec: number
  expectedOtherDeltaSec: number
  deltaScale: number
  sourceVisualPlaybackRate: number
  otherVisualPlaybackRate: number
}

type LinkedRawWaveformDragEndParams = {
  deck: DeckKey
  payload: DeckWaveformDragEndPayload
  resolveOtherDeck: (deck: DeckKey) => DeckKey
  resolveDeckDragState: (deck: DeckKey) => DeckWaveformDragState
  resolveDeckLeader: (deck: DeckKey) => boolean
  clampDeckTimelineSeconds: (deck: DeckKey, seconds: number) => number
  resolveLinkedDragDelta: (deck: DeckKey, otherDeck: DeckKey, targetSec: number) => LinkedDragDelta
  finishDeckWaveformDragState: (
    deck: DeckKey,
    targetSec: number
  ) => {
    shouldResume: boolean
    pausePromise: Promise<void> | null
    token: number
  }
  notifyDeckSeekIntent: (deck: DeckKey, seconds: number) => void
  setLeader: (deck?: DeckKey | null) => Promise<unknown>
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
  clampDeckTimelineSeconds,
  resolveLinkedDragDelta,
  finishDeckWaveformDragState,
  notifyDeckSeekIntent,
  setLeader,
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
  const targetSec = clampDeckTimelineSeconds(deck, Number(payload.anchorSec) || 0)
  const linkedDelta = resolveLinkedDragDelta(deck, otherDeck, targetSec)
  const otherTargetSec = linkedDelta.otherTargetSec
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
  const stopIfStale = (_reason: string) =>
    resolveDeckDragState(deck).token !== sourceFinish.token ||
    resolveDeckDragState(otherDeck).token !== otherFinish.token
  void (async () => {
    await sourceFinish.pausePromise
    await otherFinish.pausePromise
    if (stopIfStale('after-pause-token-mismatch')) return
    if (releaseLeaderDeck) await setLeader(releaseLeaderDeck)
    const committed = await commitHorizontalBrowseLinkedDragRelease({
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
    void committed
  })().catch(() => undefined)
  return true
}
