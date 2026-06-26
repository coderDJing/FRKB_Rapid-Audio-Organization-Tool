import { onScopeDispose, reactive, watch } from 'vue'
import type { ISongHotCue, ISongMemoryCue } from 'src/types/globals'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/components/horizontalBrowseNativeTransport'
import {
  beginHorizontalBrowseDeckAction,
  resolveHorizontalBrowseDeckActionElapsedMs
} from '@renderer/components/horizontalBrowseInteractionTimeline'
import { sendHorizontalBrowseInteractionTrace } from '@renderer/components/horizontalBrowseInteractionTrace'
import { startHorizontalBrowseUserTiming } from '@renderer/components/horizontalBrowseUserTiming'
import { resolveSongCueTimelineDefinition } from '@shared/songCueTimeBasis'
import { createHorizontalBrowsePendingPlayDiagnostics } from '@renderer/components/horizontalBrowsePendingPlayDiagnostics'
import { createHorizontalBrowsePlaybackStallRecovery } from '@renderer/components/horizontalBrowsePlaybackStallRecovery'
import { handleHorizontalBrowseLinkedRawWaveformDragEnd } from '@renderer/components/horizontalBrowseLinkedRawWaveformDragEnd'
import {
  createDefaultDeckWaveformDragState,
  type DeckScrubPreviewRequest,
  type DeckSeekRequest,
  type DeckWaveformDragEndPayload,
  type DeckWaveformDragState,
  type DeckWaveformScrubPreviewPayload
} from '@renderer/components/horizontalBrowseDeckPlaybackState'
import { createHorizontalBrowseSyncedSeekPreparation } from '@renderer/components/horizontalBrowseSyncedSeekPreparation'
import { resolveHorizontalBrowseBeatSyncDecks } from '@renderer/components/horizontalBrowseBeatSyncDecks'
import { startHorizontalBrowseBeatSyncRawWaveformDragRelease } from '@renderer/components/horizontalBrowseBeatSyncRawWaveformDragRelease'
import type { UseHorizontalBrowseDeckPlaybackControllerParams } from '@renderer/components/useHorizontalBrowseDeckPlaybackControllerTypes'

type DeckKey = HorizontalBrowseDeckKey

const BAR_JUMP_BEATS = 4
const PHRASE_JUMP_BEATS = 32
const SYNCED_SEEK_PLAYHEAD_READY_TIMEOUT_MS = 1500
const SYNCED_SEEK_PLAYHEAD_READY_POLL_MS = 24
const SYNCED_SEEK_PREPARE_TIMEOUT_MS = 3000
const SYNCED_SEEK_PREPARE_MAX_ALIGNMENTS = 4
const DRAG_RELEASE_STABLE_FRAME_WAIT_MS = 120
const PLAYHEAD_READY_NEGATIVE_EPSILON_SEC = 0.0001

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))
const resolveOtherDeck = (deck: DeckKey): DeckKey => (deck === 'top' ? 'bottom' : 'top')
const normalizeLinkedDragVisualPlaybackRate = (value: unknown) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.max(0.25, numeric) : 1
}

const PENDING_PLAY_VISIBLE_DELAY_MS = 250

export const useHorizontalBrowseDeckPlaybackController = (
  params: UseHorizontalBrowseDeckPlaybackControllerParams
) => {
  const deckWaveformDragState = reactive<Record<DeckKey, DeckWaveformDragState>>({
    top: createDefaultDeckWaveformDragState(),
    bottom: createDefaultDeckWaveformDragState()
  })
  const deckPendingPlayOnLoad = reactive<Record<DeckKey, boolean>>({
    top: false,
    bottom: false
  })
  const deckPendingPlayVisible = reactive<Record<DeckKey, boolean>>({
    top: false,
    bottom: false
  })
  const deckPendingPlayVisibleTimers: Record<DeckKey, number | null> = {
    top: null,
    bottom: null
  }
  const deckSeekActionToken: Record<DeckKey, number> = {
    top: 0,
    bottom: 0
  }
  const deckSeekRunning: Record<DeckKey, boolean> = {
    top: false,
    bottom: false
  }
  const deckPendingSeekRequest: Record<DeckKey, DeckSeekRequest | null> = {
    top: null,
    bottom: null
  }
  const deckSeekResumeOnComplete: Record<DeckKey, boolean> = {
    top: false,
    bottom: false
  }
  const deckScrubPreviewInFlight: Record<DeckKey, boolean> = {
    top: false,
    bottom: false
  }
  const deckPendingScrubPreview: Record<DeckKey, DeckScrubPreviewRequest | null> = {
    top: null,
    bottom: null
  }

  const isDualTransportSyncActive = () =>
    Boolean(
      params.resolveDualTransportSyncEnabled?.() &&
      params.resolveDeckSong('top') &&
      params.resolveDeckSong('bottom')
    )

  const ensureDualTransportSync = async (sourceDeck: DeckKey) => {
    if (!isDualTransportSyncActive()) return false
    return Boolean(await params.ensureDualTransportSync?.(sourceDeck))
  }

  const resolveActiveBeatSyncDecks = (deck: DeckKey) =>
    resolveHorizontalBrowseBeatSyncDecks({
      deck,
      hasDeckSong: (targetDeck) => Boolean(params.resolveDeckSong(targetDeck)),
      resolveTransportDeckSnapshot: params.resolveTransportDeckSnapshot
    })

  const resolveLinkedDragDelta = (deck: DeckKey, otherDeck: DeckKey, sourceTargetSec: number) => {
    const sourceDragState = deckWaveformDragState[deck]
    const otherDragState = deckWaveformDragState[otherDeck]
    const sourceVisualPlaybackRate = normalizeLinkedDragVisualPlaybackRate(
      sourceDragState.visualPlaybackRate
    )
    const otherVisualPlaybackRate = normalizeLinkedDragVisualPlaybackRate(
      otherDragState.visualPlaybackRate
    )
    const deltaScale = otherVisualPlaybackRate / sourceVisualPlaybackRate
    const sourceDeltaSec = sourceTargetSec - sourceDragState.startAnchorSec
    const otherDeltaSec = sourceDeltaSec * deltaScale
    const otherTargetSec = clampDeckTimelineSeconds(
      otherDeck,
      otherDragState.startAnchorSec + otherDeltaSec
    )
    return {
      otherTargetSec,
      sourceDeltaSec,
      otherDeltaSec: otherTargetSec - otherDragState.startAnchorSec,
      expectedOtherDeltaSec: otherDeltaSec,
      deltaScale,
      sourceVisualPlaybackRate,
      otherVisualPlaybackRate
    }
  }

  const traceDeckAction = (deck: DeckKey, stage: string, payload?: Record<string, unknown>) => {
    const filePath = String(params.resolveDeckSong(deck)?.filePath || '').trim()
    sendHorizontalBrowseInteractionTrace(stage, {
      deck,
      filePath,
      ...payload
    })
  }

  const clearPendingPlayVisibleTimer = (deck: DeckKey) => {
    const timer = deckPendingPlayVisibleTimers[deck]
    if (timer !== null) {
      window.clearTimeout(timer)
      deckPendingPlayVisibleTimers[deck] = null
    }
  }

  const syncPendingPlayVisible = (deck: DeckKey, pending: boolean) => {
    clearPendingPlayVisibleTimer(deck)
    if (!pending) {
      deckPendingPlayVisible[deck] = false
      return
    }
    deckPendingPlayVisibleTimers[deck] = window.setTimeout(() => {
      deckPendingPlayVisibleTimers[deck] = null
      deckPendingPlayVisible[deck] = deckPendingPlayOnLoad[deck]
    }, PENDING_PLAY_VISIBLE_DELAY_MS)
  }

  const { resolveSyncedSeekPreparationState } = createHorizontalBrowseSyncedSeekPreparation({
    resolveDeckSong: params.resolveDeckSong,
    resolveDeckGridBpm: params.resolveDeckGridBpm,
    resolveTransportDeckSnapshot: params.resolveTransportDeckSnapshot
  })

  const queueDeckSongPriorityAnalysis = (deck: DeckKey, filePath: string) => {
    const normalizedPath = String(filePath || '').trim()
    if (!normalizedPath) return
    window.electron.ipcRenderer.send('key-analysis:queue-playing', {
      filePath: normalizedPath,
      focusSlot: `horizontal-browse-${deck}`
    })
  }

  const canDeckExecuteImmediateTransportAction = (deck: DeckKey) =>
    Boolean(String(params.resolveDeckSong(deck)?.filePath || '').trim())

  const isDeckPlayheadReady = (deck: DeckKey) => {
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    if (snapshot.playheadLoaded || snapshot.playingAudible) return true
    const currentSec = Number(snapshot.currentSec) || 0
    const renderCurrentSec = Number(snapshot.renderCurrentSec) || 0
    return (
      snapshot.loaded &&
      (currentSec < -PLAYHEAD_READY_NEGATIVE_EPSILON_SEC ||
        renderCurrentSec < -PLAYHEAD_READY_NEGATIVE_EPSILON_SEC)
    )
  }

  const prepareDeckPlayheadIfNeeded = async (deck: DeckKey) => {
    if (isDeckPlayheadReady(deck) || !canDeckExecuteImmediateTransportAction(deck)) return
    await params.nativeTransport.preparePlayhead(deck).catch(() => undefined)
  }

  const prepareDeckStableFrameForAnchor = (
    deck: DeckKey,
    seconds: number,
    options?: { timeoutMs?: number }
  ) =>
    params.prepareDeckStableFrameForAnchor?.(deck, seconds, options).catch(() => false) ??
    Promise.resolve(false)

  const resumeDeckPlaybackAfterSeek = async (deck: DeckKey) => {
    await prepareDeckPlayheadIfNeeded(deck)
    params.startDeckRenderPlaybackClock(deck, params.resolveDeckRenderCurrentSeconds(deck))
    await params.nativeTransport.setPlaying(deck, true)
  }

  const pendingPlayDiagnostics = createHorizontalBrowsePendingPlayDiagnostics({
    resolveDeckSong: params.resolveDeckSong,
    resolveTransportDeckSnapshot: params.resolveTransportDeckSnapshot,
    resolveDeckPendingPlay: (deck) => deckPendingPlayOnLoad[deck],
    isDeckPlayheadReady,
    resolveDualTransportSyncActive: isDualTransportSyncActive,
    resolveBrowseViewMode: params.resolveBrowseViewMode
  })
  const playbackStallRecovery = createHorizontalBrowsePlaybackStallRecovery({
    nativeTransport: params.nativeTransport,
    syncDeckRenderState: params.syncDeckRenderState,
    resolveDeckSong: params.resolveDeckSong,
    resolveDeckPlaying: params.resolveDeckPlaying,
    resolveDeckPendingPlay: (deck) => deckPendingPlayOnLoad[deck],
    resolveTransportDeckSnapshot: params.resolveTransportDeckSnapshot
  })

  watch(
    () => [deckPendingPlayOnLoad.top, deckPendingPlayOnLoad.bottom] as const,
    ([topPending, bottomPending]) => {
      syncPendingPlayVisible('top', topPending)
      syncPendingPlayVisible('bottom', bottomPending)
      pendingPlayDiagnostics.sync('top', topPending)
      pendingPlayDiagnostics.sync('bottom', bottomPending)
    }
  )

  onScopeDispose(() => {
    clearPendingPlayVisibleTimer('top')
    clearPendingPlayVisibleTimer('bottom')
    pendingPlayDiagnostics.dispose()
    playbackStallRecovery.dispose()
  })

  const clampDeckTimelineSeconds = (deck: DeckKey, seconds: number) => {
    const numeric = Number(seconds)
    if (!Number.isFinite(numeric)) return 0
    const duration = params.resolveDeckDurationSeconds(deck)
    return duration > 0 ? Math.min(numeric, duration) : numeric
  }

  const resolveSnapshotAnchorSec = (snapshot: HorizontalBrowseTransportDeckSnapshot) => {
    const renderCurrentSec = Number(snapshot.renderCurrentSec)
    if (Number.isFinite(renderCurrentSec)) return renderCurrentSec
    const currentSec = Number(snapshot.currentSec)
    return Number.isFinite(currentSec) ? currentSec : 0
  }

  const isSyncedSeekTokenCurrent = (deck: DeckKey, token: number, _source: string) =>
    deckSeekActionToken[deck] === token

  const waitForSyncedSeekPlayheadReady = async (
    deck: DeckKey,
    token: number,
    source: string,
    timeoutMs = SYNCED_SEEK_PLAYHEAD_READY_TIMEOUT_MS
  ) => {
    const startedAt = performance.now()
    let lastSnapshot = params.resolveTransportDeckSnapshot(deck)
    const isPlayheadReady = () => lastSnapshot.playheadLoaded
    if (isPlayheadReady()) return true
    while (performance.now() - startedAt < timeoutMs) {
      if (!isSyncedSeekTokenCurrent(deck, token, source)) {
        return false
      }
      await wait(SYNCED_SEEK_PLAYHEAD_READY_POLL_MS)
      await params.nativeTransport.snapshot(performance.now()).catch(() => undefined)
      lastSnapshot = params.resolveTransportDeckSnapshot(deck)
      if (isPlayheadReady()) {
        return true
      }
    }
    return isPlayheadReady()
  }

  const prepareSyncedSeekBeforeResume = async (
    deck: DeckKey,
    token: number,
    source: string,
    requestedSec: number
  ) => {
    const startedAt = performance.now()
    let anchorSec = Math.max(0, Number(requestedSec) || 0)

    for (
      let alignmentAttempt = 1;
      alignmentAttempt <= SYNCED_SEEK_PREPARE_MAX_ALIGNMENTS;
      alignmentAttempt += 1
    ) {
      if (!isSyncedSeekTokenCurrent(deck, token, source)) {
        return null
      }

      await params.nativeTransport.alignToLeader(deck, anchorSec)
      params.syncDeckRenderState({ force: 'all' })

      let prepareState = resolveSyncedSeekPreparationState(deck)
      let alignedSec = Math.max(0, Number(prepareState.snapshot.currentSec) || 0)
      params.notifyDeckSeekIntent(deck, alignedSec)

      if (!isSyncedSeekTokenCurrent(deck, token, source)) {
        return null
      }

      if (!prepareState.playheadReady) {
        const remainingTimeoutMs = SYNCED_SEEK_PREPARE_TIMEOUT_MS - (performance.now() - startedAt)
        if (remainingTimeoutMs <= 0) break

        const playheadReady = await waitForSyncedSeekPlayheadReady(
          deck,
          token,
          source,
          Math.max(SYNCED_SEEK_PLAYHEAD_READY_POLL_MS, remainingTimeoutMs)
        )
        if (!playheadReady) {
          return null
        }

        await params.nativeTransport.snapshot(performance.now()).catch(() => undefined)
        params.syncDeckRenderState({ force: 'all' })
        prepareState = resolveSyncedSeekPreparationState(deck)
        alignedSec = Math.max(0, Number(prepareState.snapshot.currentSec) || 0)
        params.notifyDeckSeekIntent(deck, alignedSec)
      }

      if (!isSyncedSeekTokenCurrent(deck, token, source)) {
        return null
      }

      if (prepareState.ready) {
        return alignedSec
      }

      if (performance.now() - startedAt >= SYNCED_SEEK_PREPARE_TIMEOUT_MS) {
        break
      }

      anchorSec = alignedSec
    }

    return null
  }

  const runLatestDeckSeekRequest = (deck: DeckKey) => {
    if (deckSeekRunning[deck]) return
    deckSeekRunning[deck] = true

    void (async () => {
      while (deckPendingSeekRequest[deck]) {
        const request = deckPendingSeekRequest[deck]
        deckPendingSeekRequest[deck] = null

        if (!request) continue

        const { token, seconds: targetSec, source, alignToLeader } = request

        try {
          const shouldPauseForSyncedSeek =
            deckSeekResumeOnComplete[deck] &&
            params.resolveTransportDeckSnapshot(deck).syncEnabled &&
            !params.isDeckLoopActive(deck)

          if (shouldPauseForSyncedSeek && params.resolveDeckPlaying(deck)) {
            await params.nativeTransport.setPlaying(deck, false)

            if (deckSeekActionToken[deck] !== token) {
              continue
            }
          }

          if (alignToLeader) {
            const preparedSec = await prepareSyncedSeekBeforeResume(deck, token, source, targetSec)
            if (deckSeekActionToken[deck] !== token) {
              continue
            }
            if (preparedSec === null) {
              deckSeekResumeOnComplete[deck] = false
              continue
            }
          } else {
            await params.nativeTransport.seek(deck, targetSec)
          }

          if (deckSeekActionToken[deck] !== token) {
            continue
          }

          if (
            !alignToLeader &&
            shouldPauseForSyncedSeek &&
            params.resolveTransportDeckSnapshot(deck).syncEnabled &&
            !params.isDeckLoopActive(deck)
          ) {
            await params.nativeTransport.beatsync(deck)

            if (deckSeekActionToken[deck] !== token) {
              continue
            }
          }

          if (deckSeekResumeOnComplete[deck]) {
            await resumeDeckPlaybackAfterSeek(deck)

            if (deckSeekActionToken[deck] !== token) {
              continue
            }
          }

          if (deckSeekActionToken[deck] !== token) {
            continue
          }

          params.syncDeckRenderState({ force: alignToLeader ? 'all' : deck })
          deckSeekResumeOnComplete[deck] = false
        } catch {
          if (deckSeekActionToken[deck] === token) {
            if (deckSeekResumeOnComplete[deck] && !params.resolveDeckPlaying(deck)) {
              try {
                await params.nativeTransport.setPlaying(deck, true)
              } catch {}
            }
            deckSeekResumeOnComplete[deck] = false
          }
        }
      }
    })().finally(() => {
      deckSeekRunning[deck] = false
      if (deckPendingSeekRequest[deck]) {
        runLatestDeckSeekRequest(deck)
      }
    })
  }

  const startSingleDeckRawWaveformDrag = (deck: DeckKey) => {
    params.touchDeckInteraction(deck)
    const dragState = deckWaveformDragState[deck]
    if (dragState.active) {
      return
    }

    const snapshot = params.resolveTransportDeckSnapshot(deck)
    dragState.active = true
    dragState.wasPlaying = snapshot.playing
    dragState.startAnchorSec = clampDeckTimelineSeconds(deck, resolveSnapshotAnchorSec(snapshot))
    dragState.anchorSec = dragState.startAnchorSec
    dragState.visualPlaybackRate = normalizeLinkedDragVisualPlaybackRate(snapshot.playbackRate)
    dragState.cueCommittedDuringDrag = false
    dragState.token += 1

    if (!dragState.wasPlaying) return

    const token = dragState.token
    dragState.pausePromise = params.nativeTransport
      .setPlaying(deck, false)
      .then(() => {
        const stale =
          !deckWaveformDragState[deck].active || deckWaveformDragState[deck].token !== token
        if (stale) {
          return
        }
        params.syncDeckRenderState({ force: deck })
      })
      .catch(() => {})
  }

  const handleDeckRawWaveformDragStart = (deck: DeckKey) => {
    startSingleDeckRawWaveformDrag(deck)
    if (!isDualTransportSyncActive()) return
    const otherDeck = resolveOtherDeck(deck)
    startSingleDeckRawWaveformDrag(otherDeck)
  }

  const runLatestDeckScrubPreviewRequest = (deck: DeckKey) => {
    if (deckScrubPreviewInFlight[deck]) return
    const request = deckPendingScrubPreview[deck]
    deckPendingScrubPreview[deck] = null
    if (!request) return
    if (
      request.active &&
      (!deckWaveformDragState[deck].active || deckWaveformDragState[deck].token !== request.token)
    ) {
      runLatestDeckScrubPreviewRequest(deck)
      return
    }

    deckScrubPreviewInFlight[deck] = true
    void params.nativeTransport
      .setScrubPreview(deck, request.active, request.anchorSec, request.playbackRate)
      .catch(() => {})
      .finally(() => {
        deckScrubPreviewInFlight[deck] = false
        if (deckPendingScrubPreview[deck]) {
          runLatestDeckScrubPreviewRequest(deck)
        }
      })
  }

  const queueDeckScrubPreviewRequest = (deck: DeckKey, request: DeckScrubPreviewRequest) => {
    deckPendingScrubPreview[deck] = request
    runLatestDeckScrubPreviewRequest(deck)
  }

  const finishDeckWaveformDragState = (deck: DeckKey, targetSec: number) => {
    const dragState = deckWaveformDragState[deck]
    const result = {
      wasActive: dragState.active,
      shouldResume: dragState.wasPlaying,
      pausePromise: dragState.pausePromise,
      token: dragState.token + 1
    }
    dragState.active = false
    dragState.wasPlaying = false
    dragState.pausePromise = null
    dragState.startAnchorSec = 0
    dragState.anchorSec = targetSec
    dragState.visualPlaybackRate = 1
    dragState.token = result.token
    queueDeckScrubPreviewRequest(deck, {
      token: result.token,
      active: false,
      anchorSec: targetSec,
      playbackRate: 0
    })
    return result
  }

  const handleDeckRawWaveformScrubPreview = (
    deck: DeckKey,
    payload: DeckWaveformScrubPreviewPayload
  ) => {
    const dragState = deckWaveformDragState[deck]
    if (!dragState.active) return
    const anchorSec = clampDeckTimelineSeconds(deck, Number(payload.anchorSec) || 0)
    dragState.anchorSec = anchorSec
    queueDeckScrubPreviewRequest(deck, {
      token: dragState.token,
      active: true,
      anchorSec,
      playbackRate: Number(payload.playbackRate) || 0
    })
    if (!isDualTransportSyncActive()) return

    const otherDeck = resolveOtherDeck(deck)
    const otherDragState = deckWaveformDragState[otherDeck]
    if (!otherDragState.active) return
    const linkedDelta = resolveLinkedDragDelta(deck, otherDeck, anchorSec)
    const otherAnchorSec = linkedDelta.otherTargetSec
    otherDragState.anchorSec = otherAnchorSec
    params.holdDeckRenderCurrentSeconds(otherDeck, otherAnchorSec)
    queueDeckScrubPreviewRequest(otherDeck, {
      token: otherDragState.token,
      active: true,
      anchorSec: otherAnchorSec,
      playbackRate: (Number(payload.playbackRate) || 0) * linkedDelta.deltaScale
    })
  }

  const handleLinkedRawWaveformDragEnd = (deck: DeckKey, payload: DeckWaveformDragEndPayload) => {
    return handleHorizontalBrowseLinkedRawWaveformDragEnd({
      deck,
      payload,
      resolveOtherDeck,
      resolveDeckDragState: (targetDeck) => deckWaveformDragState[targetDeck],
      resolveDeckLeader: (targetDeck) => params.resolveTransportDeckSnapshot(targetDeck).leader,
      clampDeckTimelineSeconds,
      resolveLinkedDragDelta,
      finishDeckWaveformDragState,
      notifyDeckSeekIntent: params.notifyDeckSeekIntent,
      setLeader: params.nativeTransport.setLeader,
      prepareDeckPlayheadIfNeeded,
      startDeckRenderPlaybackClock: params.startDeckRenderPlaybackClock,
      commitDeckStatesToNative: params.commitDeckStatesToNative
    })
  }

  const handleDeckRawWaveformDragEnd = (deck: DeckKey, payload: DeckWaveformDragEndPayload) => {
    params.touchDeckInteraction(deck)
    if (isDualTransportSyncActive() && handleLinkedRawWaveformDragEnd(deck, payload)) {
      return
    }
    const dragState = deckWaveformDragState[deck]
    const shouldResume = dragState.wasPlaying
    const pausePromise = dragState.pausePromise
    dragState.active = false
    dragState.wasPlaying = false
    dragState.pausePromise = null
    dragState.startAnchorSec = 0
    dragState.token += 1

    const token = dragState.token
    const targetSec = clampDeckTimelineSeconds(deck, Number(payload.anchorSec) || 0)
    queueDeckScrubPreviewRequest(deck, {
      token,
      active: false,
      anchorSec: targetSec,
      playbackRate: 0
    })
    if (!payload?.committed) return

    const initialActiveSyncDecks = resolveActiveBeatSyncDecks(deck)
    const beatSyncDragRelease = startHorizontalBrowseBeatSyncRawWaveformDragRelease({
      deck,
      targetSec,
      token,
      shouldResume,
      pausePromise,
      activeSyncDecks: initialActiveSyncDecks,
      resolveDeckWaveformDragToken: (targetDeck) => deckWaveformDragState[targetDeck].token,
      resolveTransportDeckSnapshot: params.resolveTransportDeckSnapshot,
      setLeader: params.nativeTransport.setLeader,
      setSyncEnabled: params.nativeTransport.setSyncEnabled,
      alignToLeader: params.nativeTransport.alignToLeader,
      syncDeckRenderState: params.syncDeckRenderState,
      resumeDeckPlaybackAfterSeek,
      beginLinkedGridVisualTransaction: params.beginLinkedGridVisualTransaction,
      commitLinkedGridVisualTransaction: params.commitLinkedGridVisualTransaction,
      cancelLinkedGridVisualTransaction: params.cancelLinkedGridVisualTransaction
    })
    if (beatSyncDragRelease) {
      void beatSyncDragRelease.catch(() => {})
      return
    }

    if (!initialActiveSyncDecks) {
      params.notifyDeckSeekIntent(deck, targetSec)
    }
    void (async () => {
      let activeSyncDecks = initialActiveSyncDecks
      if (pausePromise) {
        await pausePromise
        if (deckWaveformDragState[deck].token !== token) {
          return
        }
      }
      if (activeSyncDecks) {
        if (activeSyncDecks.leader === deck) {
          await params.nativeTransport.setLeader(activeSyncDecks.follower)
          activeSyncDecks = resolveActiveBeatSyncDecks(deck)
        }
        await params.nativeTransport.alignToLeader(deck, targetSec, false)
      } else {
        await params.nativeTransport.seek(deck, targetSec)
      }
      if (deckWaveformDragState[deck].token !== token) {
        return
      }
      const alignedSnapshot = params.resolveTransportDeckSnapshot(deck)
      const alignedTargetSec = Number.isFinite(Number(alignedSnapshot.currentSec))
        ? Number(alignedSnapshot.currentSec)
        : targetSec
      params.notifyDeckSeekIntent(deck, alignedTargetSec)
      if (shouldResume) {
        await prepareDeckStableFrameForAnchor(deck, alignedTargetSec, {
          timeoutMs: DRAG_RELEASE_STABLE_FRAME_WAIT_MS
        })
        if (deckWaveformDragState[deck].token !== token) {
          return
        }
        await resumeDeckPlaybackAfterSeek(deck)
        if (deckWaveformDragState[deck].token !== token) {
          return
        }
      }
      activeSyncDecks = resolveActiveBeatSyncDecks(deck)
      params.syncDeckRenderState({ force: activeSyncDecks ? 'all' : deck })
    })().catch(() => {})
  }

  const seekLinkedDecksToSeconds = (deck: DeckKey, seconds: number, source: string) => {
    const otherDeck = resolveOtherDeck(deck)
    const durationSeconds = params.resolveDeckDurationSeconds(deck)
    const nextSeconds = clampNumber(
      Number(seconds) || 0,
      0,
      durationSeconds > 0 ? durationSeconds : Number.MAX_SAFE_INTEGER
    )
    const currentSeconds = params.resolveDeckCurrentSeconds(deck)
    const otherCurrentSeconds = params.resolveDeckCurrentSeconds(otherDeck)
    const otherDurationSeconds = params.resolveDeckDurationSeconds(otherDeck)
    const sourceVisualPlaybackRate = normalizeLinkedDragVisualPlaybackRate(
      params.resolveTransportDeckSnapshot(deck).playbackRate
    )
    const otherVisualPlaybackRate = normalizeLinkedDragVisualPlaybackRate(
      params.resolveTransportDeckSnapshot(otherDeck).playbackRate
    )
    const deltaScale = otherVisualPlaybackRate / sourceVisualPlaybackRate
    const sourceDeltaSec = nextSeconds - currentSeconds
    const expectedOtherDeltaSec = sourceDeltaSec * deltaScale
    const rawOtherSeconds = otherCurrentSeconds + expectedOtherDeltaSec
    const otherBoundaryExceeded =
      (otherDurationSeconds > 0 && rawOtherSeconds > otherDurationSeconds) || rawOtherSeconds < 0
    const sourceAtEnd = durationSeconds > 0 && nextSeconds >= Math.max(0, durationSeconds - 0.08)
    const otherSeconds = otherBoundaryExceeded
      ? clampNumber(
          rawOtherSeconds,
          0,
          otherDurationSeconds > 0 ? otherDurationSeconds : Number.MAX_SAFE_INTEGER
        )
      : clampDeckTimelineSeconds(otherDeck, rawOtherSeconds)
    const sourceToken = deckSeekActionToken[deck] + 1
    const otherToken = deckSeekActionToken[otherDeck] + 1
    deckSeekActionToken[deck] = sourceToken
    deckSeekActionToken[otherDeck] = otherToken
    const shouldResume = params.resolveDeckPlaying(deck) || params.resolveDeckPlaying(otherDeck)
    deckSeekResumeOnComplete[deck] = shouldResume
    deckSeekResumeOnComplete[otherDeck] = shouldResume

    traceDeckAction(deck, 'seek:intent', {
      source,
      seconds: nextSeconds,
      linked: true
    })
    params.notifyDeckSeekIntent(deck, nextSeconds)
    params.notifyDeckSeekIntent(otherDeck, otherSeconds)

    void (async () => {
      await Promise.all([
        params.nativeTransport.seek(deck, nextSeconds),
        params.nativeTransport.seek(otherDeck, otherSeconds)
      ])
      if (deckSeekActionToken[deck] !== sourceToken) return
      if (deckSeekActionToken[otherDeck] !== otherToken) return

      if (otherBoundaryExceeded) {
        params.deactivateDualTransportSync?.()
        if (shouldResume && !sourceAtEnd) {
          await resumeDeckPlaybackAfterSeek(deck)
        }
        await params.nativeTransport.setPlaying(otherDeck, false)
        deckSeekResumeOnComplete[deck] = false
        deckSeekResumeOnComplete[otherDeck] = false
        params.syncDeckRenderState({ force: 'all' })
        return
      }

      if (shouldResume) {
        await Promise.all([
          prepareDeckPlayheadIfNeeded(deck),
          prepareDeckPlayheadIfNeeded(otherDeck)
        ])
        params.startDeckRenderPlaybackClock(deck, params.resolveDeckRenderCurrentSeconds(deck))
        params.startDeckRenderPlaybackClock(
          otherDeck,
          params.resolveDeckRenderCurrentSeconds(otherDeck)
        )
        await Promise.all([
          params.nativeTransport.setPlaying(deck, true),
          params.nativeTransport.setPlaying(otherDeck, true)
        ])
      }
      if (
        deckSeekActionToken[deck] !== sourceToken ||
        deckSeekActionToken[otherDeck] !== otherToken
      ) {
        return
      }
      deckSeekResumeOnComplete[deck] = false
      deckSeekResumeOnComplete[otherDeck] = false
      params.syncDeckRenderState({ force: 'all' })
    })().catch(() => {
      if (shouldResume && !otherBoundaryExceeded) {
        void params.nativeTransport.setPlaying(deck, true).catch(() => undefined)
        void params.nativeTransport.setPlaying(otherDeck, true).catch(() => undefined)
      }
      deckSeekResumeOnComplete[deck] = false
      deckSeekResumeOnComplete[otherDeck] = false
    })
  }

  const seekDeckToSeconds = (deck: DeckKey, seconds: number, source: string) => {
    params.touchDeckInteraction(deck)
    if (isDualTransportSyncActive()) {
      params.touchDeckInteraction(resolveOtherDeck(deck))
      seekLinkedDecksToSeconds(deck, seconds, source)
      return
    }
    const durationSeconds = params.resolveDeckDurationSeconds(deck)
    const nextSeconds = clampNumber(
      Number(seconds) || 0,
      0,
      durationSeconds > 0 ? durationSeconds : Number.MAX_SAFE_INTEGER
    )
    const token = deckSeekActionToken[deck] + 1
    deckSeekActionToken[deck] = token
    deckSeekResumeOnComplete[deck] =
      deckSeekResumeOnComplete[deck] || params.resolveDeckPlaying(deck)
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    const alignToLeader =
      source === 'overview-or-playhead' &&
      params.resolveDeckPlaying(deck) &&
      snapshot.syncEnabled &&
      !snapshot.leader &&
      !params.isDeckLoopActive(deck)

    traceDeckAction(deck, 'seek:intent', {
      source,
      seconds: nextSeconds
    })
    if (!alignToLeader) {
      params.notifyDeckSeekIntent(deck, nextSeconds)
    }
    deckPendingSeekRequest[deck] = { token, seconds: nextSeconds, source, alignToLeader }
    runLatestDeckSeekRequest(deck)
  }

  const handleDeckPlayheadSeek = (deck: DeckKey, seconds: number) =>
    seekDeckToSeconds(deck, seconds, 'overview-or-playhead')

  const jumpDeckByBeatCount = (deck: DeckKey, direction: -1 | 1, beatCount: number) => {
    const gridBpm = Number(params.resolveDeckGridBpm(deck))
    if (!Number.isFinite(gridBpm) || gridBpm <= 0) return
    const deltaSeconds = (60 / gridBpm) * beatCount * direction
    seekDeckToSeconds(deck, params.resolveDeckCurrentSeconds(deck) + deltaSeconds, 'transport')
  }

  const handleDeckBarJump = (deck: DeckKey, direction: -1 | 1) =>
    jumpDeckByBeatCount(deck, direction, BAR_JUMP_BEATS)

  const handleDeckPhraseJump = (deck: DeckKey, direction: -1 | 1) =>
    jumpDeckByBeatCount(deck, direction, PHRASE_JUMP_BEATS)

  const handleDeckBeatJump = (deck: DeckKey, direction: -1 | 1, beatCount: number) =>
    jumpDeckByBeatCount(deck, direction, beatCount)

  const handleDeckSeekPercent = (deck: DeckKey, percent: number) => {
    const safePercent = clampNumber(Number(percent) || 0, 0, 1)
    if (safePercent === 0) {
      seekDeckToSeconds(deck, 0, 'transport')
      return
    }
    const durationSeconds = params.resolveDeckDurationSeconds(deck)
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return
    seekDeckToSeconds(deck, durationSeconds * safePercent, 'transport')
  }

  const handleDeckMemoryCueRecall = async (
    deck: DeckKey,
    cue: Pick<ISongMemoryCue, 'sec' | 'isLoop' | 'loopEndSec' | 'source'>
  ) => {
    params.touchDeckInteraction(deck)
    await params.applyDeckStoredCueDefinition(deck, cue)
    await params.nativeTransport.setPlaying(deck, false)
    const targetSec =
      resolveSongCueTimelineDefinition(cue, params.resolveDeckSong(deck)?.timeBasisOffsetMs)?.sec ??
      Math.max(0, Number(cue?.sec) || 0)
    params.notifyDeckSeekIntent(deck, targetSec)
    await params.nativeTransport.seek(deck, targetSec)
    params.syncDeckRenderState({ force: deck })
  }

  const handleDeckHotCueRecall = async (
    deck: DeckKey,
    cue: Pick<ISongHotCue, 'sec' | 'isLoop' | 'loopEndSec' | 'source'>
  ) => {
    params.touchDeckInteraction(deck)
    const loopRange = await params.applyDeckStoredCueDefinition(deck, cue)
    const targetSec =
      resolveSongCueTimelineDefinition(cue, params.resolveDeckSong(deck)?.timeBasisOffsetMs)?.sec ??
      Math.max(0, Number(cue?.sec) || 0)
    params.notifyDeckSeekIntent(deck, targetSec)
    await params.nativeTransport.seek(deck, targetSec)
    if (params.resolveTransportDeckSnapshot(deck).syncEnabled && !loopRange) {
      await params.commitDeckStatesToNative()
      await params.nativeTransport.beatsync(deck)
    }
    params.startDeckRenderPlaybackClock(deck, params.resolveDeckRenderCurrentSeconds(deck))
    await params.nativeTransport.setPlaying(deck, true)
    params.syncDeckRenderState({ force: deck })
  }

  const handleLinkedDeckPlayPauseToggle = (deck: DeckKey) => {
    params.touchDeckInteraction(deck)
    const otherDeck = resolveOtherDeck(deck)
    params.touchDeckInteraction(otherDeck)
    const nextPlaying = !params.resolveDeckPlaying(deck)

    if (
      nextPlaying &&
      !params.resolveDeckPlaying(deck) &&
      (deckPendingPlayOnLoad[deck] || deckPendingPlayOnLoad[otherDeck])
    ) {
      return
    }

    void (async () => {
      const finishTiming = startHorizontalBrowseUserTiming(`frkb:hb:linked-play-toggle:${deck}`)
      try {
        if (nextPlaying) {
          for (const targetDeck of [deck, otherDeck] as DeckKey[]) {
            const filePath = String(params.resolveDeckSong(targetDeck)?.filePath || '').trim()
            beginHorizontalBrowseDeckAction(targetDeck, 'play-toggle', filePath)
            queueDeckSongPriorityAnalysis(targetDeck, filePath)
            await params.syncDeckIntoLoopRangeBeforePlay(targetDeck)
          }
          if (!isDeckPlayheadReady(deck) || !isDeckPlayheadReady(otherDeck)) {
            deckPendingPlayOnLoad[deck] = true
            deckPendingPlayOnLoad[otherDeck] = true
            await params.commitDeckStatesToNative()
            await prepareDeckPlayheadIfNeeded(deck)
            await prepareDeckPlayheadIfNeeded(otherDeck)
            await params.nativeTransport.snapshot(performance.now()).catch(() => undefined)
            params.syncDeckRenderState({ force: 'all' })
            if (!isDeckPlayheadReady(deck) || !isDeckPlayheadReady(otherDeck)) {
              return
            }
            deckPendingPlayOnLoad[deck] = false
            deckPendingPlayOnLoad[otherDeck] = false
          }
          await params.commitDeckStatesToNative()
          await ensureDualTransportSync(deck)
          params.startDeckRenderPlaybackClock(deck, params.resolveDeckRenderCurrentSeconds(deck))
          params.startDeckRenderPlaybackClock(
            otherDeck,
            params.resolveDeckRenderCurrentSeconds(otherDeck)
          )
          await params.nativeTransport.setPlaying(deck, true)
          await params.nativeTransport.setPlaying(otherDeck, true)
          params.syncDeckRenderState({ force: 'all' })
          return
        }

        params.holdDeckRenderCurrentSeconds(deck, params.resolveDeckRenderCurrentSeconds(deck))
        params.holdDeckRenderCurrentSeconds(
          otherDeck,
          params.resolveDeckRenderCurrentSeconds(otherDeck)
        )
        await Promise.all([
          params.nativeTransport.setPlaying(deck, false),
          params.nativeTransport.setPlaying(otherDeck, false)
        ])
        params.syncDeckRenderState()
      } finally {
        finishTiming()
      }
    })()
  }

  const executeDeckPlayPauseToggle = async (deck: DeckKey, nextPlaying: boolean) => {
    if (!nextPlaying) {
      params.holdDeckRenderCurrentSeconds(deck, params.resolveDeckRenderCurrentSeconds(deck))
    }
    const filePath = String(params.resolveDeckSong(deck)?.filePath || '').trim()
    const finishTiming = startHorizontalBrowseUserTiming(`frkb:hb:play-toggle:${deck}`)
    if (nextPlaying) {
      beginHorizontalBrowseDeckAction(deck, 'play-toggle', filePath)
      queueDeckSongPriorityAnalysis(deck, filePath)
      traceDeckAction(deck, 'play-toggle:start')
    }
    let playStartSecondsOverride: number | null = null
    try {
      if (nextPlaying && !isDeckPlayheadReady(deck)) {
        if (!canDeckExecuteImmediateTransportAction(deck)) {
          return
        }
        deckPendingPlayOnLoad[deck] = true
        await params.commitDeckStatesToNative()
        await prepareDeckPlayheadIfNeeded(deck)
        await params.nativeTransport.snapshot(performance.now()).catch(() => undefined)
        params.syncDeckRenderState({ force: deck })
        if (!isDeckPlayheadReady(deck)) {
          return
        }
        deckPendingPlayOnLoad[deck] = false
      } else {
        deckPendingPlayOnLoad[deck] = false
      }
      if (nextPlaying) {
        await params.syncDeckIntoLoopRangeBeforePlay(deck)
        const shouldBeatSyncBeforePlay =
          params.resolveTransportDeckSnapshot(deck).syncEnabled && !params.isDeckLoopActive(deck)
        if (shouldBeatSyncBeforePlay) {
          await params.commitDeckStatesToNative()
          await params.nativeTransport.beatsync(deck)
          const alignedSnapshot = params.resolveTransportDeckSnapshot(deck)
          const alignedStartSec = Number(
            alignedSnapshot.renderCurrentSec ?? alignedSnapshot.currentSec
          )
          if (Number.isFinite(alignedStartSec)) {
            playStartSecondsOverride = alignedStartSec
          }
        }
      }
      if (nextPlaying) {
        const renderClockStartSec =
          playStartSecondsOverride ?? params.resolveDeckRenderCurrentSeconds(deck)
        params.startDeckRenderPlaybackClock(deck, renderClockStartSec)
      }
      await params.nativeTransport.setPlaying(deck, nextPlaying)
      if (nextPlaying) {
        traceDeckAction(deck, 'play-toggle:done', {
          sincePlayToggleMs: resolveHorizontalBrowseDeckActionElapsedMs(
            deck,
            'play-toggle',
            filePath
          )
        })
      }
      params.syncDeckRenderState(nextPlaying ? { force: deck } : undefined)
    } finally {
      finishTiming()
    }
  }

  const handleDeckPlayPauseToggle = (deck: DeckKey) => {
    if (isDualTransportSyncActive()) {
      handleLinkedDeckPlayPauseToggle(deck)
      return
    }
    params.touchDeckInteraction(deck)
    if (deckPendingPlayOnLoad[deck] && !params.resolveDeckPlaying(deck)) {
      return
    }
    const nextPlaying = !params.resolveDeckPlaying(deck)
    void executeDeckPlayPauseToggle(deck, nextPlaying)
  }

  const maybeResumePendingPlay = (deck: DeckKey, playheadReady: boolean) => {
    if (!deckPendingPlayOnLoad[deck] || !playheadReady) return
    if (isDualTransportSyncActive()) {
      const otherDeck = resolveOtherDeck(deck)
      if (deckPendingPlayOnLoad[otherDeck] && !isDeckPlayheadReady(otherDeck)) return
      deckPendingPlayOnLoad[deck] = false
      deckPendingPlayOnLoad[otherDeck] = false
      void handleDeckPlayPauseToggle(deck)
      return
    }
    deckPendingPlayOnLoad[deck] = false
    void handleDeckPlayPauseToggle(deck)
  }

  const resolveDeckWaveformDragAnchorSec = (deck: DeckKey): number | null => {
    const dragState = deckWaveformDragState[deck]
    return dragState.active ? dragState.anchorSec : null
  }

  const commitDeckWaveformDragCuePlacement = (deck: DeckKey, cueSec: number): boolean => {
    const dragState = deckWaveformDragState[deck]
    if (!dragState.active || dragState.cueCommittedDuringDrag) return false
    dragState.anchorSec = clampDeckTimelineSeconds(deck, cueSec)
    dragState.cueCommittedDuringDrag = true
    return true
  }

  return {
    deckPendingPlayOnLoad,
    deckPendingPlayVisible,
    isDeckWaveformDragging: (deck: DeckKey) => deckWaveformDragState[deck].active,
    resolveDeckWaveformDragAnchorSec,
    commitDeckWaveformDragCuePlacement,
    handleDeckRawWaveformDragStart,
    handleDeckRawWaveformScrubPreview,
    handleDeckRawWaveformDragEnd,
    handleDeckPlayheadSeek,
    handleDeckBarJump,
    handleDeckPhraseJump,
    handleDeckBeatJump,
    handleDeckSeekPercent,
    handleDeckMemoryCueRecall,
    handleDeckHotCueRecall,
    handleDeckPlayPauseToggle,
    maybeResumePendingPlay
  }
}
