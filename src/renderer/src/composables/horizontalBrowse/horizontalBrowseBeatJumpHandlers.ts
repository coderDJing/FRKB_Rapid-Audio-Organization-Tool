import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import type { ISongInfo } from 'src/types/globals'
import { resolveSongBeatGridBeatJumpSec } from '@shared/songBeatGridMap'

type DeckKey = HorizontalBrowseDeckKey

const BAR_JUMP_BEATS = 4
const PHRASE_JUMP_BEATS = 32

export const createHorizontalBrowseBeatJumpHandlers = (params: {
  resolveDeckGridBpm: (deck: DeckKey) => number | null | undefined
  resolveDeckCurrentSeconds: (deck: DeckKey) => number
  resolveDeckDurationSeconds: (deck: DeckKey) => number
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  seekDeckToSeconds: (deck: DeckKey, seconds: number, source: 'transport') => void
}) => {
  const jumpDeckByBeatCount = (deck: DeckKey, direction: -1 | 1, beatCount: number) => {
    const currentSec = params.resolveDeckCurrentSeconds(deck)
    const dynamicTargetSec = resolveSongBeatGridBeatJumpSec(
      params.resolveDeckSong(deck)?.beatGridMap,
      params.resolveDeckDurationSeconds(deck),
      currentSec,
      beatCount * direction
    )
    if (dynamicTargetSec !== null) {
      params.seekDeckToSeconds(deck, dynamicTargetSec, 'transport')
      return
    }
    const gridBpm = Number(params.resolveDeckGridBpm(deck))
    if (!Number.isFinite(gridBpm) || gridBpm <= 0) return
    const deltaSeconds = (60 / gridBpm) * beatCount * direction
    params.seekDeckToSeconds(deck, currentSec + deltaSeconds, 'transport')
  }

  return {
    handleDeckBarJump: (deck: DeckKey, direction: -1 | 1) =>
      jumpDeckByBeatCount(deck, direction, BAR_JUMP_BEATS),
    handleDeckPhraseJump: (deck: DeckKey, direction: -1 | 1) =>
      jumpDeckByBeatCount(deck, direction, PHRASE_JUMP_BEATS),
    handleDeckBeatJump: jumpDeckByBeatCount
  }
}
