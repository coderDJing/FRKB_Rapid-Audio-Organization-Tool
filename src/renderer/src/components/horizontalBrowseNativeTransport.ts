import { reactive } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import { sendHorizontalBrowseWaveformTrace } from '@renderer/components/horizontalBrowseWaveformTrace'
import { resolveHorizontalBrowseInteractionElapsedMs } from '@renderer/components/horizontalBrowseInteractionTimeline'
import { startHorizontalBrowseUserTiming } from '@renderer/components/horizontalBrowseUserTiming'
import {
  createEmptyHorizontalBrowseTransportSnapshot,
  HORIZONTAL_BROWSE_TRANSPORT_SNAPSHOT_EVENT,
  type HorizontalBrowseTransportBeatGridInput,
  type HorizontalBrowseDeckKey,
  type HorizontalBrowseTransportSnapshot,
  type HorizontalBrowseTransportVisualizerSnapshot
} from '@shared/horizontalBrowseTransport'
export type {
  HorizontalBrowseTransportBeatGridInput,
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckSnapshot,
  HorizontalBrowseTransportSnapshot,
  HorizontalBrowseTransportVisualizerSnapshot
} from '@shared/horizontalBrowseTransport'

type LocalDeckState = {
  song: ISongInfo | null
  currentSec: number
  lastObservedAtMs: number
  durationSec: number
  playing: boolean
  playbackRate: number
  masterTempoEnabled: boolean
}

type SnapshotListener = (snapshot: HorizontalBrowseTransportSnapshot) => void

export const createHorizontalBrowseNativeTransport = () => {
  const state = reactive<HorizontalBrowseTransportSnapshot>(
    createEmptyHorizontalBrowseTransportSnapshot()
  )
  const lastDeckTraceSignature = new Map<HorizontalBrowseDeckKey, string>()
  const snapshotListeners = new Set<SnapshotListener>()
  let snapshotEventBound = false
  let lastAppliedSnapshotSequence = 0

  const invoke = async (channel: string, ...args: unknown[]) =>
    (await window.electron.ipcRenderer.invoke(
      channel,
      ...args
    )) as HorizontalBrowseTransportSnapshot

  const notifySnapshotListeners = (snapshot: HorizontalBrowseTransportSnapshot) => {
    snapshotListeners.forEach((listener) => {
      try {
        listener(snapshot)
      } catch {}
    })
  }

  const applySnapshot = (
    snapshot: HorizontalBrowseTransportSnapshot | null | undefined,
    notifyListeners = true
  ) => {
    if (!snapshot) return
    const snapshotSequence = Number(snapshot.snapshotSequence)
    if (
      Number.isFinite(snapshotSequence) &&
      snapshotSequence > 0 &&
      lastAppliedSnapshotSequence > 0 &&
      snapshotSequence < lastAppliedSnapshotSequence
    ) {
      return
    }
    if (Number.isFinite(snapshotSequence) && snapshotSequence > lastAppliedSnapshotSequence) {
      lastAppliedSnapshotSequence = snapshotSequence
    }
    state.capturedAtEpochMs = snapshot.capturedAtEpochMs
    state.snapshotSequence = snapshot.snapshotSequence
    state.stateRevision = snapshot.stateRevision
    state.leaderDeck = snapshot.leaderDeck
    state.top = { ...snapshot.top }
    state.bottom = { ...snapshot.bottom }
    if (notifyListeners) {
      notifySnapshotListeners(snapshot)
    }
  }

  const handleSnapshotUpdated = (_event: unknown, snapshot: HorizontalBrowseTransportSnapshot) => {
    applySnapshot(snapshot)
  }

  const ensureSnapshotEventBound = () => {
    if (snapshotEventBound) return
    window.electron.ipcRenderer.on(
      HORIZONTAL_BROWSE_TRANSPORT_SNAPSHOT_EVENT,
      handleSnapshotUpdated
    )
    snapshotEventBound = true
  }

  const maybeUnbindSnapshotEvent = () => {
    if (!snapshotEventBound || snapshotListeners.size > 0) return
    window.electron.ipcRenderer.removeListener(
      HORIZONTAL_BROWSE_TRANSPORT_SNAPSHOT_EVENT,
      handleSnapshotUpdated
    )
    snapshotEventBound = false
  }

  const reset = async () => {
    const snapshot = (await window.electron.ipcRenderer.invoke(
      'horizontal-browse-transport:reset'
    )) as HorizontalBrowseTransportSnapshot
    applySnapshot(snapshot || createEmptyHorizontalBrowseTransportSnapshot())
  }

  const setDeckState = async (deck: HorizontalBrowseDeckKey, payload: LocalDeckState) => {
    const nowMs = performance.now()
    const startedAt = performance.now()
    const filePath = String(payload.song?.filePath || '').trim()
    const finishTiming = startHorizontalBrowseUserTiming(`frkb:hb:native:set-deck-state:${deck}`)
    sendHorizontalBrowseWaveformTrace('transport', 'set-deck-state:start', {
      deck,
      filePath,
      sinceDblclickMs: resolveHorizontalBrowseInteractionElapsedMs(deck, filePath)
    })
    const snapshot = await invoke('horizontal-browse-transport:set-deck-state', deck, nowMs, {
      filePath: payload.song?.filePath || '',
      title: payload.song?.title || payload.song?.fileName || '',
      bpm: Number(payload.song?.bpm) || 0,
      firstBeatMs: Number(payload.song?.firstBeatMs) || 0,
      barBeatOffset: Number(payload.song?.barBeatOffset) || 0,
      timeBasisOffsetMs: Number(payload.song?.timeBasisOffsetMs) || 0,
      durationSec: Number(payload.durationSec) || 0,
      currentSec: Number(payload.currentSec) || 0,
      lastObservedAtMs: Number(payload.lastObservedAtMs) || 0,
      playing: Boolean(payload.playing),
      playbackRate: Number(payload.playbackRate) || 1,
      masterTempoEnabled: payload.masterTempoEnabled !== false
    })
    finishTiming()
    applySnapshot(snapshot)
    const deckSnapshot = snapshot?.[deck]
    const signature = `${filePath}|${Boolean(deckSnapshot?.loaded)}|${Boolean(deckSnapshot?.decoding)}`
    if (lastDeckTraceSignature.get(deck) !== signature) {
      lastDeckTraceSignature.set(deck, signature)
      sendHorizontalBrowseWaveformTrace('transport', 'set-deck-state', {
        deck,
        filePath,
        waitedMs: Number((performance.now() - startedAt).toFixed(1)),
        sinceDblclickMs: resolveHorizontalBrowseInteractionElapsedMs(deck, filePath),
        loaded: deckSnapshot?.loaded === true,
        decoding: deckSnapshot?.decoding === true,
        playing: deckSnapshot?.playing === true,
        currentSec: Number(deckSnapshot?.currentSec) || 0,
        durationSec: Number(deckSnapshot?.durationSec) || 0
      })
    }
    return snapshot
  }

  const setState = async (payload: { top: LocalDeckState; bottom: LocalDeckState }) => {
    const nowMs = performance.now()
    const snapshot = await invoke('horizontal-browse-transport:set-state', {
      nowMs,
      top: {
        filePath: payload.top.song?.filePath || '',
        title: payload.top.song?.title || payload.top.song?.fileName || '',
        bpm: Number(payload.top.song?.bpm) || 0,
        firstBeatMs: Number(payload.top.song?.firstBeatMs) || 0,
        barBeatOffset: Number(payload.top.song?.barBeatOffset) || 0,
        timeBasisOffsetMs: Number(payload.top.song?.timeBasisOffsetMs) || 0,
        durationSec: Number(payload.top.durationSec) || 0,
        currentSec: Number(payload.top.currentSec) || 0,
        lastObservedAtMs: Number(payload.top.lastObservedAtMs) || 0,
        playing: Boolean(payload.top.playing),
        playbackRate: Number(payload.top.playbackRate) || 1,
        masterTempoEnabled: payload.top.masterTempoEnabled !== false
      },
      bottom: {
        filePath: payload.bottom.song?.filePath || '',
        title: payload.bottom.song?.title || payload.bottom.song?.fileName || '',
        bpm: Number(payload.bottom.song?.bpm) || 0,
        firstBeatMs: Number(payload.bottom.song?.firstBeatMs) || 0,
        barBeatOffset: Number(payload.bottom.song?.barBeatOffset) || 0,
        timeBasisOffsetMs: Number(payload.bottom.song?.timeBasisOffsetMs) || 0,
        durationSec: Number(payload.bottom.durationSec) || 0,
        currentSec: Number(payload.bottom.currentSec) || 0,
        lastObservedAtMs: Number(payload.bottom.lastObservedAtMs) || 0,
        playing: Boolean(payload.bottom.playing),
        playbackRate: Number(payload.bottom.playbackRate) || 1,
        masterTempoEnabled: payload.bottom.masterTempoEnabled !== false
      }
    })
    applySnapshot(snapshot)
    return snapshot
  }

  const setBeatGrid = async (
    deck: HorizontalBrowseDeckKey,
    payload: HorizontalBrowseTransportBeatGridInput
  ) => {
    const snapshot = await invoke(
      'horizontal-browse-transport:set-beat-grid',
      deck,
      performance.now(),
      payload
    )
    applySnapshot(snapshot)
    return snapshot
  }

  const beatsync = async (deck: HorizontalBrowseDeckKey) => {
    const snapshot = await invoke('horizontal-browse-transport:beatsync', deck, performance.now())
    applySnapshot(snapshot)
    return snapshot
  }

  const alignToLeader = async (deck: HorizontalBrowseDeckKey, targetSec?: number) => {
    const snapshot = await invoke(
      'horizontal-browse-transport:align-to-leader',
      deck,
      performance.now(),
      Number.isFinite(Number(targetSec)) ? Math.max(0, Number(targetSec)) : undefined
    )
    applySnapshot(snapshot)
    return snapshot
  }

  const setSyncEnabled = async (deck: HorizontalBrowseDeckKey, enabled: boolean) => {
    const snapshot = await invoke(
      'horizontal-browse-transport:set-sync-enabled',
      deck,
      performance.now(),
      enabled
    )
    applySnapshot(snapshot)
    return snapshot
  }

  const setLeader = async (deck?: HorizontalBrowseDeckKey | null) => {
    const snapshot = await invoke(
      'horizontal-browse-transport:set-leader',
      deck || null,
      performance.now()
    )
    applySnapshot(snapshot)
    return snapshot
  }

  const setPlaying = async (deck: HorizontalBrowseDeckKey, playing: boolean) => {
    const finishTiming = startHorizontalBrowseUserTiming(`frkb:hb:native:set-playing:${deck}`)
    const snapshot = await invoke(
      'horizontal-browse-transport:set-playing',
      deck,
      performance.now(),
      playing
    )
    finishTiming()
    applySnapshot(snapshot)
    return snapshot
  }

  const seek = async (deck: HorizontalBrowseDeckKey, currentSec: number) => {
    const finishTiming = startHorizontalBrowseUserTiming(`frkb:hb:native:seek:${deck}`)
    const snapshot = await invoke(
      'horizontal-browse-transport:seek',
      deck,
      performance.now(),
      currentSec
    )
    finishTiming()
    applySnapshot(snapshot)
    return snapshot
  }

  const setMetronome = async (
    deck: HorizontalBrowseDeckKey,
    enabled: boolean,
    volumeLevel: number
  ) => {
    const snapshot = await invoke(
      'horizontal-browse-transport:set-metronome',
      deck,
      enabled,
      volumeLevel
    )
    applySnapshot(snapshot)
    return snapshot
  }

  const setGain = async (deck: HorizontalBrowseDeckKey, gain: number) => {
    const snapshot = await invoke('horizontal-browse-transport:set-gain', deck, gain)
    applySnapshot(snapshot)
    return snapshot
  }

  const toggleLoop = async (deck: HorizontalBrowseDeckKey) => {
    const snapshot = await invoke(
      'horizontal-browse-transport:toggle-loop',
      deck,
      performance.now()
    )
    applySnapshot(snapshot)
    return snapshot
  }

  const stepLoopBeats = async (deck: HorizontalBrowseDeckKey, direction: -1 | 1) => {
    const snapshot = await invoke(
      'horizontal-browse-transport:step-loop-beats',
      deck,
      performance.now(),
      direction
    )
    applySnapshot(snapshot)
    return snapshot
  }

  const setLoopFromRange = async (
    deck: HorizontalBrowseDeckKey,
    startSec: number,
    endSec: number
  ) => {
    const snapshot = await invoke(
      'horizontal-browse-transport:set-loop-from-range',
      deck,
      startSec,
      endSec
    )
    applySnapshot(snapshot)
    return snapshot
  }

  const clearLoop = async (deck: HorizontalBrowseDeckKey) => {
    const snapshot = await invoke('horizontal-browse-transport:clear-loop', deck)
    applySnapshot(snapshot)
    return snapshot
  }

  const setOutputState = async (crossfaderValue: number, masterGain: number) => {
    const snapshot = await invoke(
      'horizontal-browse-transport:set-output-state',
      crossfaderValue,
      masterGain
    )
    applySnapshot(snapshot)
    return snapshot
  }

  const snapshot = async (nowMs?: number) => {
    const finishTiming = startHorizontalBrowseUserTiming('frkb:hb:native:snapshot')
    const next = await invoke('horizontal-browse-transport:snapshot', nowMs)
    finishTiming()
    applySnapshot(next, false)
    return next
  }

  const visualizerSnapshot = async () =>
    (await window.electron.ipcRenderer.invoke(
      'horizontal-browse-transport:visualizer-snapshot'
    )) as HorizontalBrowseTransportVisualizerSnapshot

  const subscribeSnapshot = (listener: SnapshotListener) => {
    snapshotListeners.add(listener)
    ensureSnapshotEventBound()
    return () => {
      snapshotListeners.delete(listener)
      maybeUnbindSnapshotEvent()
    }
  }

  return {
    state,
    reset,
    setDeckState,
    setState,
    setBeatGrid,
    beatsync,
    alignToLeader,
    setSyncEnabled,
    setLeader,
    setPlaying,
    seek,
    setMetronome,
    toggleLoop,
    stepLoopBeats,
    setLoopFromRange,
    clearLoop,
    setGain,
    setOutputState,
    snapshot,
    visualizerSnapshot,
    subscribeSnapshot
  }
}
