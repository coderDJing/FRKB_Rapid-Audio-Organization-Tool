import { reactive } from 'vue'
import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'
import type { ISongInfo } from 'src/types/globals'

type TempoControlSnapshot = {
  playbackRate: number
  effectiveBpm: number
  syncEnabled: boolean
}

type UseHorizontalBrowseDeckTempoControlsParams = {
  resolveDeckSong: (deck: HorizontalBrowseDeckKey) => ISongInfo | null
  resolveTransportDeckSnapshot: (deck: HorizontalBrowseDeckKey) => TempoControlSnapshot
  nativeTransport: {
    setSyncEnabled: (deck: HorizontalBrowseDeckKey, enabled: boolean) => Promise<unknown>
  }
  commitDeckStateToNative: (
    deck: HorizontalBrowseDeckKey,
    override?: Partial<{
      currentSec: number
      lastObservedAtMs: number
      durationSec: number
      playing: boolean
      playbackRate: number
    }>
  ) => Promise<unknown>
}

const RATE_EPSILON = 0.0001
const BPM_EPSILON = 0.01

export const useHorizontalBrowseDeckTempoControls = (
  params: UseHorizontalBrowseDeckTempoControlsParams
) => {
  const deckMasterTempoEnabled = reactive<Record<HorizontalBrowseDeckKey, boolean>>({
    top: true,
    bottom: true
  })

  const isDeckMasterTempoEnabled = (deck: HorizontalBrowseDeckKey) => deckMasterTempoEnabled[deck]

  const toggleDeckMasterTempo = (deck: HorizontalBrowseDeckKey) => {
    deckMasterTempoEnabled[deck] = !deckMasterTempoEnabled[deck]
  }

  const resetDeckTempo = async (deck: HorizontalBrowseDeckKey) => {
    const song = params.resolveDeckSong(deck)
    if (!song) return

    const snapshot = params.resolveTransportDeckSnapshot(deck)
    const currentRate = Number(snapshot.playbackRate) || 1
    const needsRateReset = Math.abs(currentRate - 1) > RATE_EPSILON
    const originalBpm = Number(song.bpm) || 0
    const currentEffectiveBpm = Number(snapshot.effectiveBpm) || 0
    const bpmMismatch =
      originalBpm > 0 && currentEffectiveBpm > 0
        ? Math.abs(currentEffectiveBpm - originalBpm) > BPM_EPSILON
        : needsRateReset

    if (snapshot.syncEnabled) {
      if (!bpmMismatch) return
      await params.nativeTransport.setSyncEnabled(deck, false)
      if (!needsRateReset) return
    }

    if (!needsRateReset) return

    await params.commitDeckStateToNative(deck, {
      playbackRate: 1,
      lastObservedAtMs: performance.now()
    })
  }

  return {
    isDeckMasterTempoEnabled,
    toggleDeckMasterTempo,
    resetDeckTempo
  }
}
