import { computed, reactive } from 'vue'
import { createHorizontalBrowseNativeTransport } from '@renderer/components/horizontalBrowseNativeTransport'
import { useHorizontalBrowseRenderSync } from '@renderer/components/useHorizontalBrowseRenderSync'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@shared/horizontalBrowseTransport'

type DeckKey = HorizontalBrowseDeckKey

export const useHorizontalBrowseTransportController = () => {
  const nativeTransport = createHorizontalBrowseNativeTransport()
  const deckSyncState = nativeTransport.state
  const deckSeekIntent = reactive<Record<DeckKey, { seconds: number; revision: number }>>({
    top: { seconds: 0, revision: 0 },
    bottom: { seconds: 0, revision: 0 }
  })

  const resolveTransportDeckSnapshot = (deck: DeckKey): HorizontalBrowseTransportDeckSnapshot =>
    deck === 'top' ? nativeTransport.state.top : nativeTransport.state.bottom

  const resolveDeckCurrentSeconds = (deck: DeckKey) =>
    Number(resolveTransportDeckSnapshot(deck).currentSec) || 0

  const resolveDeckPlaying = (deck: DeckKey) => Boolean(resolveTransportDeckSnapshot(deck).playing)
  const resolveDeckLoaded = (deck: DeckKey) => Boolean(resolveTransportDeckSnapshot(deck).loaded)
  const resolveDeckDecoding = (deck: DeckKey) =>
    Boolean(resolveTransportDeckSnapshot(deck).decoding)
  const resolveDeckPlaybackRate = (deck: DeckKey) =>
    Number(resolveTransportDeckSnapshot(deck).playbackRate) || 1

  const topDeckPlaybackRate = computed(() => resolveDeckPlaybackRate('top'))
  const bottomDeckPlaybackRate = computed(() => resolveDeckPlaybackRate('bottom'))

  const {
    topDeckRenderCurrentSeconds,
    bottomDeckRenderCurrentSeconds,
    topDeckPlaybackSyncRevision,
    bottomDeckPlaybackSyncRevision,
    resolveDeckRenderCurrentSeconds,
    syncDeckRenderState,
    markTransportStateFresh,
    applyDeckRenderCurrentSeconds,
    startRenderSyncLoop,
    stopRenderSyncLoop
  } = useHorizontalBrowseRenderSync({
    nativeTransport,
    resolveTransportDeckSnapshot,
    resolveDeckPlaying
  })
  let stopSnapshotSubscription: (() => void) | null = null

  const notifyDeckSeekIntent = (deck: DeckKey, seconds: number) => {
    const safeSeconds = Math.max(0, Number(seconds) || 0)
    deckSeekIntent[deck] = {
      seconds: safeSeconds,
      revision: deckSeekIntent[deck].revision + 1
    }
    // seek 意图先改渲染基准，避免 nativeTransport.seek 的 IPC 往返期间
    // 大波形还沿着旧时间继续外推，造成“先飘再跳”的错位感。
    applyDeckRenderCurrentSeconds(deck, safeSeconds)
  }

  const startSnapshotSync = () => {
    if (stopSnapshotSubscription) return
    stopSnapshotSubscription = nativeTransport.subscribeSnapshot(() => {
      const nowMs = performance.now()
      markTransportStateFresh(nowMs)
      syncDeckRenderState(nowMs)
    })
  }

  const stopSnapshotSync = () => {
    if (!stopSnapshotSubscription) return
    stopSnapshotSubscription()
    stopSnapshotSubscription = null
  }

  return {
    nativeTransport,
    deckSyncState,
    deckSeekIntent,
    topDeckPlaybackRate,
    bottomDeckPlaybackRate,
    topDeckRenderCurrentSeconds,
    bottomDeckRenderCurrentSeconds,
    topDeckPlaybackSyncRevision,
    bottomDeckPlaybackSyncRevision,
    resolveTransportDeckSnapshot,
    resolveDeckCurrentSeconds,
    resolveDeckPlaying,
    resolveDeckLoaded,
    resolveDeckDecoding,
    resolveDeckPlaybackRate,
    resolveDeckRenderCurrentSeconds,
    syncDeckRenderState,
    startSnapshotSync,
    stopSnapshotSync,
    startRenderSyncLoop,
    stopRenderSyncLoop,
    notifyDeckSeekIntent
  }
}
