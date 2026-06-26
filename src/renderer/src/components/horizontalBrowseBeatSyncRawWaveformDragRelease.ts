import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/components/horizontalBrowseNativeTransport'
import type { HorizontalBrowseBeatSyncDecks } from '@renderer/components/horizontalBrowseBeatSyncDecks'
import type { HorizontalBrowseRenderSyncOptions } from '@renderer/components/useHorizontalBrowseRenderSync'
import type {
  HorizontalBrowseLinkedGridVisualTransactionDeckState,
  HorizontalBrowseLinkedGridVisualTransactionMode
} from '@renderer/components/horizontalBrowseLinkedGridVisualTransaction'

type DeckKey = HorizontalBrowseDeckKey

type BeatSyncVisualTransactionPayload = {
  leader: DeckKey
  follower: DeckKey
  mode: 'beatsync'
}

export type HorizontalBrowseBeatSyncDragReleaseVisualTransactionHooks = {
  commitLinkedGridVisualTransaction?: (
    payload: {
      leader: DeckKey
      follower: DeckKey
      mode?: HorizontalBrowseLinkedGridVisualTransactionMode
      deckStates?: Partial<Record<DeckKey, HorizontalBrowseLinkedGridVisualTransactionDeckState>>
    },
    options?: { begin?: boolean }
  ) => Promise<boolean> | boolean
  beginLinkedGridVisualTransaction?: (payload: {
    leader: DeckKey
    follower: DeckKey
    mode?: HorizontalBrowseLinkedGridVisualTransactionMode
  }) => void
  cancelLinkedGridVisualTransaction?: (payload: {
    leader: DeckKey
    follower: DeckKey
    mode?: HorizontalBrowseLinkedGridVisualTransactionMode
  }) => void
}

type StartBeatSyncRawWaveformDragReleaseParams =
  HorizontalBrowseBeatSyncDragReleaseVisualTransactionHooks & {
    deck: DeckKey
    targetSec: number
    token: number
    shouldResume: boolean
    pausePromise: Promise<void> | null
    activeSyncDecks: HorizontalBrowseBeatSyncDecks | null
    resolveDeckWaveformDragToken: (deck: DeckKey) => number
    resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
    setLeader: (deck?: DeckKey | null) => Promise<unknown>
    setSyncEnabled: (deck: DeckKey, enabled: boolean) => Promise<unknown>
    alignToLeader: (deck: DeckKey, targetSec?: number, skipGridSnap?: boolean) => Promise<unknown>
    syncDeckRenderState: (input?: number | HorizontalBrowseRenderSyncOptions) => void
    resumeDeckPlaybackAfterSeek: (deck: DeckKey) => Promise<void>
  }

const resolveSnapshotCurrentSeconds = (snapshot: HorizontalBrowseTransportDeckSnapshot) => {
  const currentSec = Number(snapshot.currentSec)
  if (Number.isFinite(currentSec)) return currentSec
  const renderCurrentSec = Number(snapshot.renderCurrentSec)
  return Number.isFinite(renderCurrentSec) ? renderCurrentSec : 0
}

const normalizePlaybackRate = (value: unknown) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.max(0.25, numeric) : 1
}

const resolveBeatSyncVisualTransaction = (
  deck: DeckKey,
  activeSyncDecks: HorizontalBrowseBeatSyncDecks | null
): BeatSyncVisualTransactionPayload | null => {
  if (!activeSyncDecks) return null
  if (activeSyncDecks.leader === deck) {
    return {
      leader: activeSyncDecks.follower,
      follower: deck,
      mode: 'beatsync'
    }
  }
  return {
    leader: activeSyncDecks.leader,
    follower: activeSyncDecks.follower,
    mode: 'beatsync'
  }
}

const buildDeckState = (
  params: Pick<StartBeatSyncRawWaveformDragReleaseParams, 'resolveTransportDeckSnapshot'>,
  deck: DeckKey,
  startedAtMs: number,
  currentSecondsOverride?: number
): HorizontalBrowseLinkedGridVisualTransactionDeckState => {
  const snapshot = params.resolveTransportDeckSnapshot(deck)
  const overrideSeconds = Number(currentSecondsOverride)
  return {
    currentSeconds: Number.isFinite(overrideSeconds)
      ? overrideSeconds
      : resolveSnapshotCurrentSeconds(snapshot),
    playbackRate: normalizePlaybackRate(snapshot.playbackRate),
    playbackActive: snapshot.playing === true || snapshot.playingAudible === true,
    startedAtMs
  }
}

const buildDeckStates = (
  params: Pick<StartBeatSyncRawWaveformDragReleaseParams, 'resolveTransportDeckSnapshot'>,
  overrideDeck: DeckKey,
  overrideCurrentSeconds: number
): Partial<Record<DeckKey, HorizontalBrowseLinkedGridVisualTransactionDeckState>> => {
  const startedAtMs = performance.now()
  return {
    top: buildDeckState(
      params,
      'top',
      startedAtMs,
      overrideDeck === 'top' ? overrideCurrentSeconds : undefined
    ),
    bottom: buildDeckState(
      params,
      'bottom',
      startedAtMs,
      overrideDeck === 'bottom' ? overrideCurrentSeconds : undefined
    )
  }
}

const isCurrentDragToken = (
  params: Pick<
    StartBeatSyncRawWaveformDragReleaseParams,
    'deck' | 'token' | 'resolveDeckWaveformDragToken'
  >
) => params.resolveDeckWaveformDragToken(params.deck) === params.token

export const startHorizontalBrowseBeatSyncRawWaveformDragRelease = (
  params: StartBeatSyncRawWaveformDragReleaseParams
) => {
  const visualTransaction = resolveBeatSyncVisualTransaction(params.deck, params.activeSyncDecks)
  const beginLinkedGridVisualTransaction = params.beginLinkedGridVisualTransaction
  const commitLinkedGridVisualTransaction = params.commitLinkedGridVisualTransaction
  if (
    !visualTransaction ||
    !beginLinkedGridVisualTransaction ||
    !commitLinkedGridVisualTransaction
  ) {
    return null
  }

  beginLinkedGridVisualTransaction(visualTransaction)

  return (async () => {
    let visualTransactionClosed = false
    try {
      if (params.pausePromise) {
        await params.pausePromise
        if (!isCurrentDragToken(params)) return
      }

      if (params.activeSyncDecks?.leader === params.deck) {
        await params.setSyncEnabled(params.activeSyncDecks.follower, false)
        if (!isCurrentDragToken(params)) return
        await params.setLeader(params.activeSyncDecks.follower)
      }
      await params.alignToLeader(params.deck, params.targetSec, false)
      if (!isCurrentDragToken(params)) return

      const alignedSnapshot = params.resolveTransportDeckSnapshot(params.deck)
      const alignedTargetSec = Number.isFinite(Number(alignedSnapshot.currentSec))
        ? Number(alignedSnapshot.currentSec)
        : params.targetSec

      await commitLinkedGridVisualTransaction(
        {
          ...visualTransaction,
          deckStates: buildDeckStates(params, params.deck, alignedTargetSec)
        },
        { begin: false }
      )
      visualTransactionClosed = true

      if (params.shouldResume) {
        await params.resumeDeckPlaybackAfterSeek(params.deck)
        if (!isCurrentDragToken(params)) return
      }

      params.syncDeckRenderState()
    } finally {
      if (!visualTransactionClosed) {
        params.cancelLinkedGridVisualTransaction?.(visualTransaction)
      }
    }
  })()
}
