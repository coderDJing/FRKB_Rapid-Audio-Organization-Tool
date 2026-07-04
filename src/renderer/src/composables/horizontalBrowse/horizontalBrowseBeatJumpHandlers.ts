import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'

type DeckKey = HorizontalBrowseDeckKey

const BAR_JUMP_BEATS = 4
const PHRASE_JUMP_BEATS = 32

export const createHorizontalBrowseBeatJumpHandlers = (params: {
  resolveDeckGridBpm: (deck: DeckKey) => number | null | undefined
  resolveDeckCurrentSeconds: (deck: DeckKey) => number
  seekDeckToSeconds: (deck: DeckKey, seconds: number, source: 'transport') => void
}) => {
  const jumpDeckByBeatCount = (deck: DeckKey, direction: -1 | 1, beatCount: number) => {
    const gridBpm = Number(params.resolveDeckGridBpm(deck))
    if (!Number.isFinite(gridBpm) || gridBpm <= 0) return
    const deltaSeconds = (60 / gridBpm) * beatCount * direction
    params.seekDeckToSeconds(
      deck,
      params.resolveDeckCurrentSeconds(deck) + deltaSeconds,
      'transport'
    )
  }

  return {
    handleDeckBarJump: (deck: DeckKey, direction: -1 | 1) =>
      jumpDeckByBeatCount(deck, direction, BAR_JUMP_BEATS),
    handleDeckPhraseJump: (deck: DeckKey, direction: -1 | 1) =>
      jumpDeckByBeatCount(deck, direction, PHRASE_JUMP_BEATS),
    handleDeckBeatJump: jumpDeckByBeatCount
  }
}
