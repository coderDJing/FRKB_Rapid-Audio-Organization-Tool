import { reactive, ref } from 'vue'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/components/horizontalBrowseNativeTransport'

type DeckKey = HorizontalBrowseDeckKey
export type HorizontalBrowseRenderSyncTarget = DeckKey | DeckKey[] | 'all'
export type HorizontalBrowseRenderSyncOptions = {
  nowMs?: number
  snapshotAtMs?: number
  force?: HorizontalBrowseRenderSyncTarget
}

type UseHorizontalBrowseRenderSyncParams = {
  nativeTransport: {
    state?: {
      stateRevision?: number
    }
    snapshot: (nowMs?: number) => Promise<unknown>
  }
  resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
  resolveDeckPlaying: (deck: DeckKey) => boolean
}

const TRANSPORT_SNAPSHOT_FALLBACK_INTERVAL_IDLE_MS = 1000
const TRANSPORT_SNAPSHOT_FALLBACK_INTERVAL_PLAYING_MS = 4000
const RENDER_SYNC_REANCHOR_DRIFT_SEC = 0.35
const RENDER_SYNC_FULL_SYNC_PHASE_REANCHOR_SEC = 0.002
const RENDER_SYNC_PENDING_INTENT_EPSILON_SEC = 0.05
const RENDER_SYNC_PENDING_INTENT_MAX_MS = 1500

type PendingRenderSeekIntent = {
  seconds: number
  startedAtMs: number
}

const TIMELINE_ZERO_EPSILON_SEC = 0.0001
const normalizeTimelineSeconds = (seconds: number) => {
  const numeric = Number(seconds)
  return Number.isFinite(numeric) ? numeric : 0
}

const resolveDeckRenderLimitSec = (snapshot: HorizontalBrowseTransportDeckSnapshot) => {
  const effectiveDurationSec = Math.max(0, Number(snapshot.effectiveDurationSec) || 0)
  if (effectiveDurationSec > 0) return effectiveDurationSec
  return Math.max(0, Number(snapshot.durationSec) || 0)
}

const assignDeckRenderCurrentSeconds = (
  deck: DeckKey,
  seconds: number,
  topDeckRenderCurrentSeconds: { value: number },
  bottomDeckRenderCurrentSeconds: { value: number }
) => {
  if (deck === 'top') {
    topDeckRenderCurrentSeconds.value = seconds
    return
  }
  bottomDeckRenderCurrentSeconds.value = seconds
}

export const useHorizontalBrowseRenderSync = (params: UseHorizontalBrowseRenderSyncParams) => {
  const topDeckRenderCurrentSeconds = ref(0)
  const bottomDeckRenderCurrentSeconds = ref(0)
  const topDeckPlaybackSyncRevision = ref(0)
  const bottomDeckPlaybackSyncRevision = ref(0)

  const deckRenderSyncBaseSec = reactive<Record<DeckKey, number>>({
    top: 0,
    bottom: 0
  })
  const deckRenderSyncBaseAtMs = reactive<Record<DeckKey, number>>({
    top: 0,
    bottom: 0
  })
  const deckRenderTimelineSignature = reactive<Record<DeckKey, string>>({
    top: '',
    bottom: ''
  })
  const deckRenderStateRevision = reactive<Record<DeckKey, number>>({
    top: 0,
    bottom: 0
  })
  const pendingRenderSeekIntent = reactive<Record<DeckKey, PendingRenderSeekIntent | null>>({
    top: null,
    bottom: null
  })

  let renderSyncRaf = 0
  let transportSnapshotInFlight = false
  let lastTransportSnapshotAt = 0

  const estimateDeckRenderCurrentSeconds = (deck: DeckKey, nowMs = performance.now()) => {
    const pendingIntent = pendingRenderSeekIntent[deck]
    if (pendingIntent) return pendingIntent.seconds
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    const renderLimitSec = resolveDeckRenderLimitSec(snapshot)
    const playbackRate = Number(snapshot.playbackRate) || 1
    const baseSec = normalizeTimelineSeconds(deckRenderSyncBaseSec[deck])
    const baseAtMs = Math.max(0, Number(deckRenderSyncBaseAtMs[deck]) || 0)
    const canEstimatePlayback =
      baseAtMs > 0 && (snapshot.playingAudible || (snapshot.playing && baseSec < 0))
    const deltaSec = canEstimatePlayback ? Math.max(0, nowMs - baseAtMs) / 1000 : 0
    const nextSec = baseSec + deltaSec * Math.max(0.25, playbackRate)
    return renderLimitSec > 0 ? Math.min(renderLimitSec, nextSec) : nextSec
  }

  const resolveDeckRenderCurrentSeconds = (deck: DeckKey) => estimateDeckRenderCurrentSeconds(deck)

  // 只有时间线坐标会变的字段才能触发渲染重锚；解码/可听状态变化不能打断负时间外推。
  const buildDeckRenderTimelineSignature = (snapshot: HorizontalBrowseTransportDeckSnapshot) =>
    [
      snapshot.label || '',
      snapshot.loaded ? 1 : 0,
      snapshot.playing ? 1 : 0,
      Number(snapshot.durationSec || 0).toFixed(3),
      Number(snapshot.effectiveDurationSec || 0).toFixed(3),
      Number(snapshot.playbackRate || 1).toFixed(6),
      snapshot.loopActive ? 1 : 0,
      Number(snapshot.loopStartSec || 0).toFixed(6),
      Number(snapshot.loopEndSec || 0).toFixed(6)
    ].join('|')

  const resolveTransportStateRevision = () => {
    const revision = Number(params.nativeTransport.state?.stateRevision)
    return Number.isFinite(revision) ? Math.max(0, Math.floor(revision)) : 0
  }

  const resolveForcedDecks = (target?: HorizontalBrowseRenderSyncTarget) => {
    if (!target) return new Set<DeckKey>()
    if (target === 'all') return new Set<DeckKey>(['top', 'bottom'])
    return new Set<DeckKey>(Array.isArray(target) ? target : [target])
  }

  const bumpDeckPlaybackSyncRevision = (deck: DeckKey) => {
    if (deck === 'top') {
      topDeckPlaybackSyncRevision.value += 1
      return
    }
    bottomDeckPlaybackSyncRevision.value += 1
  }

  const syncDeckFromSnapshot = (
    deck: DeckKey,
    snapshotAtMs: number,
    renderNowMs: number,
    force: boolean
  ) => {
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    const snapshotSec = normalizeTimelineSeconds(snapshot.renderCurrentSec)
    const estimatedSec = estimateDeckRenderCurrentSeconds(deck, snapshotAtMs)
    const renderEstimatedSec = estimateDeckRenderCurrentSeconds(deck, renderNowMs)
    const pendingIntent = pendingRenderSeekIntent[deck]
    let confirmedPendingIntent = false
    if (pendingIntent) {
      const intentAgeMs = renderNowMs - pendingIntent.startedAtMs
      const pendingEstimatedSec = pendingIntent.seconds
      const nativeConfirmedNegativeIntent =
        pendingIntent.seconds < -TIMELINE_ZERO_EPSILON_SEC &&
        snapshotSec < -TIMELINE_ZERO_EPSILON_SEC
      const shouldKeepNegativeIntent =
        pendingIntent.seconds < -TIMELINE_ZERO_EPSILON_SEC &&
        !nativeConfirmedNegativeIntent &&
        pendingEstimatedSec < -TIMELINE_ZERO_EPSILON_SEC
      if (shouldKeepNegativeIntent) {
        pendingRenderSeekIntent[deck] = {
          seconds: pendingEstimatedSec,
          startedAtMs: renderNowMs
        }
        deckRenderSyncBaseSec[deck] = pendingEstimatedSec
        deckRenderSyncBaseAtMs[deck] = renderNowMs
        assignDeckRenderCurrentSeconds(
          deck,
          pendingEstimatedSec,
          topDeckRenderCurrentSeconds,
          bottomDeckRenderCurrentSeconds
        )
        return
      }
      const intentConfirmed =
        Math.abs(snapshotSec - pendingIntent.seconds) <= RENDER_SYNC_PENDING_INTENT_EPSILON_SEC
      const intentExpired = intentAgeMs >= RENDER_SYNC_PENDING_INTENT_MAX_MS
      if (!force && !intentConfirmed && !intentExpired) {
        const nextSec = estimateDeckRenderCurrentSeconds(deck, renderNowMs)
        assignDeckRenderCurrentSeconds(
          deck,
          nextSec,
          topDeckRenderCurrentSeconds,
          bottomDeckRenderCurrentSeconds
        )
        return
      }
      pendingRenderSeekIntent[deck] = null
      confirmedPendingIntent = intentConfirmed
    }
    const signature = buildDeckRenderTimelineSignature(snapshot)
    const previousSignature = deckRenderTimelineSignature[deck]
    const signatureChanged = previousSignature !== signature
    const transportStateRevision = resolveTransportStateRevision()
    const previousStateRevision = deckRenderStateRevision[deck]
    const stateRevisionChanged =
      transportStateRevision > 0 &&
      previousStateRevision > 0 &&
      transportStateRevision !== previousStateRevision
    const playbackSnapshotAuthoritative = !snapshot.playing || snapshot.playingAudible
    const previousBaseAtMs = deckRenderSyncBaseAtMs[deck]
    const stalePlayingSnapshot =
      !force &&
      snapshot.playing &&
      previousSignature === signature &&
      snapshotAtMs + 1 < previousBaseAtMs
    if (stalePlayingSnapshot) {
      const nextSec = estimateDeckRenderCurrentSeconds(deck, renderNowMs)
      if (deck === 'top') {
        topDeckRenderCurrentSeconds.value = nextSec
      } else {
        bottomDeckRenderCurrentSeconds.value = nextSec
      }
      return
    }
    const driftSec = Math.abs(snapshotSec - estimatedSec)
    const fullSyncPhaseChanged =
      stateRevisionChanged &&
      snapshot.syncEnabled &&
      snapshot.syncLock === 'full' &&
      playbackSnapshotAuthoritative &&
      driftSec >= RENDER_SYNC_FULL_SYNC_PHASE_REANCHOR_SEC
    const shouldReanchor =
      force ||
      !previousSignature ||
      !snapshot.playing ||
      signatureChanged ||
      fullSyncPhaseChanged ||
      (playbackSnapshotAuthoritative && driftSec >= RENDER_SYNC_REANCHOR_DRIFT_SEC)
    const shouldBumpPlaybackRevision =
      shouldReanchor &&
      !confirmedPendingIntent &&
      (force ||
        fullSyncPhaseChanged ||
        (snapshot.playing && (!previousSignature || driftSec >= RENDER_SYNC_REANCHOR_DRIFT_SEC)))

    if (shouldReanchor) {
      deckRenderSyncBaseSec[deck] = snapshotSec
      deckRenderSyncBaseAtMs[deck] = snapshotAtMs
      if (shouldBumpPlaybackRevision) {
        bumpDeckPlaybackSyncRevision(deck)
      }
    }
    deckRenderTimelineSignature[deck] = signature
    deckRenderStateRevision[deck] = transportStateRevision

    const nextSec = shouldReanchor
      ? estimateDeckRenderCurrentSeconds(deck, renderNowMs)
      : renderEstimatedSec
    assignDeckRenderCurrentSeconds(
      deck,
      nextSec,
      topDeckRenderCurrentSeconds,
      bottomDeckRenderCurrentSeconds
    )
  }

  const syncDeckRenderState = (
    input: number | HorizontalBrowseRenderSyncOptions = performance.now()
  ) => {
    const nowMs = typeof input === 'number' ? input : (input.nowMs ?? performance.now())
    const snapshotAtMs = typeof input === 'number' ? nowMs : (input.snapshotAtMs ?? nowMs)
    const forcedDecks = resolveForcedDecks(typeof input === 'number' ? undefined : input.force)
    if (forcedDecks.size > 0) {
      for (const deck of forcedDecks) {
        syncDeckFromSnapshot(deck, snapshotAtMs, nowMs, true)
      }
      return
    }
    syncDeckFromSnapshot('top', snapshotAtMs, nowMs, false)
    syncDeckFromSnapshot('bottom', snapshotAtMs, nowMs, false)
  }

  // 强制把某条 deck 的"渲染当前播放位置"立刻拉到指定秒数。
  // 和 syncDeckRenderState() 读取 nativeTransport snapshot 不同，这里是"目标优先"：
  //   点 cue / 拖动落点 / 概览点击等会发起 seek 的交互，发起瞬间就知道最终要到的位置，
  //   但 nativeTransport.seek 的 IPC 来回要 10~30ms，这期间如果放任：
  //     * startRenderSyncLoop 的 RAF tick 会用 playing=true&baseSec=旧值 继续外推，
  //       把 topDeckRenderCurrentSeconds 往前推；
  //     * HorizontalBrowseRawWaveformDetail 会继续吃旧的 currentSeconds，
  //       previewStartSec / 大波形 canvas 还会沿着旧时间基准往前滚几个像素；
  //   视觉上就是"点了 cue 波形先往前跳一下再顿住"。
  //
  // 通过在 notifyDeckSeekIntent 里先调用本函数，把 baseSec=目标秒、baseAtMs=now、
  // topDeckRenderCurrentSeconds.value=目标秒 一起提交，相当于让所有依赖渲染时间的插值器
  // 立刻 teleport 到新位置：
  //   * RAF tick: pending seek 确认前固定返回目标秒，避免联结模式下另一轨
  //     先沿旧播放状态外推一小段再被 native seek 拉回。
  //   * currentSeconds watcher: 大波形收到新的 topDeckRenderCurrentSeconds 后会立刻把
  //     previewStartSec 推到目标秒对应的位置，不会再沿着旧位置继续外推。
  //   * drawWaveform: previewStartSec 经 watcher → applyPreviewPlaybackPosition 推到
  //     目标秒 - visible/2，配合 rawData 覆盖判断立刻进入 stream-live，用户看到大波形
  //     瞬间锚定在目标位置。
  //
  // 当真正的 nativeTransport.seek IPC 完成后，调用方仍然会 syncDeckRenderState() 兜底一次，
  // 那时 snapshot.renderCurrentSec 已经是目标秒，本函数的提交与之一致，不会造成回跳。
  const applyDeckRenderCurrentSeconds = (deck: DeckKey, seconds: number) => {
    const nowMs = performance.now()
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    const renderLimitSec = resolveDeckRenderLimitSec(snapshot)
    const normalizedSeconds = normalizeTimelineSeconds(seconds)
    const safeSeconds =
      renderLimitSec > 0 ? Math.min(normalizedSeconds, renderLimitSec) : normalizedSeconds
    pendingRenderSeekIntent[deck] = {
      seconds: safeSeconds,
      startedAtMs: nowMs
    }
    deckRenderSyncBaseSec[deck] = safeSeconds
    deckRenderSyncBaseAtMs[deck] = nowMs
    bumpDeckPlaybackSyncRevision(deck)
    if (deck === 'top') {
      topDeckRenderCurrentSeconds.value = safeSeconds
    } else {
      bottomDeckRenderCurrentSeconds.value = safeSeconds
    }
  }

  const syncNativeTransportNow = async () => {
    const snapshotAtMs = performance.now()
    await params.nativeTransport.snapshot(snapshotAtMs)
    syncDeckRenderState({
      nowMs: performance.now(),
      snapshotAtMs
    })
  }

  const markTransportStateFresh = (nowMs = performance.now()) => {
    lastTransportSnapshotAt = nowMs
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
        topPlaying || bottomPlaying
          ? TRANSPORT_SNAPSHOT_FALLBACK_INTERVAL_PLAYING_MS
          : TRANSPORT_SNAPSHOT_FALLBACK_INTERVAL_IDLE_MS
      if (!transportSnapshotInFlight && nowMs - lastTransportSnapshotAt >= pollIntervalMs) {
        transportSnapshotInFlight = true
        markTransportStateFresh(nowMs)
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
    topDeckPlaybackSyncRevision,
    bottomDeckPlaybackSyncRevision,
    resolveDeckRenderCurrentSeconds,
    syncDeckRenderState,
    markTransportStateFresh,
    applyDeckRenderCurrentSeconds,
    startRenderSyncLoop,
    stopRenderSyncLoop
  }
}
