import { watch, type Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/components/horizontalBrowseNativeTransport'
import { useHorizontalBrowseDeckCueController } from '@renderer/components/useHorizontalBrowseDeckCueController'
import { useHorizontalBrowseDeckLoopController } from '@renderer/components/useHorizontalBrowseDeckLoopController'
import { useHorizontalBrowseDeckPlaybackController } from '@renderer/components/useHorizontalBrowseDeckPlaybackController'
import type { HorizontalBrowseRenderSyncOptions } from '@renderer/components/useHorizontalBrowseRenderSync'

type DeckKey = HorizontalBrowseDeckKey

type UseHorizontalBrowseDeckTransportInteractionsParams = {
  touchDeckInteraction: (deck: DeckKey) => void
  notifyDeckSeekIntent: (deck: DeckKey, seconds: number) => void
  nativeTransport: {
    setPlaying: (deck: DeckKey, playing: boolean) => Promise<unknown>
    seek: (deck: DeckKey, currentSec: number) => Promise<unknown>
    beatsync: (deck: DeckKey) => Promise<unknown>
    setSyncEnabled: (deck: DeckKey, enabled: boolean) => Promise<unknown>
    toggleLoop: (deck: DeckKey) => Promise<unknown>
    stepLoopBeats: (deck: DeckKey, direction: -1 | 1) => Promise<unknown>
    setLoopFromRange: (deck: DeckKey, startSec: number, endSec: number) => Promise<unknown>
    clearLoop: (deck: DeckKey) => Promise<unknown>
  }
  syncDeckRenderState: (input?: number | HorizontalBrowseRenderSyncOptions) => void
  commitDeckStatesToNative: () => Promise<unknown>
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  resolveDeckGridBpm: (deck: DeckKey) => number
  resolveDeckDurationSeconds: (deck: DeckKey) => number
  resolveDeckCurrentSeconds: (deck: DeckKey) => number
  resolveDeckRenderCurrentSeconds: (deck: DeckKey) => number
  resolveDeckPlaying: (deck: DeckKey) => boolean
  resolveDeckLoaded: (deck: DeckKey) => boolean
  resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
  resolveDeckCuePointRef: (deck: DeckKey) => Ref<number>
  resolveDeckCuePlacementSec: (deck: DeckKey) => number
}

export const useHorizontalBrowseDeckTransportInteractions = (
  params: UseHorizontalBrowseDeckTransportInteractionsParams
) => {
  const {
    resolveDeckLoopRange,
    resolveDeckLoopBeatLabel,
    resolveDeckLoopDisabled,
    isDeckLoopActive,
    deactivateDeckLoop,
    toggleDeckLoopState,
    handleDeckLoopStepDown,
    handleDeckLoopStepUp,
    handleDeckLoopPlaybackTick,
    syncDeckIntoLoopRangeBeforePlay,
    buildDeckStoredCueDefinition,
    applyDeckStoredCueDefinition
  } = useHorizontalBrowseDeckLoopController({
    touchDeckInteraction: params.touchDeckInteraction,
    nativeTransport: params.nativeTransport,
    resolveDeckSong: params.resolveDeckSong,
    resolveDeckPlaying: params.resolveDeckPlaying,
    resolveTransportDeckSnapshot: params.resolveTransportDeckSnapshot,
    resolveDeckCuePointRef: params.resolveDeckCuePointRef
  })

  const {
    deckPendingCuePreviewOnLoad,
    suppressDeckCueClick,
    resolveDeckCuePreviewRuntimeState,
    handleDeckBackCue,
    handleDeckSetCueFromCurrentPosition,
    stopAllDeckCuePreview,
    handleWindowDeckCuePointerUp,
    handleDeckCuePointerDown,
    handleDeckCueClick,
    handleDeckCueHotkeyDown,
    handleDeckCueHotkeyUp,
    maybeResumePendingCuePreview,
    resetDeckCueInteractionState
  } = useHorizontalBrowseDeckCueController({
    touchDeckInteraction: params.touchDeckInteraction,
    notifyDeckSeekIntent: params.notifyDeckSeekIntent,
    nativeTransport: params.nativeTransport,
    syncDeckRenderState: params.syncDeckRenderState,
    resolveDeckSong: params.resolveDeckSong,
    resolveDeckLoaded: params.resolveDeckLoaded,
    resolveDeckPlaying: params.resolveDeckPlaying,
    resolveDeckCurrentSeconds: params.resolveDeckCurrentSeconds,
    resolveTransportDeckSnapshot: params.resolveTransportDeckSnapshot,
    resolveDeckCuePointRef: params.resolveDeckCuePointRef,
    resolveDeckCuePlacementSec: params.resolveDeckCuePlacementSec
  })

  const {
    deckPendingPlayOnLoad,
    isDeckWaveformDragging,
    handleDeckRawWaveformDragStart,
    handleDeckRawWaveformDragEnd,
    handleDeckPlayheadSeek,
    handleDeckBarJump,
    handleDeckPhraseJump,
    handleDeckSeekPercent,
    handleDeckMemoryCueRecall,
    handleDeckHotCueRecall,
    handleDeckPlayPauseToggle,
    maybeResumePendingPlay
  } = useHorizontalBrowseDeckPlaybackController({
    touchDeckInteraction: params.touchDeckInteraction,
    notifyDeckSeekIntent: params.notifyDeckSeekIntent,
    nativeTransport: params.nativeTransport,
    syncDeckRenderState: params.syncDeckRenderState,
    commitDeckStatesToNative: params.commitDeckStatesToNative,
    resolveDeckSong: params.resolveDeckSong,
    resolveDeckGridBpm: params.resolveDeckGridBpm,
    resolveDeckDurationSeconds: params.resolveDeckDurationSeconds,
    resolveDeckCurrentSeconds: params.resolveDeckCurrentSeconds,
    resolveDeckPlaying: params.resolveDeckPlaying,
    resolveDeckLoaded: params.resolveDeckLoaded,
    resolveTransportDeckSnapshot: params.resolveTransportDeckSnapshot,
    isDeckLoopActive,
    syncDeckIntoLoopRangeBeforePlay,
    applyDeckStoredCueDefinition
  })

  const handleDeckLoopToggle = (deck: DeckKey) => {
    void (async () => {
      const result = await toggleDeckLoopState(deck)
      if (result.shouldStartPlayback) {
        handleDeckPlayPauseToggle(deck)
      }
    })()
  }

  watch(
    () => [params.resolveDeckLoaded('top'), params.resolveDeckLoaded('bottom')] as const,
    ([topLoaded, bottomLoaded]) => {
      maybeResumePendingPlay('top', topLoaded)
      maybeResumePendingPlay('bottom', bottomLoaded)
      maybeResumePendingCuePreview('top', topLoaded)
      maybeResumePendingCuePreview('bottom', bottomLoaded)
    }
  )

  watch(
    () =>
      [
        params.resolveDeckSong('top')?.filePath ?? '',
        params.resolveDeckSong('bottom')?.filePath ?? ''
      ] as const,
    ([topFilePath, bottomFilePath], [previousTopFilePath, previousBottomFilePath]) => {
      if (topFilePath !== previousTopFilePath) {
        void deactivateDeckLoop('top')
        resetDeckCueInteractionState('top')
        if (!topFilePath) {
          deckPendingPlayOnLoad.top = false
        }
      }
      if (bottomFilePath !== previousBottomFilePath) {
        void deactivateDeckLoop('bottom')
        resetDeckCueInteractionState('bottom')
        if (!bottomFilePath) {
          deckPendingPlayOnLoad.bottom = false
        }
      }
    }
  )

  return {
    deckPendingPlayOnLoad,
    deckPendingCuePreviewOnLoad,
    suppressDeckCueClick,
    isDeckWaveformDragging,
    resolveDeckCuePreviewRuntimeState,
    resolveDeckLoopRange,
    resolveDeckLoopBeatLabel,
    resolveDeckLoopDisabled,
    isDeckLoopActive,
    handleDeckLoopToggle,
    handleDeckLoopStepDown,
    handleDeckLoopStepUp,
    handleDeckLoopPlaybackTick,
    handleDeckRawWaveformDragStart,
    handleDeckRawWaveformDragEnd,
    handleDeckPlayheadSeek,
    handleDeckBarJump,
    handleDeckPhraseJump,
    handleDeckSeekPercent,
    handleDeckBackCue,
    handleDeckSetCueFromCurrentPosition,
    buildDeckStoredCueDefinition,
    handleDeckMemoryCueRecall,
    handleDeckHotCueRecall,
    stopAllDeckCuePreview,
    handleWindowDeckCuePointerUp,
    handleDeckCuePointerDown,
    handleDeckCueClick,
    handleDeckCueHotkeyDown,
    handleDeckCueHotkeyUp,
    handleDeckPlayPauseToggle
  }
}
