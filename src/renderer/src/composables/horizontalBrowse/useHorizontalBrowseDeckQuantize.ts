import { reactive } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
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

  const resolveDeckAnchorSeconds = (deck: DeckKey, anchorOverrideSec?: number | null) => {
    if (anchorOverrideSec != null) {
      const overrideSec = Number(anchorOverrideSec)
      if (Number.isFinite(overrideSec)) return overrideSec
    }
    return params.resolveDeckPlaying(deck)
      ? params.resolveDeckRenderCurrentSeconds(deck)
      : params.resolveDeckCurrentSeconds(deck)
  }

  const resolveDeckUnquantizedSec = (deck: DeckKey, anchorOverrideSec?: number | null) => {
    const durationSec = params.resolveDeckDurationSeconds(deck)
    const anchorSec = Number(resolveDeckAnchorSeconds(deck, anchorOverrideSec)) || 0
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      return Math.max(0, Number(anchorSec.toFixed(3)))
    }
    return Number(clampNumber(anchorSec, 0, durationSec).toFixed(3))
  }

  const resolveDeckCuePlacementSec = (deck: DeckKey, anchorOverrideSec?: number | null) => {
    if (!deckQuantizeEnabled[deck]) {
      return resolveDeckUnquantizedSec(deck, anchorOverrideSec)
    }
    const song = params.resolveDeckSong(deck)
    const gridBpm = params.resolveDeckGridBpm(deck)
    const anchorSec = Number(resolveDeckAnchorSeconds(deck, anchorOverrideSec)) || 0
    const durationSec = params.resolveDeckDurationSeconds(deck)
    const gridSong =
      song && Number.isFinite(gridBpm) && gridBpm > 0
        ? {
            ...song,
            bpm: gridBpm
          }
        : song
    return params.resolveCuePointSec(gridSong, anchorSec, durationSec)
  }

  const resolveDeckMarkerPlacementSec = (deck: DeckKey, anchorOverrideSec?: number | null) => {
    if (!deckQuantizeEnabled[deck]) {
      return resolveDeckUnquantizedSec(deck, anchorOverrideSec)
    }
    const song = params.resolveDeckSong(deck)
    const anchorSec = resolveDeckAnchorSeconds(deck, anchorOverrideSec)
    const durationSec = params.resolveDeckDurationSeconds(deck)
    const gridBpm = params.resolveDeckGridBpm(deck)
    return resolveNearestHotCueGridSec({
      currentSec: anchorSec,
      durationSec,
      bpm: gridBpm,
      firstBeatMs: song?.firstBeatMs,
      beatGridMap: song?.beatGridMap
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
