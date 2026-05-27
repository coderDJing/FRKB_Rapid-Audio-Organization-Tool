import { reactive } from 'vue'
import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'

type DeckKey = HorizontalBrowseDeckKey

const DECK_RECENT_INTERACTION_WINDOW_MS = 4000

export const useHorizontalBrowseDeckInteractionState = () => {
  const deckInteractionOrder = reactive<Record<DeckKey, number>>({
    top: 0,
    bottom: 0
  })
  const deckRecentInteraction = reactive<Record<DeckKey, boolean>>({
    top: false,
    bottom: false
  })
  let nextDeckInteractionOrder = 0
  let topDeckRecentInteractionTimer: ReturnType<typeof setTimeout> | null = null
  let bottomDeckRecentInteractionTimer: ReturnType<typeof setTimeout> | null = null

  const clearDeckRecentInteractionTimer = (deck: DeckKey) => {
    const currentTimer =
      deck === 'top' ? topDeckRecentInteractionTimer : bottomDeckRecentInteractionTimer
    if (!currentTimer) return
    clearTimeout(currentTimer)
    if (deck === 'top') {
      topDeckRecentInteractionTimer = null
      return
    }
    bottomDeckRecentInteractionTimer = null
  }

  const touchDeckInteraction = (deck: DeckKey) => {
    const interactionOrder = ++nextDeckInteractionOrder
    deckInteractionOrder[deck] = interactionOrder
    deckRecentInteraction[deck] = true
    clearDeckRecentInteractionTimer(deck)
    const timer = setTimeout(() => {
      if (deckInteractionOrder[deck] !== interactionOrder) return
      deckRecentInteraction[deck] = false
      if (deck === 'top') {
        topDeckRecentInteractionTimer = null
        return
      }
      bottomDeckRecentInteractionTimer = null
    }, DECK_RECENT_INTERACTION_WINDOW_MS)
    if (deck === 'top') {
      topDeckRecentInteractionTimer = timer
      return
    }
    bottomDeckRecentInteractionTimer = timer
  }

  return {
    deckInteractionOrder,
    deckRecentInteraction,
    touchDeckInteraction,
    clearDeckRecentInteractionTimer
  }
}
