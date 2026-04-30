import { reactive } from 'vue'
import type { ISongHotCue, ISongInfo, ISongMemoryCue } from 'src/types/globals'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot
} from '@renderer/components/horizontalBrowseNativeTransport'
import {
  beginHorizontalBrowseDeckAction,
  resolveHorizontalBrowseDeckActionElapsedMs
} from '@renderer/components/horizontalBrowseInteractionTimeline'
import { sendHorizontalBrowseInteractionTrace } from '@renderer/components/horizontalBrowseInteractionTrace'
import type { HorizontalBrowseLoopRange } from '@renderer/components/useHorizontalBrowseDeckLoopController'
import { startHorizontalBrowseUserTiming } from '@renderer/components/horizontalBrowseUserTiming'
import { resolveSongCueTimelineDefinition } from '@shared/songCueTimeBasis'
import type { HorizontalBrowseRenderSyncOptions } from '@renderer/components/useHorizontalBrowseRenderSync'
import {
  buildHorizontalBrowseDeckDiagnostics,
  sendHorizontalBrowseDragSyncDiagnostics
} from '@renderer/components/horizontalBrowseDragDiagnostics'

type DeckKey = HorizontalBrowseDeckKey

export type DeckWaveformDragEndPayload = {
  anchorSec: number
  committed: boolean
}

type DeckWaveformDragState = {
  active: boolean
  wasPlaying: boolean
  syncEnabledBefore: boolean
  token: number
  pausePromise: Promise<void> | null
}

type DeckSeekRequest = {
  token: number
  seconds: number
  source: string
  alignToLeader: boolean
}

type UseHorizontalBrowseDeckPlaybackControllerParams = {
  touchDeckInteraction: (deck: DeckKey) => void
  notifyDeckSeekIntent: (deck: DeckKey, seconds: number) => void
  nativeTransport: {
    setPlaying: (deck: DeckKey, playing: boolean) => Promise<unknown>
    seek: (deck: DeckKey, currentSec: number) => Promise<unknown>
    beatsync: (deck: DeckKey) => Promise<unknown>
    alignToLeader: (deck: DeckKey, targetSec?: number) => Promise<unknown>
    snapshot: (nowMs?: number) => Promise<unknown>
  }
  syncDeckRenderState: (input?: number | HorizontalBrowseRenderSyncOptions) => void
  commitDeckStatesToNative: () => Promise<unknown>
  resolveDeckSong: (deck: DeckKey) => ISongInfo | null
  resolveDeckGridBpm: (deck: DeckKey) => number
  resolveDeckDurationSeconds: (deck: DeckKey) => number
  resolveDeckCurrentSeconds: (deck: DeckKey) => number
  resolveDeckPlaying: (deck: DeckKey) => boolean
  resolveDeckLoaded: (deck: DeckKey) => boolean
  resolveTransportDeckSnapshot: (deck: DeckKey) => HorizontalBrowseTransportDeckSnapshot
  isDeckLoopActive: (deck: DeckKey) => boolean
  syncDeckIntoLoopRangeBeforePlay: (deck: DeckKey) => Promise<void>
  applyDeckStoredCueDefinition: (
    deck: DeckKey,
    cue: Pick<ISongMemoryCue, 'sec' | 'isLoop' | 'loopEndSec' | 'source'>
  ) => Promise<HorizontalBrowseLoopRange | null>
}

const BAR_JUMP_BEATS = 4
const PHRASE_JUMP_BEATS = 32
const SYNCED_SEEK_PLAYHEAD_READY_TIMEOUT_MS = 1500
const SYNCED_SEEK_PLAYHEAD_READY_POLL_MS = 24
const SYNCED_SEEK_PREPARE_TIMEOUT_MS = 3000
const SYNCED_SEEK_PREPARE_MAX_ALIGNMENTS = 4
const SYNCED_SEEK_PHASE_EPSILON_BEATS = 0.04

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

const createDefaultDeckWaveformDragState = (): DeckWaveformDragState => ({
  active: false,
  wasPlaying: false,
  syncEnabledBefore: false,
  token: 0,
  pausePromise: null
})

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

  const traceDeckAction = (deck: DeckKey, stage: string, payload?: Record<string, unknown>) => {
    const filePath = String(params.resolveDeckSong(deck)?.filePath || '').trim()
    sendHorizontalBrowseInteractionTrace(stage, {
      deck,
      filePath,
      ...payload
    })
  }

  const stringifyError = (error: unknown) =>
    error instanceof Error ? error.stack || error.message : String(error)

  const buildDeckBeatDiagnostics = (deck: DeckKey) => {
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    const song = params.resolveDeckSong(deck)
    const bpm = Number(params.resolveDeckGridBpm(deck)) || 0
    const firstBeatSec = Math.max(0, Number(song?.firstBeatMs) || 0) / 1000
    const beatSec = bpm > 0 ? 60 / bpm : 0
    const currentSec = Math.max(0, Number(snapshot.currentSec) || 0)
    const renderCurrentSec = Math.max(0, Number(snapshot.renderCurrentSec) || 0)
    const beatDistance = beatSec > 0 ? (currentSec - firstBeatSec) / beatSec : 0
    const renderBeatDistance = beatSec > 0 ? (renderCurrentSec - firstBeatSec) / beatSec : 0
    const barBeatOffset = Number(song?.barBeatOffset) || 0
    const normalizePhase = (value: number, modulo: number) => ((value % modulo) + modulo) % modulo
    return {
      bpm,
      firstBeatSec,
      beatSec,
      currentSec,
      renderCurrentSec,
      beatDistance,
      renderBeatDistance,
      beatPhase: normalizePhase(beatDistance, 1),
      renderBeatPhase: normalizePhase(renderBeatDistance, 1),
      barBeatOffset,
      barPhase: normalizePhase(beatDistance - barBeatOffset, 32)
    }
  }

  const traceDeckDragSync = (deck: DeckKey, stage: string, payload?: Record<string, unknown>) => {
    const otherDeck = deck === 'top' ? 'bottom' : 'top'
    sendHorizontalBrowseDragSyncDiagnostics(stage, {
      deck,
      filePath: String(params.resolveDeckSong(deck)?.filePath || '').trim(),
      targetSnapshot: buildHorizontalBrowseDeckDiagnostics(
        params.resolveTransportDeckSnapshot(deck)
      ),
      otherSnapshot: buildHorizontalBrowseDeckDiagnostics(
        params.resolveTransportDeckSnapshot(otherDeck)
      ),
      targetBeat: buildDeckBeatDiagnostics(deck),
      otherBeat: buildDeckBeatDiagnostics(otherDeck),
      ...payload
    })
  }

  const resolveCircularPhaseDelta = (leftPhase: number, rightPhase: number) => {
    if (!Number.isFinite(leftPhase) || !Number.isFinite(rightPhase)) return null
    const normalized = (((leftPhase - rightPhase) % 1) + 1) % 1
    return normalized > 0.5 ? 1 - normalized : normalized
  }

  const resolveSyncedSeekPhaseDelta = (deck: DeckKey) => {
    const otherDeck = deck === 'top' ? 'bottom' : 'top'
    const targetBeat = buildDeckBeatDiagnostics(deck)
    const otherBeat = buildDeckBeatDiagnostics(otherDeck)
    if (targetBeat.beatSec <= 0 || otherBeat.beatSec <= 0) return null
    return resolveCircularPhaseDelta(targetBeat.beatPhase, otherBeat.beatPhase)
  }

  const resolveSyncedSeekPreparationState = (deck: DeckKey) => {
    const snapshot = params.resolveTransportDeckSnapshot(deck)
    const phaseDelta = resolveSyncedSeekPhaseDelta(deck)
    const phaseReady = phaseDelta === null || phaseDelta <= SYNCED_SEEK_PHASE_EPSILON_BEATS
    return {
      snapshot,
      phaseDelta,
      phaseReady,
      ready: snapshot.playheadLoaded && snapshot.syncLock === 'full' && phaseReady
    }
  }

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

  const isSyncedSeekTokenCurrent = (deck: DeckKey, token: number, source: string) =>
    source === 'detail-drag'
      ? deckWaveformDragState[deck].token === token
      : deckSeekActionToken[deck] === token

  const waitForSyncedSeekPlayheadLoaded = async (
    deck: DeckKey,
    token: number,
    source: string,
    timeoutMs = SYNCED_SEEK_PLAYHEAD_READY_TIMEOUT_MS
  ) => {
    const startedAt = performance.now()
    let lastSnapshot = params.resolveTransportDeckSnapshot(deck)
    if (lastSnapshot.playheadLoaded) return true
    traceDeckDragSync(deck, 'controller-synced-seek-wait-playhead-loaded-start', {
      token,
      source
    })
    while (performance.now() - startedAt < timeoutMs) {
      if (!isSyncedSeekTokenCurrent(deck, token, source)) {
        return false
      }
      await wait(SYNCED_SEEK_PLAYHEAD_READY_POLL_MS)
      await params.nativeTransport.snapshot(performance.now()).catch(() => undefined)
      lastSnapshot = params.resolveTransportDeckSnapshot(deck)
      if (lastSnapshot.playheadLoaded) {
        traceDeckDragSync(deck, 'controller-synced-seek-wait-playhead-loaded-complete', {
          token,
          source,
          elapsedMs: performance.now() - startedAt
        })
        return true
      }
    }
    traceDeckDragSync(deck, 'controller-synced-seek-wait-playhead-loaded-timeout', {
      token,
      source,
      elapsedMs: performance.now() - startedAt,
      timeoutMs,
      playheadLoaded: lastSnapshot.playheadLoaded,
      decoding: lastSnapshot.decoding,
      currentSec: lastSnapshot.currentSec
    })
    return lastSnapshot.playheadLoaded
  }

  const prepareSyncedSeekBeforeResume = async (
    deck: DeckKey,
    token: number,
    source: string,
    requestedSec: number
  ) => {
    const startedAt = performance.now()
    let anchorSec = Math.max(0, Number(requestedSec) || 0)

    traceDeckDragSync(deck, 'controller-synced-seek-prepare-start', {
      token,
      source,
      requestedSec: anchorSec
    })

    for (
      let alignmentAttempt = 1;
      alignmentAttempt <= SYNCED_SEEK_PREPARE_MAX_ALIGNMENTS;
      alignmentAttempt += 1
    ) {
      if (!isSyncedSeekTokenCurrent(deck, token, source)) {
        return null
      }

      const alignStartedAt = performance.now()
      traceDeckDragSync(deck, 'controller-synced-seek-prepare-align-request', {
        token,
        source,
        alignmentAttempt,
        anchorSec
      })
      await params.nativeTransport.alignToLeader(deck, anchorSec)
      params.syncDeckRenderState({ force: 'all' })

      let prepareState = resolveSyncedSeekPreparationState(deck)
      let alignedSec = Math.max(0, Number(prepareState.snapshot.currentSec) || 0)
      params.notifyDeckSeekIntent(deck, alignedSec)
      traceDeckDragSync(deck, 'controller-synced-seek-prepare-align-complete', {
        token,
        source,
        alignmentAttempt,
        anchorSec,
        alignedSec,
        elapsedMs: performance.now() - alignStartedAt,
        playheadLoaded: prepareState.snapshot.playheadLoaded,
        decoding: prepareState.snapshot.decoding,
        syncLock: prepareState.snapshot.syncLock,
        phaseDelta: prepareState.phaseDelta
      })

      if (!isSyncedSeekTokenCurrent(deck, token, source)) {
        return null
      }

      if (!prepareState.snapshot.playheadLoaded) {
        const remainingTimeoutMs = SYNCED_SEEK_PREPARE_TIMEOUT_MS - (performance.now() - startedAt)
        if (remainingTimeoutMs <= 0) break

        const loaded = await waitForSyncedSeekPlayheadLoaded(
          deck,
          token,
          source,
          Math.max(SYNCED_SEEK_PLAYHEAD_READY_POLL_MS, remainingTimeoutMs)
        )
        if (!loaded) {
          traceDeckDragSync(deck, 'controller-synced-seek-prepare-load-failed', {
            token,
            source,
            alignmentAttempt,
            elapsedMs: performance.now() - startedAt
          })
          return null
        }

        await params.nativeTransport.snapshot(performance.now()).catch(() => undefined)
        params.syncDeckRenderState({ force: 'all' })
        prepareState = resolveSyncedSeekPreparationState(deck)
        alignedSec = Math.max(0, Number(prepareState.snapshot.currentSec) || 0)
        params.notifyDeckSeekIntent(deck, alignedSec)
        traceDeckDragSync(deck, 'controller-synced-seek-prepare-loaded', {
          token,
          source,
          alignmentAttempt,
          alignedSec,
          elapsedMs: performance.now() - startedAt,
          playheadLoaded: prepareState.snapshot.playheadLoaded,
          decoding: prepareState.snapshot.decoding,
          syncLock: prepareState.snapshot.syncLock,
          phaseDelta: prepareState.phaseDelta
        })
      }

      if (!isSyncedSeekTokenCurrent(deck, token, source)) {
        return null
      }

      if (prepareState.ready) {
        traceDeckDragSync(deck, 'controller-synced-seek-prepare-ready', {
          token,
          source,
          alignmentAttempt,
          alignedSec,
          elapsedMs: performance.now() - startedAt,
          phaseDelta: prepareState.phaseDelta
        })
        return alignedSec
      }

      if (performance.now() - startedAt >= SYNCED_SEEK_PREPARE_TIMEOUT_MS) {
        break
      }

      anchorSec = alignedSec
      traceDeckDragSync(deck, 'controller-synced-seek-prepare-retry', {
        token,
        source,
        alignmentAttempt,
        anchorSec,
        playheadLoaded: prepareState.snapshot.playheadLoaded,
        syncLock: prepareState.snapshot.syncLock,
        phaseReady: prepareState.phaseReady,
        phaseDelta: prepareState.phaseDelta
      })
    }

    const finalState = resolveSyncedSeekPreparationState(deck)
    traceDeckDragSync(deck, 'controller-synced-seek-prepare-timeout', {
      token,
      source,
      requestedSec,
      elapsedMs: performance.now() - startedAt,
      playheadLoaded: finalState.snapshot.playheadLoaded,
      decoding: finalState.snapshot.decoding,
      syncLock: finalState.snapshot.syncLock,
      phaseDelta: finalState.phaseDelta
    })
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
            const pauseStartedAt = performance.now()
            traceDeckDragSync(deck, 'controller-seek-pause-request', { token, source })
            await params.nativeTransport.setPlaying(deck, false)
            traceDeckDragSync(deck, 'controller-seek-pause-complete', {
              token,
              source,
              elapsedMs: performance.now() - pauseStartedAt
            })

            if (deckSeekActionToken[deck] !== token) {
              traceDeckDragSync(deck, 'controller-seek-stale-after-pause', { token, source })
              continue
            }
          }

          if (alignToLeader) {
            const preparedSec = await prepareSyncedSeekBeforeResume(deck, token, source, targetSec)
            if (deckSeekActionToken[deck] !== token) {
              traceDeckDragSync(deck, 'controller-seek-stale-after-prepare', {
                token,
                source
              })
              continue
            }
            if (preparedSec === null) {
              deckSeekResumeOnComplete[deck] = false
              traceDeckDragSync(deck, 'controller-seek-prepare-aborted', {
                token,
                source
              })
              continue
            }
          } else {
            const seekStartedAt = performance.now()
            await params.nativeTransport.seek(deck, targetSec)
            traceDeckDragSync(deck, 'controller-seek-complete', {
              token,
              source,
              targetSec,
              elapsedMs: performance.now() - seekStartedAt
            })
          }

          if (deckSeekActionToken[deck] !== token) {
            traceDeckDragSync(deck, 'controller-seek-stale-after-seek', { token, source })
            continue
          }

          if (
            !alignToLeader &&
            shouldPauseForSyncedSeek &&
            params.resolveTransportDeckSnapshot(deck).syncEnabled &&
            !params.isDeckLoopActive(deck)
          ) {
            const beatSyncStartedAt = performance.now()
            traceDeckDragSync(deck, 'controller-seek-beatsync-request', { token, source })
            await params.nativeTransport.beatsync(deck)
            traceDeckDragSync(deck, 'controller-seek-beatsync-complete', {
              token,
              source,
              elapsedMs: performance.now() - beatSyncStartedAt
            })

            if (deckSeekActionToken[deck] !== token) {
              traceDeckDragSync(deck, 'controller-seek-stale-after-beatsync', { token, source })
              continue
            }
          }

          if (shouldPauseForSyncedSeek && deckSeekResumeOnComplete[deck]) {
            const resumeStartedAt = performance.now()
            traceDeckDragSync(deck, 'controller-seek-resume-request', { token, source })
            await params.nativeTransport.setPlaying(deck, true)
            traceDeckDragSync(deck, 'controller-seek-resume-complete', {
              token,
              source,
              elapsedMs: performance.now() - resumeStartedAt
            })

            if (deckSeekActionToken[deck] !== token) {
              traceDeckDragSync(deck, 'controller-seek-stale-after-resume', { token, source })
              continue
            }
          }

          if (deckSeekActionToken[deck] !== token) {
            traceDeckDragSync(deck, 'controller-seek-stale-before-render-sync', { token, source })
            continue
          }

          params.syncDeckRenderState({ force: alignToLeader ? 'all' : deck })
          traceDeckDragSync(deck, 'controller-seek-render-sync-complete', { token, source })
          deckSeekResumeOnComplete[deck] = false
        } catch (error) {
          traceDeckDragSync(deck, 'controller-seek-error', {
            token,
            source,
            targetSec,
            error: stringifyError(error)
          })
          if (deckSeekActionToken[deck] === token) {
            if (deckSeekResumeOnComplete[deck] && !params.resolveDeckPlaying(deck)) {
              const resumeStartedAt = performance.now()
              traceDeckDragSync(deck, 'controller-seek-error-resume-request', { token, source })
              try {
                await params.nativeTransport.setPlaying(deck, true)
                traceDeckDragSync(deck, 'controller-seek-error-resume-complete', {
                  token,
                  source,
                  elapsedMs: performance.now() - resumeStartedAt
                })
              } catch (resumeError) {
                traceDeckDragSync(deck, 'controller-seek-error-resume-error', {
                  token,
                  source,
                  error: stringifyError(resumeError)
                })
              }
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

  const handleDeckRawWaveformDragStart = (deck: DeckKey) => {
    params.touchDeckInteraction(deck)
    const dragState = deckWaveformDragState[deck]
    if (dragState.active) {
      traceDeckDragSync(deck, 'controller-drag-start-ignored', { token: dragState.token })
      return
    }

    const snapshot = params.resolveTransportDeckSnapshot(deck)
    dragState.active = true
    dragState.wasPlaying = snapshot.playing
    dragState.syncEnabledBefore = snapshot.syncEnabled
    dragState.token += 1
    traceDeckDragSync(deck, 'controller-drag-start', {
      token: dragState.token,
      wasPlaying: dragState.wasPlaying,
      syncEnabledBefore: dragState.syncEnabledBefore
    })

    if (!dragState.wasPlaying) return

    const token = dragState.token
    const pauseStartedAt = performance.now()
    traceDeckDragSync(deck, 'controller-drag-pause-request', { token })
    dragState.pausePromise = params.nativeTransport
      .setPlaying(deck, false)
      .then(() => {
        const stale =
          !deckWaveformDragState[deck].active || deckWaveformDragState[deck].token !== token
        traceDeckDragSync(deck, 'controller-drag-pause-complete', {
          token,
          stale,
          elapsedMs: performance.now() - pauseStartedAt
        })
        if (stale) {
          return
        }
        params.syncDeckRenderState({ force: deck })
      })
      .catch((error) => {
        traceDeckDragSync(deck, 'controller-drag-pause-error', {
          token,
          error: stringifyError(error)
        })
      })
  }

  const handleDeckRawWaveformDragEnd = (deck: DeckKey, payload: DeckWaveformDragEndPayload) => {
    params.touchDeckInteraction(deck)
    const dragState = deckWaveformDragState[deck]
    const shouldResume = dragState.wasPlaying
    const syncEnabledBefore = dragState.syncEnabledBefore
    const pausePromise = dragState.pausePromise

    dragState.active = false
    dragState.wasPlaying = false
    dragState.syncEnabledBefore = false
    dragState.pausePromise = null
    dragState.token += 1

    const token = dragState.token
    const targetSec = Math.max(0, Number(payload.anchorSec) || 0)
    traceDeckDragSync(deck, 'controller-drag-end', {
      token,
      committed: payload?.committed === true,
      targetSec,
      shouldResume,
      syncEnabledBefore
    })
    if (!payload?.committed) return

    const shouldAlignToLeader =
      shouldResume &&
      syncEnabledBefore &&
      !params.resolveTransportDeckSnapshot(deck).leader &&
      !params.isDeckLoopActive(deck)

    if (!shouldAlignToLeader) {
      params.notifyDeckSeekIntent(deck, targetSec)
      traceDeckDragSync(deck, 'controller-drag-seek-intent-applied', { token, targetSec })
    }
    void (async () => {
      if (pausePromise) {
        await pausePromise
        if (deckWaveformDragState[deck].token !== token) {
          traceDeckDragSync(deck, 'controller-drag-stale-after-pause-await', { token })
          return
        }
      }
      if (shouldAlignToLeader) {
        const preparedSec = await prepareSyncedSeekBeforeResume(
          deck,
          token,
          'detail-drag',
          targetSec
        )
        if (deckWaveformDragState[deck].token !== token) {
          traceDeckDragSync(deck, 'controller-drag-stale-after-prepare', { token })
          return
        }
        if (preparedSec === null) {
          traceDeckDragSync(deck, 'controller-drag-prepare-aborted', { token })
          return
        }
      } else {
        const startedAt = performance.now()
        await params.nativeTransport.seek(deck, targetSec)
        traceDeckDragSync(deck, 'controller-drag-seek-complete', {
          token,
          targetSec,
          elapsedMs: performance.now() - startedAt
        })
        if (deckWaveformDragState[deck].token !== token) {
          traceDeckDragSync(deck, 'controller-drag-seek-stale', { token })
          return
        }
      }
      if (shouldResume) {
        const resumeStartedAt = performance.now()
        traceDeckDragSync(deck, 'controller-drag-resume-request', { token })
        await params.nativeTransport.setPlaying(deck, true)
        traceDeckDragSync(deck, 'controller-drag-resume-complete', {
          token,
          elapsedMs: performance.now() - resumeStartedAt
        })
        if (deckWaveformDragState[deck].token !== token) {
          traceDeckDragSync(deck, 'controller-drag-resume-stale', { token })
          return
        }
      }
      params.syncDeckRenderState({ force: shouldAlignToLeader ? 'all' : deck })
      traceDeckDragSync(deck, 'controller-drag-render-sync-complete', { token })
    })().catch((error) => {
      traceDeckDragSync(deck, 'controller-drag-error', {
        token,
        error: stringifyError(error)
      })
    })
  }

  const seekDeckToSeconds = (deck: DeckKey, seconds: number, source: string) => {
    params.touchDeckInteraction(deck)
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
    traceDeckDragSync(deck, 'controller-seek-start', {
      token,
      source,
      targetSec: nextSeconds,
      alignToLeader,
      running: deckSeekRunning[deck]
    })
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
    await params.nativeTransport.setPlaying(deck, true)
    params.syncDeckRenderState({ force: deck })
  }

  const handleDeckPlayPauseToggle = (deck: DeckKey) => {
    params.touchDeckInteraction(deck)
    if (deckPendingPlayOnLoad[deck] && !params.resolveDeckPlaying(deck)) {
      deckPendingPlayOnLoad[deck] = false
      return
    }
    const nextPlaying = !params.resolveDeckPlaying(deck)
    void (async () => {
      const filePath = String(params.resolveDeckSong(deck)?.filePath || '').trim()
      const finishTiming = startHorizontalBrowseUserTiming(`frkb:hb:play-toggle:${deck}`)
      if (nextPlaying) {
        beginHorizontalBrowseDeckAction(deck, 'play-toggle', filePath)
        queueDeckSongPriorityAnalysis(deck, filePath)
        traceDeckAction(deck, 'play-toggle:start')
      }
      try {
        if (nextPlaying && !params.resolveDeckLoaded(deck)) {
          if (!canDeckExecuteImmediateTransportAction(deck)) {
            deckPendingPlayOnLoad[deck] = true
            return
          }
          deckPendingPlayOnLoad[deck] = false
          await params.commitDeckStatesToNative()
        } else {
          deckPendingPlayOnLoad[deck] = false
        }
        if (nextPlaying) {
          await params.syncDeckIntoLoopRangeBeforePlay(deck)
          if (
            params.resolveTransportDeckSnapshot(deck).syncEnabled &&
            !params.isDeckLoopActive(deck)
          ) {
            await params.commitDeckStatesToNative()
            await params.nativeTransport.beatsync(deck)
          }
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
        params.syncDeckRenderState({ force: deck })
      } finally {
        finishTiming()
      }
    })()
  }

  const maybeResumePendingPlay = (deck: DeckKey, loaded: boolean) => {
    if (!deckPendingPlayOnLoad[deck] || !loaded) return
    deckPendingPlayOnLoad[deck] = false
    void handleDeckPlayPauseToggle(deck)
  }

  return {
    deckPendingPlayOnLoad,
    isDeckWaveformDragging: (deck: DeckKey) => deckWaveformDragState[deck].active,
    handleDeckRawWaveformDragStart,
    handleDeckRawWaveformDragEnd,
    handleDeckPlayheadSeek,
    handleDeckBarJump,
    handleDeckPhraseJump,
    handleDeckSeekPercent,
    handleDeckMemoryCueRecall,
    handleDeckHotCueRecall,
    handleDeckPlayPauseToggle,
    maybeResumePendingPlay
  }
}
