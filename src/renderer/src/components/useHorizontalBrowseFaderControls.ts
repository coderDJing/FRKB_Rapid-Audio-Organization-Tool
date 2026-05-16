import { computed, reactive, ref, watch, type Ref } from 'vue'
import type { ISettingConfig, ISongInfo } from 'src/types/globals'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportBandState
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
    setLeader: (deck?: DeckKey | null) => Promise<unknown>
    setSyncEnabled: (deck: DeckKey, enabled: boolean) => Promise<unknown>
    alignToLeader: (deck: DeckKey, targetSec?: number, skipGridSnap?: boolean) => Promise<unknown>
    setPlaying: (deck: DeckKey, playing: boolean) => Promise<unknown>
  }
  commitDeckStatesToNative: () => Promise<unknown>
  syncDeckRenderState: (input?: number | HorizontalBrowseRenderSyncOptions) => void
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  resolveDeckPlaying: (deck: DeckKey) => boolean
  resolveDeckCurrentSeconds: (deck: DeckKey) => number
  resolveDeckDurationSeconds: (deck: DeckKey) => number
}

const createDefaultBandState = (): HorizontalBrowseTransportBandState => ({
  high: true,
  mid: true,
  low: true
})

export const useHorizontalBrowseFaderControls = (
  params: UseHorizontalBrowseFaderControlsParams
) => {
  const deckBandState = reactive<Record<DeckKey, HorizontalBrowseTransportBandState>>({
    top: createDefaultBandState(),
    bottom: createDefaultBandState()
  })
  const faderControlsExpanded = ref(Boolean(params.setting.horizontalBrowseFaderControlsExpanded))
  const dualTransportSyncEnabled = ref(false)
  const canUseDualTransportSync = computed(() =>
    Boolean(params.topDeckSong.value && params.bottomDeckSong.value)
  )
  const DECK_END_EPSILON_SEC = 0.08

  const isDeckAtEnd = (deck: DeckKey) => {
    const duration = Number(params.resolveDeckDurationSeconds(deck)) || 0
    if (duration <= 0) return false
    const current = Number(params.resolveDeckCurrentSeconds(deck)) || 0
    return current >= Math.max(0, duration - DECK_END_EPSILON_SEC)
  }

  const deactivateDualTransportSync = () => {
    if (!dualTransportSyncEnabled.value) return
    dualTransportSyncEnabled.value = false
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
    return true
  }

  const handleDualTransportSyncToggle = () => {
    if (dualTransportSyncEnabled.value) {
      deactivateDualTransportSync()
      return
    }
    if (!canUseDualTransportSync.value) return
    dualTransportSyncEnabled.value = true
    void activateDualTransportSync().catch(() => {
      dualTransportSyncEnabled.value = false
    })
  }

  const handleDeckBandToggle = (deck: DeckKey, band: HorizontalBrowseBandKey) => {
    const nextValue = !deckBandState[deck][band]
    deckBandState[deck][band] = nextValue
    void params.nativeTransport.setBandState(deck, { ...deckBandState[deck] }).catch(() => {
      deckBandState[deck][band] = !nextValue
    })
  }

  watch(canUseDualTransportSync, (canUse) => {
    if (canUse) return
    deactivateDualTransportSync()
  })

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
    faderControlsExpanded,
    dualTransportSyncEnabled,
    canUseDualTransportSync,
    activateDualTransportSync,
    deactivateDualTransportSync,
    handleDualTransportSyncToggle,
    handleDeckBandToggle
  }
}
