import { reactive } from 'vue'
import type { HorizontalBrowseDeckKey } from '@renderer/components/horizontalBrowseNativeTransport'
import { normalizePreviewBpm } from '@renderer/components/MixtapeBeatAlignDialog.constants'
import type { HorizontalBrowseDeckTransportStateOverride } from '@renderer/components/useHorizontalBrowseTransportMutations'
import type { ISongInfo } from 'src/types/globals'

type TempoControlSnapshot = {
  playbackRate: number
  effectiveBpm: number
  syncEnabled: boolean
  leader: boolean
}

type UseHorizontalBrowseDeckTempoControlsParams = {
  resolveDeckSong: (deck: HorizontalBrowseDeckKey) => ISongInfo | null
  resolveDeckGridBpm: (deck: HorizontalBrowseDeckKey) => number
  resolveTransportDeckSnapshot: (deck: HorizontalBrowseDeckKey) => TempoControlSnapshot
  nativeTransport: {
    setSyncEnabled: (deck: HorizontalBrowseDeckKey, enabled: boolean) => Promise<unknown>
  }
  commitDeckStateToNative: (
    deck: HorizontalBrowseDeckKey,
    override?: HorizontalBrowseDeckTransportStateOverride
  ) => Promise<unknown>
}

const RATE_EPSILON = 0.0001
const BPM_EPSILON = 0.01
const MIN_PLAYBACK_RATE = 0.25
const MAX_PLAYBACK_RATE = 4

const clampPlaybackRate = (value: number) =>
  Math.max(MIN_PLAYBACK_RATE, Math.min(MAX_PLAYBACK_RATE, value))

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

  const resolveDeckBaseGridBpm = (deck: HorizontalBrowseDeckKey) => {
    const gridBpm = Number(params.resolveDeckGridBpm(deck))
    if (Number.isFinite(gridBpm) && gridBpm > 0) {
      return gridBpm
    }
    const songBpm = Number(params.resolveDeckSong(deck)?.bpm)
    return Number.isFinite(songBpm) && songBpm > 0 ? songBpm : 0
  }

  const setDeckTargetBpm = async (deck: HorizontalBrowseDeckKey, targetBpm: number) => {
    if (!params.resolveDeckSong(deck)) return

    let snapshot = params.resolveTransportDeckSnapshot(deck)
    if (snapshot.syncEnabled && !snapshot.leader) {
      await params.nativeTransport.setSyncEnabled(deck, false)
      snapshot = params.resolveTransportDeckSnapshot(deck)
    }

    const baseGridBpm = resolveDeckBaseGridBpm(deck)
    if (!Number.isFinite(baseGridBpm) || baseGridBpm <= 0) return

    const normalizedTargetBpm = normalizePreviewBpm(targetBpm)
    const nextPlaybackRate = clampPlaybackRate(normalizedTargetBpm / baseGridBpm)
    const currentPlaybackRate = Number(snapshot.playbackRate) || 1
    if (Math.abs(currentPlaybackRate - nextPlaybackRate) <= RATE_EPSILON) return

    await params.commitDeckStateToNative(deck, {
      playbackRate: nextPlaybackRate,
      lastObservedAtMs: performance.now()
    })
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
    setDeckTargetBpm,
    resetDeckTempo
  }
}
