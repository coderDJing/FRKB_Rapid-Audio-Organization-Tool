import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import type {
  DeckWaveformDragEndPayload,
  DeckWaveformScrubPreviewPayload
} from '@renderer/composables/horizontalBrowse/horizontalBrowseDeckPlaybackState'
import type { HorizontalBrowseDetailZoomChangePayload } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformDetailTypes'

type DeckKey = HorizontalBrowseDeckKey

type WaveformPresentationBridgeState = {
  markDragPreview: (
    deck: DeckKey,
    anchorSec: number,
    linked: boolean,
    linkedAnchors?: Partial<Record<DeckKey, number>>
  ) => void
  clearDrag: (deck: DeckKey, linkedActive?: boolean) => void
  markZoom: (
    deck: DeckKey,
    zoom: number,
    anchorRatio: number,
    linked: boolean,
    options?: {
      anchorSec?: number | null
      viewportStartSec?: number | null
      visibleDurationSec?: number | null
      timeScale?: number | null
    }
  ) => void
}

type WaveformPresentationShellBridgeParams = {
  presentation: WaveformPresentationBridgeState
  resolveLinkedDragActive: () => boolean
  resolveZoomLinked: () => boolean
  resolveDeckRenderCurrentSeconds: (deck: DeckKey) => number
  resolveDeckWaveformDragAnchorSec: (deck: DeckKey) => number | null
  startDeckRawWaveformDrag: (deck: DeckKey) => void
  previewDeckRawWaveformScrub: (deck: DeckKey, payload: DeckWaveformScrubPreviewPayload) => void
  endDeckRawWaveformDrag: (deck: DeckKey, payload: DeckWaveformDragEndPayload) => void
}

const resolveOtherDeck = (deck: DeckKey): DeckKey => (deck === 'top' ? 'bottom' : 'top')

export const createHorizontalBrowseWaveformPresentationShellBridge = (
  params: WaveformPresentationShellBridgeParams
) => {
  const resolveDeckPresentationAnchorSec = (deck: DeckKey) => {
    const dragAnchorSec = Number(params.resolveDeckWaveformDragAnchorSec(deck))
    return Number.isFinite(dragAnchorSec)
      ? dragAnchorSec
      : params.resolveDeckRenderCurrentSeconds(deck)
  }

  const markDeckWaveformDragPresentation = (deck: DeckKey, linked: boolean) => {
    const otherDeck = resolveOtherDeck(deck)
    const anchorSec = resolveDeckPresentationAnchorSec(deck)
    if (!linked) {
      params.presentation.markDragPreview(deck, anchorSec, false)
      return
    }
    params.presentation.markDragPreview(deck, anchorSec, true, {
      [deck]: anchorSec,
      [otherDeck]: resolveDeckPresentationAnchorSec(otherDeck)
    })
  }

  const clearDeckWaveformDragPresentation = (deck: DeckKey) => {
    params.presentation.clearDrag(deck, params.resolveLinkedDragActive())
  }

  const handleDeckRawWaveformDragStart = (deck: DeckKey) => {
    params.startDeckRawWaveformDrag(deck)
    markDeckWaveformDragPresentation(deck, params.resolveLinkedDragActive())
  }

  const handleDeckRawWaveformScrubPreview = (
    deck: DeckKey,
    payload: DeckWaveformScrubPreviewPayload
  ) => {
    params.previewDeckRawWaveformScrub(deck, payload)
    markDeckWaveformDragPresentation(deck, params.resolveLinkedDragActive())
  }

  const handleDeckRawWaveformDragEnd = (deck: DeckKey, payload: DeckWaveformDragEndPayload) => {
    params.endDeckRawWaveformDrag(deck, payload)
    clearDeckWaveformDragPresentation(deck)
  }

  const markDetailZoomPresentation = (payload: HorizontalBrowseDetailZoomChangePayload) => {
    const numeric = Number(payload?.value)
    if (!Number.isFinite(numeric) || numeric <= 0) return false
    const sourceDeck: DeckKey = payload?.sourceDirection === 'down' ? 'bottom' : 'top'
    const linked = params.resolveZoomLinked()
    params.presentation.markZoom(sourceDeck, numeric, payload.anchorRatio, linked, {
      anchorSec: payload.anchorSec,
      viewportStartSec: payload.viewportStartSec,
      visibleDurationSec: payload.visibleDurationSec,
      timeScale: payload.timeScale
    })
    return true
  }

  return {
    handleDeckRawWaveformDragStart,
    handleDeckRawWaveformScrubPreview,
    handleDeckRawWaveformDragEnd,
    markDetailZoomPresentation
  }
}
