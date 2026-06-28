import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/components/horizontalBrowseNativeTransport'

type DeckKey = HorizontalBrowseDeckKey

export const resolveOtherHorizontalBrowseLinkedDeck = (deck: DeckKey): DeckKey =>
  deck === 'top' ? 'bottom' : 'top'

export const resolveHorizontalBrowseLinkedDeckPlaybackOrder = (
  fallbackDeck: DeckKey,
  params: {
    resolveDeckSong: (deck: DeckKey) => unknown
    resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
  }
) => {
  const leader =
    params.resolveTransportDeckSnapshot('top').leader && params.resolveDeckSong('top')
      ? 'top'
      : params.resolveTransportDeckSnapshot('bottom').leader && params.resolveDeckSong('bottom')
        ? 'bottom'
        : fallbackDeck
  return {
    leader,
    follower: resolveOtherHorizontalBrowseLinkedDeck(leader)
  }
}
