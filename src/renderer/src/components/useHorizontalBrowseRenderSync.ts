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

  // 强制把某条 deck 的"渲染当前播放位置"立刻拉到指定秒数。
  // 和 syncDeckRenderState() 读取 nativeTransport snapshot 不同，这里是"目标优先"：
  //   点 cue / 拖动落点 / 概览点击等会发起 seek 的交互，发起瞬间就知道最终要到的位置，
  //   但 nativeTransport.seek 的 IPC 来回要 10~30ms，这期间如果放任：
  //     * startRenderSyncLoop 的 RAF tick 会用 playing=true&baseSec=旧值 继续外推，
  //       把 topDeckRenderCurrentSeconds 往前推；
  //     * HorizontalBrowseRawWaveformDetail 里的 playbackAnimation tick 继续驱动
  //       previewStartSec / 大波形 canvas 向前滚动几个像素；
  //   视觉上就是"点了 cue 波形先往前跳一下再顿住"。
  //
  // 通过在 notifyDeckSeekIntent 里先调用本函数，把 baseSec=目标秒、baseAtMs=now、
  // topDeckRenderCurrentSeconds.value=目标秒 一起提交，相当于让所有依赖渲染时间的插值器
  // 立刻 teleport 到新位置：
  //   * RAF tick: playing=true 时算出的 estimate = 目标秒 + 几 ms 漂移（几乎不可见）；
  //     playing=false 后 estimate 就等于目标秒，稳稳停在目标位置。
  //   * playbackAnimation tick: currentSeconds watcher 因为 topDeckRenderCurrentSeconds
  //     变了会刷新 playbackAnimationBaseSec=目标秒、baseAtMs=now，后续几帧从 0 delta 开始算，
  //     不会再从旧位置持续往前跑。
  //   * drawWaveform: previewStartSec 经 watcher → applyPreviewPlaybackPosition 推到
  //     目标秒 - visible/2，配合 rawData 覆盖判断立刻进入 stream-live，用户看到大波形
  //     瞬间锚定在目标位置。
  //
  // 当真正的 nativeTransport.seek IPC 完成后，调用方仍然会 syncDeckRenderState() 兜底一次，
  // 那时 snapshot.renderCurrentSec 已经是目标秒，本函数的提交与之一致，不会造成回跳。
  const applyDeckRenderCurrentSeconds = (deck: DeckKey, seconds: number) => {
    const nowMs = performance.now()
    const safeSeconds = Math.max(0, Number(seconds) || 0)
    deckRenderSyncBaseSec[deck] = safeSeconds
    deckRenderSyncBaseAtMs[deck] = nowMs
    if (deck === 'top') {
      topDeckRenderCurrentSeconds.value = safeSeconds
    } else {
      bottomDeckRenderCurrentSeconds.value = safeSeconds
    }
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
    applyDeckRenderCurrentSeconds,
    startRenderSyncLoop,
    stopRenderSyncLoop
  }
}
