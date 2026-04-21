import { reactive, type Ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/components/horizontalBrowseNativeTransport'
import {
  beginHorizontalBrowseDeckAction,
  resolveHorizontalBrowseDeckActionElapsedMs
} from '@renderer/components/horizontalBrowseInteractionTimeline'
import { sendHorizontalBrowseInteractionTrace } from '@renderer/components/horizontalBrowseInteractionTrace'
import { startHorizontalBrowseUserTiming } from '@renderer/components/horizontalBrowseUserTiming'

type DeckKey = HorizontalBrowseDeckKey

type DeckCuePreviewState = {
  active: boolean
  pointerId: number | null
  cueSeconds: number
  syncEnabledBefore: boolean
  syncLockBefore: string
  token: number
}

type UseHorizontalBrowseDeckCueControllerParams = {
  touchDeckInteraction: (deck: DeckKey) => void
  notifyDeckSeekIntent: (deck: DeckKey, seconds: number) => void
  nativeTransport: {
    setPlaying: (deck: DeckKey, playing: boolean) => Promise<unknown>
    seek: (deck: DeckKey, currentSec: number) => Promise<unknown>
    setSyncEnabled: (deck: DeckKey, enabled: boolean) => Promise<unknown>
  }
  syncDeckRenderState: () => void
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  resolveDeckLoaded: (deck: DeckKey) => boolean
  resolveDeckPlaying: (deck: DeckKey) => boolean
  resolveDeckCurrentSeconds: (deck: DeckKey) => number
  resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
  resolveDeckCuePointRef: (deck: DeckKey) => Ref<number>
  resolveDeckCuePlacementSec: (deck: DeckKey) => number
}

const CUE_POINT_TRIGGER_EPSILON_SEC = 0.05

const createDefaultDeckCuePreviewState = (): DeckCuePreviewState => ({
  active: false,
  pointerId: null,
  cueSeconds: 0,
  syncEnabledBefore: false,
  syncLockBefore: 'off',
  token: 0
})

export const useHorizontalBrowseDeckCueController = (
  params: UseHorizontalBrowseDeckCueControllerParams
) => {
  const deckCuePreviewState = reactive<Record<DeckKey, DeckCuePreviewState>>({
    top: createDefaultDeckCuePreviewState(),
    bottom: createDefaultDeckCuePreviewState()
  })
  const deckPendingCuePreviewOnLoad = reactive<Record<DeckKey, boolean>>({
    top: false,
    bottom: false
  })
  const suppressDeckCueClick = reactive<Record<DeckKey, boolean>>({ top: false, bottom: false })

  const canDeckExecuteImmediateTransportAction = (deck: DeckKey) =>
    Boolean(String(params.resolveDeckSong(deck)?.filePath || '').trim())

  const traceDeckAction = (deck: DeckKey, stage: string, payload?: Record<string, unknown>) => {
    const filePath = String(params.resolveDeckSong(deck)?.filePath || '').trim()
    sendHorizontalBrowseInteractionTrace(stage, {
      deck,
      filePath,
      ...payload
    })
  }

  const isDeckStoppedAtCuePoint = (deck: DeckKey) => {
    if (params.resolveDeckPlaying(deck) || !params.resolveDeckSong(deck)) return false
    const cueSeconds = params.resolveDeckCuePointRef(deck).value
    return (
      Math.abs(params.resolveDeckCurrentSeconds(deck) - cueSeconds) <= CUE_POINT_TRIGGER_EPSILON_SEC
    )
  }

  const handleDeckBackCue = async (
    deck: DeckKey,
    cueSeconds = params.resolveDeckCuePointRef(deck).value
  ) => {
    params.touchDeckInteraction(deck)
    const safeCueSeconds = Math.max(0, Number(cueSeconds) || 0)
    params.notifyDeckSeekIntent(deck, safeCueSeconds)
    await params.nativeTransport.setPlaying(deck, false)
    await params.nativeTransport.seek(deck, cueSeconds)
    params.syncDeckRenderState()
  }

  const handleDeckSetCueFromCurrentPosition = async (deck: DeckKey) => {
    params.touchDeckInteraction(deck)
    const cueRef = params.resolveDeckCuePointRef(deck)
    const nextCuePoint = params.resolveDeckCuePlacementSec(deck)
    cueRef.value = nextCuePoint
    params.notifyDeckSeekIntent(deck, Math.max(0, Number(nextCuePoint) || 0))
    await params.nativeTransport.seek(deck, nextCuePoint)
    params.syncDeckRenderState()
  }

  const startDeckCuePreview = (deck: DeckKey, pointerId: number) => {
    params.touchDeckInteraction(deck)
    const cuePreviewState = deckCuePreviewState[deck]
    if (cuePreviewState.active) return

    const snapshot = params.resolveTransportDeckSnapshot(deck)
    cuePreviewState.active = true
    cuePreviewState.pointerId = pointerId
    cuePreviewState.cueSeconds = params.resolveDeckCuePointRef(deck).value
    cuePreviewState.syncEnabledBefore = snapshot.syncEnabled
    cuePreviewState.syncLockBefore = snapshot.syncLock
    cuePreviewState.token += 1

    const token = cuePreviewState.token
    const syncEnabledBefore = cuePreviewState.syncEnabledBefore
    void (async () => {
      const filePath = String(params.resolveDeckSong(deck)?.filePath || '').trim()
      const finishTiming = startHorizontalBrowseUserTiming(`frkb:hb:cue-preview:${deck}`)
      beginHorizontalBrowseDeckAction(deck, 'cue-preview', filePath)
      traceDeckAction(deck, 'cue-preview:start')
      try {
        if (syncEnabledBefore) {
          await params.nativeTransport.setSyncEnabled(deck, false)
        }
        const latestState = deckCuePreviewState[deck]
        if (!latestState.active || latestState.token !== token) return
        await params.nativeTransport.setPlaying(deck, true)
        if (deckCuePreviewState[deck].token !== token) return
        traceDeckAction(deck, 'cue-preview:playing', {
          sinceCuePreviewMs: resolveHorizontalBrowseDeckActionElapsedMs(
            deck,
            'cue-preview',
            filePath
          )
        })
        params.syncDeckRenderState()
      } finally {
        finishTiming()
      }
    })()
  }

  const stopDeckCuePreview = (deck: DeckKey, pointerId?: number) => {
    const cuePreviewState = deckCuePreviewState[deck]
    if (!cuePreviewState.active) return
    if (typeof pointerId === 'number' && cuePreviewState.pointerId !== pointerId) return
    params.touchDeckInteraction(deck)

    const cueSeconds = cuePreviewState.cueSeconds
    const syncEnabledBefore = cuePreviewState.syncEnabledBefore
    cuePreviewState.active = false
    cuePreviewState.pointerId = null
    cuePreviewState.cueSeconds = 0
    cuePreviewState.syncEnabledBefore = false
    cuePreviewState.syncLockBefore = 'off'
    cuePreviewState.token += 1

    void (async () => {
      const filePath = String(params.resolveDeckSong(deck)?.filePath || '').trim()
      const finishTiming = startHorizontalBrowseUserTiming(`frkb:hb:cue-stop:${deck}`)
      beginHorizontalBrowseDeckAction(deck, 'cue-stop', filePath)
      beginHorizontalBrowseDeckAction(deck, 'seek', filePath)
      traceDeckAction(deck, 'cue-stop:start')
      try {
        params.notifyDeckSeekIntent(deck, Math.max(0, Number(cueSeconds) || 0))
        await params.nativeTransport.setPlaying(deck, false).catch(() => {})
        traceDeckAction(deck, 'cue-stop:paused', {
          sinceCueStopMs: resolveHorizontalBrowseDeckActionElapsedMs(deck, 'cue-stop', filePath)
        })
        await params.nativeTransport.seek(deck, cueSeconds).catch(() => {})
        traceDeckAction(deck, 'cue-stop:seeked', {
          sinceSeekMs: resolveHorizontalBrowseDeckActionElapsedMs(deck, 'seek', filePath),
          cueSeconds
        })
        if (syncEnabledBefore) {
          await params.nativeTransport.setSyncEnabled(deck, true).catch(() => {})
        }
        params.syncDeckRenderState()
      } finally {
        finishTiming()
      }
    })()
  }

  const stopAllDeckCuePreview = () => {
    stopDeckCuePreview('top')
    stopDeckCuePreview('bottom')
    suppressDeckCueClick.top = false
    suppressDeckCueClick.bottom = false
  }

  const clearDeckCueClickSuppressSoon = () =>
    requestAnimationFrame(() => {
      suppressDeckCueClick.top = false
      suppressDeckCueClick.bottom = false
    })

  const handleWindowDeckCuePointerUp = (event: PointerEvent) => {
    stopDeckCuePreview('top', event.pointerId)
    stopDeckCuePreview('bottom', event.pointerId)
    deckPendingCuePreviewOnLoad.top = false
    deckPendingCuePreviewOnLoad.bottom = false
    clearDeckCueClickSuppressSoon()
  }

  const handleDeckCuePointerDown = (deck: DeckKey, event: PointerEvent) => {
    if (event.button !== 0) return
    params.touchDeckInteraction(deck)
    suppressDeckCueClick[deck] = true
    event.preventDefault()

    if (params.resolveDeckPlaying(deck)) {
      void handleDeckBackCue(deck)
      return
    }
    if (!params.resolveDeckLoaded(deck)) {
      if (!canDeckExecuteImmediateTransportAction(deck)) return
      deckPendingCuePreviewOnLoad[deck] = false
      startDeckCuePreview(deck, event.pointerId)
      return
    }
    if (isDeckStoppedAtCuePoint(deck)) {
      startDeckCuePreview(deck, event.pointerId)
      return
    }
    void handleDeckSetCueFromCurrentPosition(deck)
  }

  const handleDeckCueClick = (deck: DeckKey) => {
    params.touchDeckInteraction(deck)
    if (suppressDeckCueClick[deck]) {
      suppressDeckCueClick[deck] = false
      return
    }
    if (params.resolveDeckPlaying(deck)) {
      void handleDeckBackCue(deck)
      return
    }
    if (isDeckStoppedAtCuePoint(deck)) return
    void handleDeckSetCueFromCurrentPosition(deck)
  }

  const handleDeckCueHotkeyDown = (deck: DeckKey) => {
    params.touchDeckInteraction(deck)
    if (params.resolveDeckPlaying(deck)) {
      void handleDeckBackCue(deck)
      return false
    }
    if (!params.resolveDeckLoaded(deck)) {
      if (!canDeckExecuteImmediateTransportAction(deck)) return false
      deckPendingCuePreviewOnLoad[deck] = false
      startDeckCuePreview(deck, -1)
      return true
    }
    if (!isDeckStoppedAtCuePoint(deck)) {
      void handleDeckSetCueFromCurrentPosition(deck)
      return false
    }
    startDeckCuePreview(deck, -1)
    return true
  }

  const handleDeckCueHotkeyUp = (deck: DeckKey) => {
    stopDeckCuePreview(deck)
  }

  const maybeResumePendingCuePreview = (deck: DeckKey, loaded: boolean) => {
    if (!deckPendingCuePreviewOnLoad[deck] || !loaded) return
    deckPendingCuePreviewOnLoad[deck] = false
    if (!isDeckStoppedAtCuePoint(deck)) {
      void handleDeckSetCueFromCurrentPosition(deck)
      return
    }
    startDeckCuePreview(deck, -1)
  }

  const resetDeckCueInteractionState = (deck: DeckKey) => {
    deckPendingCuePreviewOnLoad[deck] = false
    suppressDeckCueClick[deck] = false
    const cuePreviewState = deckCuePreviewState[deck]
    cuePreviewState.active = false
    cuePreviewState.pointerId = null
    cuePreviewState.cueSeconds = 0
    cuePreviewState.syncEnabledBefore = false
    cuePreviewState.syncLockBefore = 'off'
    cuePreviewState.token += 1
  }

  return {
    deckPendingCuePreviewOnLoad,
    suppressDeckCueClick,
    resolveDeckCuePreviewRuntimeState: (deck: DeckKey) => deckCuePreviewState[deck],
    handleDeckBackCue,
    handleDeckSetCueFromCurrentPosition,
    stopAllDeckCuePreview,
    handleWindowDeckCuePointerUp,
    handleDeckCuePointerDown,
    handleDeckCueClick,
    handleDeckCueHotkeyDown,
    handleDeckCueHotkeyUp,
    maybeResumePendingCuePreview,
    resetDeckCueInteractionState
  }
}
