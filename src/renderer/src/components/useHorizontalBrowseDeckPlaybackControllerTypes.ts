import type { ISongInfo, ISongMemoryCue } from 'src/types/globals'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/components/horizontalBrowseNativeTransport'
import type { HorizontalBrowseLoopRange } from '@renderer/components/useHorizontalBrowseDeckLoopController'
import type { HorizontalBrowseRenderSyncOptions } from '@renderer/components/useHorizontalBrowseRenderSync'
import type { HorizontalBrowsePendingPlayViewMode } from '@renderer/components/horizontalBrowsePendingPlayDiagnostics'
import type { CommitHorizontalBrowseDeckStatesToNative } from '@renderer/components/horizontalBrowseLinkedDragReleaseCommit'
import type { HorizontalBrowseBeatSyncDragReleaseVisualTransactionHooks } from '@renderer/components/horizontalBrowseBeatSyncRawWaveformDragRelease'

type DeckKey = HorizontalBrowseDeckKey

export type UseHorizontalBrowseDeckPlaybackControllerParams =
  HorizontalBrowseBeatSyncDragReleaseVisualTransactionHooks & {
    touchDeckInteraction: (deck: DeckKey) => void
    notifyDeckSeekIntent: (deck: DeckKey, seconds: number) => void
    holdDeckRenderCurrentSeconds: (deck: DeckKey, seconds: number) => void
    startDeckRenderPlaybackClock: (deck: DeckKey, seconds: number) => void
    prepareDeckStableFrameForAnchor?: (
      deck: DeckKey,
      seconds: number,
      options?: { timeoutMs?: number }
    ) => Promise<boolean>
    nativeTransport: {
      setPlaying: (deck: DeckKey, playing: boolean) => Promise<unknown>
      setLeader: (deck?: DeckKey | null) => Promise<unknown>
      preparePlayhead: (deck: DeckKey) => Promise<unknown>
      seek: (deck: DeckKey, currentSec: number) => Promise<unknown>
      setScrubPreview: (
        deck: DeckKey,
        active: boolean,
        currentSec: number,
        rate: number
      ) => Promise<unknown>
      beatsync: (deck: DeckKey) => Promise<unknown>
      alignToLeader: (deck: DeckKey, targetSec?: number, skipGridSnap?: boolean) => Promise<unknown>
      setSyncEnabled: (deck: DeckKey, enabled: boolean) => Promise<unknown>
      snapshot: (nowMs?: number) => Promise<unknown>
    }
    syncDeckRenderState: (input?: number | HorizontalBrowseRenderSyncOptions) => void
    commitDeckStatesToNative: CommitHorizontalBrowseDeckStatesToNative
    resolveDeckSong: (deck: DeckKey) => ISongInfo | null
    resolveDeckGridBpm: (deck: DeckKey) => number
    resolveDeckDurationSeconds: (deck: DeckKey) => number
    resolveDeckCurrentSeconds: (deck: DeckKey) => number
    resolveDeckRenderCurrentSeconds: (deck: DeckKey) => number
    resolveDeckPlaying: (deck: DeckKey) => boolean
    resolveDeckLoaded: (deck: DeckKey) => boolean
    resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
    isDeckLoopActive: (deck: DeckKey) => boolean
    syncDeckIntoLoopRangeBeforePlay: (deck: DeckKey) => Promise<void>
    applyDeckStoredCueDefinition: (
      deck: DeckKey,
      cue: Pick<ISongMemoryCue, 'sec' | 'isLoop' | 'loopEndSec' | 'source'>
    ) => Promise<HorizontalBrowseLoopRange | null>
    resolveDualTransportSyncEnabled?: () => boolean
    ensureDualTransportSync?: (sourceDeck?: DeckKey) => Promise<boolean>
    deactivateDualTransportSync?: () => void
    resolveBrowseViewMode?: () => HorizontalBrowsePendingPlayViewMode
  }
