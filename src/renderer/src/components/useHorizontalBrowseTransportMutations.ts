import type { ISongInfo } from 'src/types/globals'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@shared/horizontalBrowseTransport'
import type { HorizontalBrowseRenderSyncOptions } from '@renderer/components/useHorizontalBrowseRenderSync'

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

type UseHorizontalBrowseTransportMutationsParams = {
  touchDeckInteraction: (deck: DeckKey) => void
  nativeTransport: {
    setDeckState: (deck: DeckKey, payload: LocalDeckState) => Promise<unknown>
    setState: (payload: { top: LocalDeckState; bottom: LocalDeckState }) => Promise<unknown>
    setLeader: (deck?: DeckKey | null) => Promise<unknown>
    setSyncEnabled: (deck: DeckKey, enabled: boolean) => Promise<unknown>
    alignToLeader: (deck: DeckKey, targetSec?: number) => Promise<unknown>
    snapshot: (nowMs?: number) => Promise<unknown>
  }
  syncDeckRenderState: (input?: number | HorizontalBrowseRenderSyncOptions) => void
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

  const commitDeckStateToNative = async (
    deck: DeckKey,
    override?: HorizontalBrowseDeckTransportStateOverride
  ) => {
    await params.nativeTransport.setDeckState(deck, buildDeckStateForNative(deck, override))
    params.syncDeckRenderState({ force: deck })
  }

  const commitDeckStatesToNative = async (
    overrides?: Partial<Record<DeckKey, HorizontalBrowseDeckTransportStateOverride>>
  ) => {
    await params.nativeTransport.setState({
      top: buildDeckStateForNative('top', overrides?.top),
      bottom: buildDeckStateForNative('bottom', overrides?.bottom)
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
      params.syncDeckRenderState({ force: deck })
      return
    }
    const anchorSec = Number(snapshot.currentSec)
    await params.nativeTransport.alignToLeader(
      deck,
      Number.isFinite(anchorSec) ? Math.max(0, anchorSec) : undefined
    )
    params.syncDeckRenderState({ force: 'all' })
  }

  return {
    buildDeckStateForNative,
    commitDeckStateToNative,
    commitDeckStatesToNative,
    toggleDeckMaster,
    triggerDeckBeatSync
  }
}
