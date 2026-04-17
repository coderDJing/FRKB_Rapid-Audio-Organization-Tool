import { reactive, ref } from 'vue'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/components/horizontalBrowseNativeTransport'

type DeckKey = HorizontalBrowseDeckKey

type UseHorizontalBrowseRenderSyncParams = {
  nativeTransport: {
    snapshot: (nowMs?: number) => Promise<unknown>
  }
  resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
  resolveDeckPlaying: (deck: DeckKey) => boolean
}

const TRANSPORT_SNAPSHOT_INTERVAL_IDLE_MS = 120
const TRANSPORT_SNAPSHOT_INTERVAL_PLAYING_MS = 1000
const TRANSPORT_SNAPSHOT_INTERVAL_SINGLE_DECK_PLAYING_MS = Number.POSITIVE_INFINITY

export const useHorizontalBrowseRenderSync = (params: UseHorizontalBrowseRenderSyncParams) => {
  const topDeckRenderCurrentSeconds = ref(0)
  const bottomDeckRenderCurrentSeconds = ref(0)

  const deckRenderSyncBaseSec = reactive<Record<DeckKey, number>>({
    top: 0,
    bottom: 0
  })
  const deckRenderSyncBaseAtMs = reactive<Record<DeckKey, number>>({
    top: 0,
    bottom: 0
  })

  let renderSyncRaf = 0
  let transportSnapshotInFlight = false
  let lastTransportSnapshotAt = 0

  const estimateDeckRenderCurrentSeconds = (deck: DeckKey, nowMs = performance.now()) => {
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    const durationSec = Math.max(0, Number(snapshot.durationSec) || 0)
    const playbackRate = Number(snapshot.playbackRate) || 1
    const baseSec = Math.max(0, Number(deckRenderSyncBaseSec[deck]) || 0)
    const baseAtMs = Math.max(0, Number(deckRenderSyncBaseAtMs[deck]) || 0)
    const deltaSec = snapshot.playing && baseAtMs > 0 ? Math.max(0, nowMs - baseAtMs) / 1000 : 0
    const nextSec = baseSec + deltaSec * Math.max(0.25, playbackRate)
    return durationSec > 0 ? Math.min(durationSec, nextSec) : Math.max(0, nextSec)
  }

  const resolveDeckRenderCurrentSeconds = (deck: DeckKey) => estimateDeckRenderCurrentSeconds(deck)

  const syncDeckRenderState = (nowMs = performance.now()) => {
    deckRenderSyncBaseSec.top =
      Number(params.resolveTransportDeckSnapshot('top').renderCurrentSec) || 0
    deckRenderSyncBaseSec.bottom =
      Number(params.resolveTransportDeckSnapshot('bottom').renderCurrentSec) || 0
    deckRenderSyncBaseAtMs.top = nowMs
    deckRenderSyncBaseAtMs.bottom = nowMs
    topDeckRenderCurrentSeconds.value = estimateDeckRenderCurrentSeconds('top', nowMs)
    bottomDeckRenderCurrentSeconds.value = estimateDeckRenderCurrentSeconds('bottom', nowMs)
  }

  const syncNativeTransportNow = async () => {
    await params.nativeTransport.snapshot(performance.now())
    syncDeckRenderState(performance.now())
  }

  const stopRenderSyncLoop = () => {
    if (!renderSyncRaf) return
    cancelAnimationFrame(renderSyncRaf)
    renderSyncRaf = 0
    transportSnapshotInFlight = false
  }

  const startRenderSyncLoop = (handleDeckLoopPlaybackTick: (deck: DeckKey) => void) => {
    stopRenderSyncLoop()
    const tick = () => {
      const nowMs = performance.now()
      handleDeckLoopPlaybackTick('top')
      handleDeckLoopPlaybackTick('bottom')
      topDeckRenderCurrentSeconds.value = estimateDeckRenderCurrentSeconds('top', nowMs)
      bottomDeckRenderCurrentSeconds.value = estimateDeckRenderCurrentSeconds('bottom', nowMs)
      const topPlaying = params.resolveDeckPlaying('top')
      const bottomPlaying = params.resolveDeckPlaying('bottom')
      const pollIntervalMs =
        topPlaying && bottomPlaying
          ? TRANSPORT_SNAPSHOT_INTERVAL_PLAYING_MS
          : topPlaying || bottomPlaying
            ? TRANSPORT_SNAPSHOT_INTERVAL_SINGLE_DECK_PLAYING_MS
            : TRANSPORT_SNAPSHOT_INTERVAL_IDLE_MS
      if (!transportSnapshotInFlight && nowMs - lastTransportSnapshotAt >= pollIntervalMs) {
        transportSnapshotInFlight = true
        lastTransportSnapshotAt = nowMs
        void syncNativeTransportNow()
          .catch(() => {})
          .finally(() => {
            transportSnapshotInFlight = false
          })
      }
      renderSyncRaf = requestAnimationFrame(tick)
    }
    tick()
  }

  return {
    topDeckRenderCurrentSeconds,
    bottomDeckRenderCurrentSeconds,
    resolveDeckRenderCurrentSeconds,
    syncDeckRenderState,
    startRenderSyncLoop,
    stopRenderSyncLoop
  }
}
