import { onUnmounted, reactive, watch } from 'vue'
import type { HorizontalBrowseDeckKey } from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import { normalizePreviewBpm } from '@renderer/components/MixtapeBeatAlignDialog.constants'
import {
  resolveDeckTempoControlPlan,
  shouldApplyDeckTargetBpm
} from '@renderer/composables/horizontalBrowse/horizontalBrowseDeckTempo'
import {
  resolveHorizontalBrowseBeatSyncDecks,
  type HorizontalBrowseBeatSyncDecks
} from '@renderer/composables/horizontalBrowse/horizontalBrowseBeatSyncDecks'
import type { ISongInfo } from 'src/types/globals'

type TempoControlSnapshot = {
  playbackRate: number
  effectiveBpm: number
  syncEnabled: boolean
  syncLock: string
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
  playbackDeck: HorizontalBrowseDeckKey | null
  previewDecks: HorizontalBrowseDeckKey[]
  lastSentRate: number | null
  lastSentAtMs: number
  audioTimer: ReturnType<typeof setTimeout> | null
}

const createLiveTempoSession = (): LiveTempoSession => ({
  pendingBpm: null,
  pendingRate: null,
  playbackDeck: null,
  previewDecks: [],
  lastSentRate: null,
  lastSentAtMs: 0,
  audioTimer: null
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

  const clearDeckLivePreview = (deck: HorizontalBrowseDeckKey) => {
    params.nativeTransport.setLiveClockPlaybackRate(deck, null)
    params.onLiveVisualPlaybackRate?.(deck, null)
  }

  const clearLiveAudioTimer = (deck: HorizontalBrowseDeckKey) => {
    const session = liveTempoSessions[deck]
    if (session.audioTimer == null) return
    clearTimeout(session.audioTimer)
    session.audioTimer = null
  }

  const resolveActiveBeatSyncDecks = (
    deck: HorizontalBrowseDeckKey
  ): HorizontalBrowseBeatSyncDecks | null =>
    resolveHorizontalBrowseBeatSyncDecks({
      deck,
      hasDeckSong: (targetDeck) => Boolean(params.resolveDeckSong(targetDeck)),
      resolveTransportDeckSnapshot: params.resolveTransportDeckSnapshot
    })

  const resolveTempoControlPlan = (deck: HorizontalBrowseDeckKey, targetBpm: number) =>
    resolveDeckTempoControlPlan({
      deck,
      targetBpm,
      activeSyncDecks: resolveActiveBeatSyncDecks(deck),
      resolveBaseGridBpm: resolveDeckBaseGridBpm,
      resolveSnapshot: params.resolveTransportDeckSnapshot
    })

  const applyLiveTempoPreview = (
    deck: HorizontalBrowseDeckKey,
    previewPlaybackRates: Partial<Record<HorizontalBrowseDeckKey, number>>
  ) => {
    const session = liveTempoSessions[deck]
    const nextPreviewDecks = (['top', 'bottom'] as const).filter(
      (targetDeck) => previewPlaybackRates[targetDeck] != null
    )
    session.previewDecks
      .filter((targetDeck) => !nextPreviewDecks.includes(targetDeck))
      .forEach(clearDeckLivePreview)
    nextPreviewDecks.forEach((targetDeck) => {
      const playbackRate = previewPlaybackRates[targetDeck]
      if (playbackRate == null) return
      params.nativeTransport.setLiveClockPlaybackRate(targetDeck, playbackRate)
      params.onLiveVisualPlaybackRate?.(targetDeck, playbackRate)
    })
    session.previewDecks = nextPreviewDecks
  }

  const clearSessionLivePreview = (deck: HorizontalBrowseDeckKey) => {
    const session = liveTempoSessions[deck]
    session.previewDecks.forEach(clearDeckLivePreview)
    session.previewDecks = []
  }

  const cancelDeckLiveTargetBpm = (deck: HorizontalBrowseDeckKey) => {
    const session = liveTempoSessions[deck]
    session.pendingBpm = null
    session.pendingRate = null
    session.playbackDeck = null
    session.lastSentRate = null
    session.lastSentAtMs = 0
    clearLiveAudioTimer(deck)
    clearSessionLivePreview(deck)
  }

  const setDeckTargetBpm = async (deck: HorizontalBrowseDeckKey, targetBpm: number) => {
    if (!params.resolveDeckSong(deck)) return

    const normalizedTargetBpm = normalizePreviewBpm(targetBpm)
    const plan = resolveTempoControlPlan(deck, normalizedTargetBpm)
    if (!plan) return
    const snapshot = params.resolveTransportDeckSnapshot(plan.playbackDeck)
    const currentEffectiveBpm = Number(snapshot.effectiveBpm) || 0
    if (!shouldApplyDeckTargetBpm(currentEffectiveBpm, normalizedTargetBpm)) {
      const currentPlaybackRate = Number(snapshot.playbackRate) || 1
      if (Math.abs(currentPlaybackRate - plan.playbackRate) <= RATE_EPSILON) return
    }

    await params.nativeTransport.setPlaybackRate(plan.playbackDeck, plan.playbackRate)
  }

  const sendLivePlaybackRate = (deck: HorizontalBrowseDeckKey, playbackRate: number) => {
    const session = liveTempoSessions[deck]
    const playbackDeck = session.playbackDeck ?? deck
    session.lastSentRate = playbackRate
    session.lastSentAtMs = performance.now()
    params.nativeTransport.setPlaybackRateLive(playbackDeck, playbackRate)
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
    const plan = resolveTempoControlPlan(deck, normalizedTargetBpm)
    if (!plan) return
    const session = liveTempoSessions[deck]
    if (session.playbackDeck !== plan.playbackDeck) {
      clearLiveAudioTimer(deck)
      session.lastSentRate = null
      session.lastSentAtMs = 0
    }
    session.playbackDeck = plan.playbackDeck
    session.pendingBpm = normalizedTargetBpm
    session.pendingRate = plan.playbackRate
    applyLiveTempoPreview(deck, plan.previewPlaybackRates)
    queueLiveAudio(deck, plan.playbackRate)
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
    // 先撤掉本地时钟覆盖，使提交返回的双轨快照可以同时落地；CSS 预览在快照
    // 到达后再释放，避免旧密度帧提前弹回。
    session.previewDecks.forEach((targetDeck) => {
      params.nativeTransport.setLiveClockPlaybackRate(targetDeck, null)
    })
    try {
      await setDeckTargetBpm(deck, session.pendingBpm)
    } finally {
      session.pendingBpm = null
      session.playbackDeck = null
      session.lastSentRate = null
      session.lastSentAtMs = 0
      session.previewDecks.forEach((targetDeck) => {
        params.onLiveVisualPlaybackRate?.(targetDeck, null)
      })
      session.previewDecks = []
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
