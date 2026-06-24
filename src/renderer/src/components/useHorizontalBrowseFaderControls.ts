import { computed, nextTick, reactive, ref, watch, type Ref } from 'vue'
import type { ISettingConfig, ISongInfo } from 'src/types/globals'
import type { HorizontalBrowseClearLinkedPresentationState } from '@renderer/components/horizontalBrowseWaveformPresentationCoordinator'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportBandState,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/components/horizontalBrowseNativeTransport'
import type { HorizontalBrowseRenderSyncOptions } from '@renderer/components/useHorizontalBrowseRenderSync'

type DeckKey = HorizontalBrowseDeckKey
export type HorizontalBrowseBandKey = keyof HorizontalBrowseTransportBandState

type UseHorizontalBrowseFaderControlsParams = {
  topDeckSong: Ref<ISongInfo | null>
  bottomDeckSong: Ref<ISongInfo | null>
  setting: ISettingConfig
  deckSyncState: {
    leaderDeck?: string
  }
  nativeTransport: {
    setBandState: (deck: DeckKey, bands: HorizontalBrowseTransportBandState) => Promise<unknown>
    setCueMonitorEnabled: (deck: DeckKey, enabled: boolean) => Promise<unknown>
    setLeader: (deck?: DeckKey | null) => Promise<unknown>
    setSyncEnabled: (deck: DeckKey, enabled: boolean) => Promise<unknown>
    alignToLeader: (deck: DeckKey, targetSec?: number, skipGridSnap?: boolean) => Promise<unknown>
    setPlaying: (deck: DeckKey, playing: boolean) => Promise<unknown>
  }
  commitDeckStatesToNative: () => Promise<unknown>
  syncDeckRenderState: (input?: number | HorizontalBrowseRenderSyncOptions) => void
  commitLinkedGridVisualTransaction?: (payload: {
    leader: DeckKey
    follower: DeckKey
  }) => Promise<boolean> | boolean
  clearLinkedPresentation?: (playbackStates?: HorizontalBrowseClearLinkedPresentationState) => void
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  resolveDeckPlaying: (deck: DeckKey) => boolean
  resolveDeckCurrentSeconds: (deck: DeckKey) => number
  resolveDeckDurationSeconds: (deck: DeckKey) => number
  resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
}

const createDefaultBandState = (): HorizontalBrowseTransportBandState => ({
  high: true,
  mid: true,
  low: true
})

const waitForAnimationFrame = () =>
  new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve())
      return
    }
    setTimeout(resolve, 16)
  })

const waitForLinkedGridVisualHold = async () => {
  await nextTick()
  await waitForAnimationFrame()
}

export const useHorizontalBrowseFaderControls = (
  params: UseHorizontalBrowseFaderControlsParams
) => {
  const deckBandState = reactive<Record<DeckKey, HorizontalBrowseTransportBandState>>({
    top: createDefaultBandState(),
    bottom: createDefaultBandState()
  })
  const deckCueMonitorState = reactive<Record<DeckKey, boolean>>({
    top: false,
    bottom: false
  })
  const faderControlsExpanded = ref(Boolean(params.setting.horizontalBrowseFaderControlsExpanded))
  const dualTransportSyncEnabled = ref(false)
  const dualTransportSyncActivating = ref(false)
  let dualTransportSyncActivationToken = 0
  const canUseDualTransportSync = computed(() =>
    Boolean(params.topDeckSong.value && params.bottomDeckSong.value)
  )
  const DECK_END_EPSILON_SEC = 0.08

  const buildClearLinkedPresentationPlaybackStates =
    (): HorizontalBrowseClearLinkedPresentationState => {
      const startedAtMs = performance.now()
      const buildDeckState = (deck: DeckKey) => {
        const snapshot = params.resolveTransportDeckSnapshot(deck)
        return {
          currentSec: Number(snapshot.renderCurrentSec ?? snapshot.currentSec) || 0,
          playbackRate: Math.max(0.25, Number(snapshot.playbackRate) || 1),
          playing: snapshot.playing === true,
          startedAtMs
        }
      }
      return {
        top: buildDeckState('top'),
        bottom: buildDeckState('bottom')
      }
    }

  const isDeckAtEnd = (deck: DeckKey) => {
    const duration = Number(params.resolveDeckDurationSeconds(deck)) || 0
    if (duration <= 0) return false
    const current = Number(params.resolveDeckCurrentSeconds(deck)) || 0
    return current >= Math.max(0, duration - DECK_END_EPSILON_SEC)
  }

  const deactivateDualTransportSync = () => {
    if (!dualTransportSyncEnabled.value && !dualTransportSyncActivating.value) return
    dualTransportSyncActivationToken += 1
    dualTransportSyncEnabled.value = false
    dualTransportSyncActivating.value = false
    params.clearLinkedPresentation?.(buildClearLinkedPresentationPlaybackStates())
    void Promise.allSettled([
      params.nativeTransport.setSyncEnabled('top', false),
      params.nativeTransport.setSyncEnabled('bottom', false)
    ])
  }

  const resolveDualTransportLeader = (sourceDeck?: DeckKey): DeckKey => {
    if (sourceDeck && params.resolveDeckSong(sourceDeck)) return sourceDeck
    const leaderDeck = params.deckSyncState.leaderDeck
    if ((leaderDeck === 'top' || leaderDeck === 'bottom') && params.resolveDeckSong(leaderDeck)) {
      return leaderDeck
    }
    if (params.resolveDeckPlaying('top')) return 'top'
    if (params.resolveDeckPlaying('bottom')) return 'bottom'
    return 'top'
  }

  const activateDualTransportSync = async (sourceDeck?: DeckKey) => {
    if (!canUseDualTransportSync.value) return false
    if (dualTransportSyncActivating.value) return true
    const activationToken = dualTransportSyncActivationToken + 1
    dualTransportSyncActivationToken = activationToken
    dualTransportSyncActivating.value = true
    await nextTick()
    try {
      const leader = resolveDualTransportLeader(sourceDeck)
      const follower: DeckKey = leader === 'top' ? 'bottom' : 'top'
      const topWasPlaying = params.resolveDeckPlaying('top')
      const bottomWasPlaying = params.resolveDeckPlaying('bottom')
      await params.commitDeckStatesToNative()
      await params.nativeTransport.setLeader(leader)
      await params.nativeTransport.setSyncEnabled('top', true)
      await params.nativeTransport.setSyncEnabled('bottom', true)
      const alignTargetSec = params.resolveDeckCurrentSeconds(follower)
      await params.nativeTransport.alignToLeader(follower, alignTargetSec)
      if (topWasPlaying || bottomWasPlaying) {
        if (!topWasPlaying) {
          await params.nativeTransport.setPlaying('top', true)
        }
        if (!bottomWasPlaying) {
          await params.nativeTransport.setPlaying('bottom', true)
        }
      }
      params.syncDeckRenderState({ force: 'all' })
      await nextTick()
      try {
        await params.commitLinkedGridVisualTransaction?.({ leader, follower })
      } catch {}
      if (dualTransportSyncActivationToken === activationToken) {
        dualTransportSyncEnabled.value = true
      }
      return true
    } finally {
      await waitForLinkedGridVisualHold()
      if (dualTransportSyncActivationToken === activationToken) {
        dualTransportSyncActivating.value = false
      }
    }
  }

  const handleDualTransportSyncToggle = () => {
    if (dualTransportSyncEnabled.value || dualTransportSyncActivating.value) {
      deactivateDualTransportSync()
      return
    }
    if (!canUseDualTransportSync.value) return
    void activateDualTransportSync().catch(() => {
      dualTransportSyncEnabled.value = false
      dualTransportSyncActivating.value = false
    })
  }

  const handleDeckBandToggle = (deck: DeckKey, band: HorizontalBrowseBandKey) => {
    const nextValue = !deckBandState[deck][band]
    deckBandState[deck][band] = nextValue
    void params.nativeTransport.setBandState(deck, { ...deckBandState[deck] }).catch(() => {
      deckBandState[deck][band] = !nextValue
    })
  }

  const setDeckCueMonitorEnabled = (deck: DeckKey, enabled: boolean, revertOnFailure = true) => {
    const nextValue = Boolean(enabled && params.resolveDeckSong(deck))
    const previousValue = deckCueMonitorState[deck]
    deckCueMonitorState[deck] = nextValue
    void params.nativeTransport.setCueMonitorEnabled(deck, nextValue).catch(() => {
      if (revertOnFailure) {
        deckCueMonitorState[deck] = previousValue
      }
    })
  }

  const handleDeckCueMonitorToggle = (deck: DeckKey) => {
    if (!params.resolveDeckSong(deck)) return
    setDeckCueMonitorEnabled(deck, !deckCueMonitorState[deck])
  }

  const clearDeckCueMonitor = (deck: DeckKey) => {
    if (!deckCueMonitorState[deck]) return
    setDeckCueMonitorEnabled(deck, false, false)
  }

  const clearAllDeckCueMonitor = () => {
    clearDeckCueMonitor('top')
    clearDeckCueMonitor('bottom')
  }

  watch(canUseDualTransportSync, (canUse) => {
    if (canUse) return
    deactivateDualTransportSync()
  })

  watch(
    () => params.resolveDeckSong('top'),
    (song) => {
      if (!song) clearDeckCueMonitor('top')
    }
  )

  watch(
    () => params.resolveDeckSong('bottom'),
    (song) => {
      if (!song) clearDeckCueMonitor('bottom')
    }
  )

  watch(
    () =>
      [
        params.resolveDeckPlaying('top'),
        params.resolveDeckCurrentSeconds('top'),
        params.resolveDeckDurationSeconds('top'),
        params.resolveDeckPlaying('bottom'),
        params.resolveDeckCurrentSeconds('bottom'),
        params.resolveDeckDurationSeconds('bottom')
      ] as const,
    () => {
      if (!dualTransportSyncEnabled.value) return
      if (isDeckAtEnd('top') || isDeckAtEnd('bottom')) {
        deactivateDualTransportSync()
      }
    }
  )

  watch(faderControlsExpanded, (expanded) => {
    params.setting.horizontalBrowseFaderControlsExpanded = expanded
  })

  return {
    deckBandState,
    deckCueMonitorState,
    faderControlsExpanded,
    dualTransportSyncEnabled,
    dualTransportSyncActivating,
    canUseDualTransportSync,
    activateDualTransportSync,
    deactivateDualTransportSync,
    handleDualTransportSyncToggle,
    handleDeckBandToggle,
    handleDeckCueMonitorToggle,
    clearAllDeckCueMonitor
  }
}
