import { onUnmounted, reactive, watch } from 'vue'
import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import { normalizePreviewBpm } from '@renderer/components/MixtapeBeatAlignDialog.constants'
import {
  resolveDeckTargetPlaybackRate,
  shouldApplyDeckTargetBpm
} from '@renderer/composables/horizontalBrowse/horizontalBrowseDeckTempo'
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
    setPlaybackRate: (deck: HorizontalBrowseDeckKey, playbackRate: number) => Promise<unknown>
    setPlaybackRateLive: (deck: HorizontalBrowseDeckKey, playbackRate: number) => void
    setLiveClockPlaybackRate: (deck: HorizontalBrowseDeckKey, playbackRate: number | null) => void
  }
  onLiveVisualPlaybackRate?: (deck: HorizontalBrowseDeckKey, playbackRate: number | null) => void
}

const RATE_EPSILON = 0.0001
const BPM_EPSILON = 0.01
const LIVE_AUDIO_INTERVAL_MS = 32

type LiveTempoSession = {
  pendingBpm: number | null
  pendingRate: number | null
  lastSentRate: number | null
  lastSentAtMs: number
  audioTimer: ReturnType<typeof setTimeout> | null
  releasingSync: boolean
}

const createLiveTempoSession = (): LiveTempoSession => ({
  pendingBpm: null,
  pendingRate: null,
  lastSentRate: null,
  lastSentAtMs: 0,
  audioTimer: null,
  releasingSync: false
})

export const useHorizontalBrowseDeckTempoControls = (
  params: UseHorizontalBrowseDeckTempoControlsParams
) => {
  const deckMasterTempoEnabled = reactive<Record<HorizontalBrowseDeckKey, boolean>>({
    top: true,
    bottom: true
  })
  const liveTempoSessions: Record<HorizontalBrowseDeckKey, LiveTempoSession> = {
    top: createLiveTempoSession(),
    bottom: createLiveTempoSession()
  }

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

  const applyLiveVisualPlaybackRate = (deck: HorizontalBrowseDeckKey, targetBpm: number) => {
    const nextRate = resolveDeckTargetPlaybackRate(targetBpm, resolveDeckBaseGridBpm(deck))
    if (nextRate == null) return
    params.nativeTransport.setLiveClockPlaybackRate(deck, nextRate)
    params.onLiveVisualPlaybackRate?.(deck, nextRate)
  }

  const clearLiveVisualPlaybackRate = (deck: HorizontalBrowseDeckKey) => {
    params.nativeTransport.setLiveClockPlaybackRate(deck, null)
    params.onLiveVisualPlaybackRate?.(deck, null)
  }

  const clearLiveAudioTimer = (deck: HorizontalBrowseDeckKey) => {
    const session = liveTempoSessions[deck]
    if (session.audioTimer == null) return
    clearTimeout(session.audioTimer)
    session.audioTimer = null
  }

  const cancelDeckLiveTargetBpm = (deck: HorizontalBrowseDeckKey) => {
    const session = liveTempoSessions[deck]
    session.pendingBpm = null
    session.pendingRate = null
    session.lastSentRate = null
    session.lastSentAtMs = 0
    session.releasingSync = false
    clearLiveAudioTimer(deck)
    clearLiveVisualPlaybackRate(deck)
  }

  const setDeckTargetBpm = async (deck: HorizontalBrowseDeckKey, targetBpm: number) => {
    if (!params.resolveDeckSong(deck)) return

    let snapshot = params.resolveTransportDeckSnapshot(deck)
    if (snapshot.syncEnabled && !snapshot.leader) {
      await params.nativeTransport.setSyncEnabled(deck, false)
      snapshot = params.resolveTransportDeckSnapshot(deck)
    }

    const baseGridBpm = resolveDeckBaseGridBpm(deck)
    const nextPlaybackRate = resolveDeckTargetPlaybackRate(targetBpm, baseGridBpm)
    if (nextPlaybackRate == null) return

    const normalizedTargetBpm = normalizePreviewBpm(targetBpm)
    const currentEffectiveBpm = Number(snapshot.effectiveBpm) || 0
    if (!shouldApplyDeckTargetBpm(currentEffectiveBpm, normalizedTargetBpm)) {
      const currentPlaybackRate = Number(snapshot.playbackRate) || 1
      if (Math.abs(currentPlaybackRate - nextPlaybackRate) <= RATE_EPSILON) return
    }

    await params.nativeTransport.setPlaybackRate(deck, nextPlaybackRate)
  }

  const sendLivePlaybackRate = (deck: HorizontalBrowseDeckKey, playbackRate: number) => {
    const session = liveTempoSessions[deck]
    session.lastSentRate = playbackRate
    session.lastSentAtMs = performance.now()
    params.nativeTransport.setPlaybackRateLive(deck, playbackRate)
  }

  const flushLiveAudio = (deck: HorizontalBrowseDeckKey) => {
    const session = liveTempoSessions[deck]
    const nextRate = session.pendingRate
    session.audioTimer = null
    if (nextRate == null) return
    if (session.lastSentRate != null && Math.abs(session.lastSentRate - nextRate) <= RATE_EPSILON) {
      return
    }
    sendLivePlaybackRate(deck, nextRate)
  }

  const queueLiveAudio = (deck: HorizontalBrowseDeckKey, playbackRate: number) => {
    const session = liveTempoSessions[deck]
    session.pendingRate = playbackRate
    const elapsed = performance.now() - session.lastSentAtMs
    if (session.lastSentAtMs <= 0 || elapsed >= LIVE_AUDIO_INTERVAL_MS) {
      clearLiveAudioTimer(deck)
      flushLiveAudio(deck)
      return
    }
    if (session.audioTimer != null) return
    session.audioTimer = setTimeout(
      () => flushLiveAudio(deck),
      Math.max(1, LIVE_AUDIO_INTERVAL_MS - elapsed)
    )
  }

  const scheduleDeckLiveTargetBpm = (deck: HorizontalBrowseDeckKey, targetBpm: number) => {
    if (!params.resolveDeckSong(deck)) {
      cancelDeckLiveTargetBpm(deck)
      return
    }
    const normalizedTargetBpm = normalizePreviewBpm(targetBpm)
    const nextRate = resolveDeckTargetPlaybackRate(
      normalizedTargetBpm,
      resolveDeckBaseGridBpm(deck)
    )
    if (nextRate == null) return
    applyLiveVisualPlaybackRate(deck, normalizedTargetBpm)
    const session = liveTempoSessions[deck]
    session.pendingBpm = normalizedTargetBpm
    session.pendingRate = nextRate

    const snapshot = params.resolveTransportDeckSnapshot(deck)
    if (snapshot.syncEnabled && !snapshot.leader && !session.releasingSync) {
      session.releasingSync = true
      void params.nativeTransport.setSyncEnabled(deck, false).finally(() => {
        session.releasingSync = false
        if (session.pendingRate != null) queueLiveAudio(deck, session.pendingRate)
      })
      return
    }
    if (session.releasingSync) return
    queueLiveAudio(deck, nextRate)
  }

  const commitDeckTargetBpm = async (deck: HorizontalBrowseDeckKey, targetBpm: number) => {
    if (!params.resolveDeckSong(deck)) {
      cancelDeckLiveTargetBpm(deck)
      return
    }
    const session = liveTempoSessions[deck]
    session.pendingBpm = normalizePreviewBpm(targetBpm)
    session.pendingRate = null
    clearLiveAudioTimer(deck)
    try {
      await setDeckTargetBpm(deck, session.pendingBpm)
    } finally {
      session.pendingBpm = null
      session.lastSentRate = null
      session.lastSentAtMs = 0
      session.releasingSync = false
      clearLiveVisualPlaybackRate(deck)
    }
  }

  const resetDeckTempo = async (deck: HorizontalBrowseDeckKey) => {
    const song = params.resolveDeckSong(deck)
    if (!song) return
    cancelDeckLiveTargetBpm(deck)

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

    await params.nativeTransport.setPlaybackRate(deck, 1)
  }

  watch(
    () =>
      [
        params.resolveDeckSong('top')?.filePath || '',
        params.resolveDeckSong('bottom')?.filePath || ''
      ] as const,
    (current, previous) => {
      if (!previous) return
      if (current[0] !== previous[0]) cancelDeckLiveTargetBpm('top')
      if (current[1] !== previous[1]) cancelDeckLiveTargetBpm('bottom')
    }
  )

  onUnmounted(() => {
    cancelDeckLiveTargetBpm('top')
    cancelDeckLiveTargetBpm('bottom')
  })

  return {
    isDeckMasterTempoEnabled,
    toggleDeckMasterTempo,
    setDeckTargetBpm,
    scheduleDeckLiveTargetBpm,
    commitDeckTargetBpm,
    cancelDeckLiveTargetBpm,
    resetDeckTempo
  }
}
