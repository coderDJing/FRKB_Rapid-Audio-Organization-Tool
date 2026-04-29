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
}

type UseHorizontalBrowseDeckPlaybackControllerParams = {
  touchDeckInteraction: (deck: DeckKey) => void
  notifyDeckSeekIntent: (deck: DeckKey, seconds: number) => void
  nativeTransport: {
    setPlaying: (deck: DeckKey, playing: boolean) => Promise<unknown>
    seek: (deck: DeckKey, currentSec: number) => Promise<unknown>
    beatsync: (deck: DeckKey) => Promise<unknown>
  }
  syncDeckRenderState: () => void
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

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const createDefaultDeckWaveformDragState = (): DeckWaveformDragState => ({
  active: false,
  wasPlaying: false,
  syncEnabledBefore: false,
  token: 0
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

  const traceDeckAction = (deck: DeckKey, stage: string, payload?: Record<string, unknown>) => {
    const filePath = String(params.resolveDeckSong(deck)?.filePath || '').trim()
    sendHorizontalBrowseInteractionTrace(stage, {
      deck,
      filePath,
      ...payload
    })
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

  const handleDeckRawWaveformDragStart = (deck: DeckKey) => {
    params.touchDeckInteraction(deck)
    const dragState = deckWaveformDragState[deck]
    if (dragState.active) return

    const snapshot = params.resolveTransportDeckSnapshot(deck)
    dragState.active = true
    dragState.wasPlaying = snapshot.playing
    dragState.syncEnabledBefore = snapshot.syncEnabled
    dragState.token += 1

    if (!dragState.wasPlaying) return

    const token = dragState.token
    void params.nativeTransport
      .setPlaying(deck, false)
      .then(() => {
        if (!deckWaveformDragState[deck].active || deckWaveformDragState[deck].token !== token) {
          return
        }
        params.syncDeckRenderState()
      })
      .catch(() => {})
  }

  const handleDeckRawWaveformDragEnd = (deck: DeckKey, payload: DeckWaveformDragEndPayload) => {
    params.touchDeckInteraction(deck)
    const dragState = deckWaveformDragState[deck]
    const shouldResume = dragState.wasPlaying
    const syncEnabledBefore = dragState.syncEnabledBefore

    dragState.active = false
    dragState.wasPlaying = false
    dragState.syncEnabledBefore = false
    dragState.token += 1

    if (!payload?.committed) return

    const token = dragState.token
    const targetSec = Math.max(0, Number(payload.anchorSec) || 0)
    params.notifyDeckSeekIntent(deck, targetSec)
    void (async () => {
      await params.nativeTransport.seek(deck, targetSec)
      if (deckWaveformDragState[deck].token !== token) return
      if (shouldResume) {
        if (syncEnabledBefore && !params.isDeckLoopActive(deck)) {
          await params.nativeTransport.beatsync(deck)
          if (deckWaveformDragState[deck].token !== token) return
        }
        await params.nativeTransport.setPlaying(deck, true)
        if (deckWaveformDragState[deck].token !== token) return
      }
      params.syncDeckRenderState()
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
    traceDeckAction(deck, 'seek:intent', {
      source,
      seconds: nextSeconds
    })
    params.notifyDeckSeekIntent(deck, nextSeconds)
    void (async () => {
      await params.nativeTransport.seek(deck, nextSeconds)
      if (
        params.resolveDeckPlaying(deck) &&
        params.resolveTransportDeckSnapshot(deck).syncEnabled &&
        !params.isDeckLoopActive(deck)
      ) {
        await params.nativeTransport.beatsync(deck)
      }
      params.syncDeckRenderState()
    })().catch(() => {})
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
    params.syncDeckRenderState()
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
    params.syncDeckRenderState()
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
        params.syncDeckRenderState()
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
