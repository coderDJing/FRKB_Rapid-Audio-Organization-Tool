import { nextTick } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@shared/horizontalBrowseTransport'
import type { HorizontalBrowseRenderSyncOptions } from '@renderer/components/useHorizontalBrowseRenderSync'
import type { HorizontalBrowseClearLinkedPresentationState } from '@renderer/components/horizontalBrowseWaveformPresentationCoordinator'
import { resolveHorizontalBrowseBeatSyncDecks } from '@renderer/components/horizontalBrowseBeatSyncDecks'

type DeckKey = HorizontalBrowseDeckKey

export type HorizontalBrowseDeckTransportStateOverride = Partial<{
  currentSec: number
  lastObservedAtMs: number
  durationSec: number
  playing: boolean
  playbackRate: number
  masterTempoEnabled: boolean
}>

type LocalDeckState = {
  song: ISongInfo | null
  currentSec: number
  lastObservedAtMs: number
  durationSec: number
  playing: boolean
  playbackRate: number
  masterTempoEnabled: boolean
}

export type HorizontalBrowseDeckStateCommitOptions = {
  allowPhaseAlignment?: boolean
}

type UseHorizontalBrowseTransportMutationsParams = {
  touchDeckInteraction: (deck: DeckKey) => void
  nativeTransport: {
    setDeckState: (deck: DeckKey, payload: LocalDeckState) => Promise<unknown>
    setState: (payload: {
      top: LocalDeckState
      bottom: LocalDeckState
      allowPhaseAlignment?: boolean
    }) => Promise<unknown>
    setLeader: (deck?: DeckKey | null) => Promise<unknown>
    setSyncEnabled: (deck: DeckKey, enabled: boolean) => Promise<unknown>
    alignToLeader: (deck: DeckKey, targetSec?: number, skipGridSnap?: boolean) => Promise<unknown>
    snapshot: (nowMs?: number) => Promise<unknown>
  }
  syncDeckRenderState: (input?: number | HorizontalBrowseRenderSyncOptions) => void
  commitLinkedGridVisualTransaction?: (payload: {
    leader: DeckKey
    follower: DeckKey
  }) => Promise<boolean> | boolean
  clearLinkedPresentation?: (playbackStates?: HorizontalBrowseClearLinkedPresentationState) => void
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  resolveDeckCurrentSeconds: (deck: DeckKey) => number
  resolveDeckDurationSeconds: (deck: DeckKey) => number
  resolveDeckPlaying: (deck: DeckKey) => boolean
  resolveDeckPlaybackRate: (deck: DeckKey) => number
  resolveDeckMasterTempoEnabled: (deck: DeckKey) => boolean
  resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
}

export const useHorizontalBrowseTransportMutations = (
  params: UseHorizontalBrowseTransportMutationsParams
) => {
  const buildDeckStateForNative = (
    deck: DeckKey,
    override?: HorizontalBrowseDeckTransportStateOverride
  ): LocalDeckState => ({
    song: params.resolveDeckSong(deck),
    currentSec: override?.currentSec ?? params.resolveDeckCurrentSeconds(deck),
    lastObservedAtMs: override?.lastObservedAtMs ?? performance.now(),
    durationSec: override?.durationSec ?? params.resolveDeckDurationSeconds(deck),
    playing: override?.playing ?? params.resolveDeckPlaying(deck),
    playbackRate: override?.playbackRate ?? params.resolveDeckPlaybackRate(deck),
    masterTempoEnabled: override?.masterTempoEnabled ?? params.resolveDeckMasterTempoEnabled(deck)
  })

  const resolveActiveBeatSyncDecks = (deck: DeckKey) =>
    resolveHorizontalBrowseBeatSyncDecks({
      deck,
      hasDeckSong: (targetDeck) => Boolean(params.resolveDeckSong(targetDeck)),
      resolveTransportDeckSnapshot: params.resolveTransportDeckSnapshot
    })

  const buildClearLinkedPresentationPlaybackStates =
    (): HorizontalBrowseClearLinkedPresentationState => {
      const startedAtMs = performance.now()
      const buildDeckState = (deck: DeckKey) => {
        const snapshot = params.resolveTransportDeckSnapshot(deck)
        return {
          currentSec: Number(snapshot.renderCurrentSec ?? snapshot.currentSec) || 0,
          playbackRate: Math.max(0.25, Number(snapshot.playbackRate) || 1),
          playing: snapshot.playing === true,
          startedAtMs
        }
      }
      return {
        top: buildDeckState('top'),
        bottom: buildDeckState('bottom')
      }
    }

  const commitDeckStateToNative = async (
    deck: DeckKey,
    override?: HorizontalBrowseDeckTransportStateOverride
  ) => {
    await params.nativeTransport.setDeckState(deck, buildDeckStateForNative(deck, override))
    params.syncDeckRenderState({ force: deck })
  }

  const commitDeckStatesToNative = async (
    overrides?: Partial<Record<DeckKey, HorizontalBrowseDeckTransportStateOverride>>,
    options?: HorizontalBrowseDeckStateCommitOptions
  ) => {
    await params.nativeTransport.setState({
      top: buildDeckStateForNative('top', overrides?.top),
      bottom: buildDeckStateForNative('bottom', overrides?.bottom),
      allowPhaseAlignment: options?.allowPhaseAlignment !== false
    })
    params.syncDeckRenderState()
  }

  const toggleDeckMaster = async (deck: DeckKey) => {
    params.touchDeckInteraction(deck)
    await commitDeckStatesToNative()
    await params.nativeTransport.setLeader(deck)
    params.syncDeckRenderState({ force: deck })
  }

  const triggerDeckBeatSync = async (deck: DeckKey) => {
    params.touchDeckInteraction(deck)
    await params.nativeTransport.snapshot(performance.now())
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    if (snapshot.syncEnabled) {
      await params.nativeTransport.setSyncEnabled(deck, false)
      const activeSyncDecks = resolveActiveBeatSyncDecks(deck)
      if (activeSyncDecks) {
        await params.commitLinkedGridVisualTransaction?.(activeSyncDecks)
      } else {
        params.clearLinkedPresentation?.(buildClearLinkedPresentationPlaybackStates())
      }
      params.syncDeckRenderState({ force: 'all' })
      return
    }
    const anchorSec = Number(snapshot.currentSec)
    await params.nativeTransport.alignToLeader(
      deck,
      Number.isFinite(anchorSec) ? anchorSec : undefined,
      false
    )
    params.syncDeckRenderState({ force: 'all' })
    await nextTick()
    const activeSyncDecks = resolveActiveBeatSyncDecks(deck)
    if (activeSyncDecks) {
      await params.commitLinkedGridVisualTransaction?.(activeSyncDecks)
    }
  }

  return {
    buildDeckStateForNative,
    commitDeckStateToNative,
    commitDeckStatesToNative,
    toggleDeckMaster,
    triggerDeckBeatSync
  }
}
