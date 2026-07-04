import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import type { UseHorizontalBrowseDeckPlaybackControllerParams } from '@renderer/composables/horizontalBrowse/useHorizontalBrowseDeckPlaybackControllerTypes'

type DeckKey = HorizontalBrowseDeckKey

type CreateSectionSeekPlayHandlerParams = {
  params: UseHorizontalBrowseDeckPlaybackControllerParams
  deckSeekActionToken: Record<DeckKey, number>
  deckSeekResumeOnComplete: Record<DeckKey, boolean>
  clampDeckTimelineSeconds: (deck: DeckKey, seconds: number) => number
  prepareDeckPlayheadIfNeeded: (deck: DeckKey) => Promise<void>
  traceDeckAction: (deck: DeckKey, action: string, detail?: Record<string, unknown>) => void
}

export const createHorizontalBrowseSectionSeekPlayHandler = ({
  params,
  deckSeekActionToken,
  deckSeekResumeOnComplete,
  clampDeckTimelineSeconds,
  prepareDeckPlayheadIfNeeded,
  traceDeckAction
}: CreateSectionSeekPlayHandlerParams) => {
  return (deck: DeckKey, seconds: number) => {
    const targetSeconds = clampDeckTimelineSeconds(deck, seconds)
    const token = deckSeekActionToken[deck] + 1
    deckSeekActionToken[deck] = token
    deckSeekResumeOnComplete[deck] = false
    params.touchDeckInteraction(deck)
    params.notifyDeckSeekIntent(deck, targetSeconds)
    traceDeckAction(deck, 'seek:intent', {
      source: 'structure-section',
      seconds: targetSeconds
    })
    void (async () => {
      await params.nativeTransport.seek(deck, targetSeconds)
      if (deckSeekActionToken[deck] !== token) return
      await prepareDeckPlayheadIfNeeded(deck)
      if (deckSeekActionToken[deck] !== token) return
      params.startDeckRenderPlaybackClock(deck, targetSeconds)
      await params.nativeTransport.setPlaying(deck, true)
      if (deckSeekActionToken[deck] !== token) return
      params.syncDeckRenderState({ force: deck })
    })().catch(() => {})
  }
}
