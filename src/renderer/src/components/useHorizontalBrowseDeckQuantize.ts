import { reactive } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'
import { resolveNearestHotCueGridSec } from '@shared/hotCues'

type DeckKey = HorizontalBrowseDeckKey

type UseHorizontalBrowseDeckQuantizeParams = {
  resolveDeckPlaying: (deck: DeckKey) => boolean
  resolveDeckCurrentSeconds: (deck: DeckKey) => number
  resolveDeckRenderCurrentSeconds: (deck: DeckKey) => number
  resolveDeckDurationSeconds: (deck: DeckKey) => number
  resolveDeckGridBpm: (deck: DeckKey) => number
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  resolveCuePointSec: (song: ISongInfo | null, currentSec: number, durationSec: number) => number
}

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export const useHorizontalBrowseDeckQuantize = (params: UseHorizontalBrowseDeckQuantizeParams) => {
  const deckQuantizeEnabled = reactive<Record<DeckKey, boolean>>({
    top: true,
    bottom: true
  })

  const resolveDeckAnchorSeconds = (deck: DeckKey) =>
    params.resolveDeckPlaying(deck)
      ? params.resolveDeckRenderCurrentSeconds(deck)
      : params.resolveDeckCurrentSeconds(deck)

  const resolveDeckUnquantizedSec = (deck: DeckKey) => {
    const durationSec = params.resolveDeckDurationSeconds(deck)
    const anchorSec = Number(resolveDeckAnchorSeconds(deck)) || 0
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      return Math.max(0, Number(anchorSec.toFixed(3)))
    }
    return Number(clampNumber(anchorSec, 0, durationSec).toFixed(3))
  }

  const resolveDeckCuePlacementSec = (deck: DeckKey) => {
    if (!deckQuantizeEnabled[deck]) {
      return resolveDeckUnquantizedSec(deck)
    }
    return params.resolveCuePointSec(
      params.resolveDeckSong(deck),
      Number(resolveDeckAnchorSeconds(deck)) || 0,
      params.resolveDeckDurationSeconds(deck)
    )
  }

  const resolveDeckMarkerPlacementSec = (deck: DeckKey) => {
    if (!deckQuantizeEnabled[deck]) {
      return resolveDeckUnquantizedSec(deck)
    }
    return resolveNearestHotCueGridSec({
      currentSec: resolveDeckAnchorSeconds(deck),
      durationSec: params.resolveDeckDurationSeconds(deck),
      bpm: params.resolveDeckGridBpm(deck),
      firstBeatMs: params.resolveDeckSong(deck)?.firstBeatMs
    })
  }

  const toggleDeckQuantize = (deck: DeckKey) => {
    deckQuantizeEnabled[deck] = !deckQuantizeEnabled[deck]
  }

  return {
    deckQuantizeEnabled,
    toggleDeckQuantize,
    resolveDeckCuePlacementSec,
    resolveDeckMarkerPlacementSec
  }
}
