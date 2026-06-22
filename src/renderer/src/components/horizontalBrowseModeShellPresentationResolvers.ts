import type { Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/components/horizontalBrowseNativeTransport'
import type { HorizontalBrowseGridToolbarState } from '@renderer/components/useHorizontalBrowseGridToolbar'
import { formatPreviewBpm } from '@renderer/components/MixtapeBeatAlignDialog.constants'

type DeckKey = HorizontalBrowseDeckKey

type ResolveDeckWaveformPlaybackActiveParams = {
  deck: DeckKey
  snapshot: HorizontalBrowseTransportDeckSnapshot
  topRenderCurrentSeconds: Ref<number>
  bottomRenderCurrentSeconds: Ref<number>
  negativePlaybackEpsilonSec: number
}

export const resolveHorizontalBrowseDeckWaveformPlaybackActive = ({
  deck,
  snapshot,
  topRenderCurrentSeconds,
  bottomRenderCurrentSeconds,
  negativePlaybackEpsilonSec
}: ResolveDeckWaveformPlaybackActiveParams) => {
  if (!snapshot.playing) return false
  if (snapshot.playingAudible || snapshot.playheadLoaded) return true
  const renderCurrentSec =
    deck === 'top' ? topRenderCurrentSeconds.value : bottomRenderCurrentSeconds.value
  return (
    Number(snapshot.renderCurrentSec) < -negativePlaybackEpsilonSec ||
    renderCurrentSec < -negativePlaybackEpsilonSec
  )
}

type ResolveDeckToolbarBpmInputValueParams = {
  deck: DeckKey
  toolbarState: HorizontalBrowseGridToolbarState
  deckTempoInputDirty: Record<DeckKey, boolean>
  editMode: boolean
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  resolveDeckGridBpm: (deck: DeckKey) => number
  resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
}

export const resolveHorizontalBrowseDeckToolbarBpmInputValue = ({
  deck,
  toolbarState,
  deckTempoInputDirty,
  editMode,
  resolveDeckSong,
  resolveDeckGridBpm,
  resolveTransportDeckSnapshot
}: ResolveDeckToolbarBpmInputValueParams) => {
  if (deckTempoInputDirty[deck]) {
    return toolbarState.bpmInputValue
  }
  if (editMode) {
    const songBpm = Number(resolveDeckSong(deck)?.bpm)
    if (Number.isFinite(songBpm) && songBpm > 0) {
      return formatPreviewBpm(songBpm)
    }
    const baseGridBpm = Number(resolveDeckGridBpm(deck))
    if (Number.isFinite(baseGridBpm) && baseGridBpm > 0) {
      return formatPreviewBpm(baseGridBpm)
    }
    return toolbarState.bpmInputValue
  }
  const effectiveBpm = Number(resolveTransportDeckSnapshot(deck).effectiveBpm)
  if (Number.isFinite(effectiveBpm) && effectiveBpm > 0) {
    return formatPreviewBpm(effectiveBpm)
  }
  const baseGridBpm = Number(resolveDeckGridBpm(deck))
  if (Number.isFinite(baseGridBpm) && baseGridBpm > 0) {
    return formatPreviewBpm(baseGridBpm)
  }
  return toolbarState.bpmInputValue
}
