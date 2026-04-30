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
    const playheadReady = snapshot.playheadLoaded
    return {
      snapshot,
      phaseDelta,
      phaseReady,
      playheadReady,
      ready: playheadReady && snapshot.syncLock === 'full' && phaseReady
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

          if (shouldPauseForSyncedSeek && deckSeekResumeOnComplete[deck]) {
            await params.nativeTransport.setPlaying(deck, true)

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

  const handleDeckRawWaveformDragStart = (deck: DeckKey) => {
    params.touchDeckInteraction(deck)
    const dragState = deckWaveformDragState[deck]
    if (dragState.active) {
      return
    }

    const snapshot = params.resolveTransportDeckSnapshot(deck)
    dragState.active = true
    dragState.wasPlaying = snapshot.playing
    dragState.syncEnabledBefore = snapshot.syncEnabled
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
    if (!payload?.committed) return

    const shouldAlignToLeader =
      shouldResume &&
      syncEnabledBefore &&
      !params.resolveTransportDeckSnapshot(deck).leader &&
      !params.isDeckLoopActive(deck)

    if (!shouldAlignToLeader) {
      params.notifyDeckSeekIntent(deck, targetSec)
    }
    void (async () => {
      if (pausePromise) {
        await pausePromise
        if (deckWaveformDragState[deck].token !== token) {
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
          return
        }
        if (preparedSec === null) {
          return
        }
      } else {
        await params.nativeTransport.seek(deck, targetSec)
        if (deckWaveformDragState[deck].token !== token) {
          return
        }
      }
      if (shouldResume) {
        await params.nativeTransport.setPlaying(deck, true)
        if (deckWaveformDragState[deck].token !== token) {
          return
        }
      }
      params.syncDeckRenderState({ force: shouldAlignToLeader ? 'all' : deck })
    })().catch(() => {})
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
