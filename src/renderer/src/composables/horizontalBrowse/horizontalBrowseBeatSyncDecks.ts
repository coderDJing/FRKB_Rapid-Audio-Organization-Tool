import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'

type DeckKey = HorizontalBrowseDeckKey

export type HorizontalBrowseBeatSyncDecks = {
  leader: DeckKey
  follower: DeckKey
}

type ResolveHorizontalBrowseBeatSyncDecksParams = {
  deck: DeckKey
  hasDeckSong: (deck: DeckKey) => boolean
  resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
}

const isFullBeatSyncDeck = (snapshot: HorizontalBrowseTransportDeckSnapshot) =>
  snapshot.syncEnabled && snapshot.syncLock === 'full'

export const resolveOtherHorizontalBrowseDeck = (deck: DeckKey): DeckKey =>
  deck === 'top' ? 'bottom' : 'top'

export const resolveHorizontalBrowseBeatSyncDecks = ({
  deck,
  hasDeckSong,
  resolveTransportDeckSnapshot
}: ResolveHorizontalBrowseBeatSyncDecksParams): HorizontalBrowseBeatSyncDecks | null => {
  const otherDeck = resolveOtherHorizontalBrowseDeck(deck)
  if (!hasDeckSong(deck) || !hasDeckSong(otherDeck)) return null
  const deckSnapshot = resolveTransportDeckSnapshot(deck)
  const otherSnapshot = resolveTransportDeckSnapshot(otherDeck)
  const deckFullSync = isFullBeatSyncDeck(deckSnapshot)
  const otherFullSync = isFullBeatSyncDeck(otherSnapshot)
  if (!deckFullSync && !otherFullSync) return null
  if (deckSnapshot.leader) {
    return otherFullSync ? { leader: deck, follower: otherDeck } : null
  }
  if (otherSnapshot.leader) {
    return deckFullSync ? { leader: otherDeck, follower: deck } : null
  }
  if (deckFullSync) {
    return { leader: otherDeck, follower: deck }
  }
  if (otherFullSync) {
    return { leader: deck, follower: otherDeck }
  }
  return null
}
