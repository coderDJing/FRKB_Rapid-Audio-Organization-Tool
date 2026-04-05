import { reactive } from 'vue'
import type { ISongInfo } from 'src/types/globals'

export type HorizontalBrowseDeckKey = 'top' | 'bottom'

export type HorizontalBrowseTransportDeckSnapshot = {
  deck: string
  label: string
  playing: boolean
  currentSec: number
  durationSec: number
  playbackRate: number
  bpm: number
  effectiveBpm: number
  renderCurrentSec: number
  syncEnabled: boolean
  syncLock: string
  leader: boolean
}

export type HorizontalBrowseTransportSnapshot = {
  leaderDeck?: string
  top: HorizontalBrowseTransportDeckSnapshot
  bottom: HorizontalBrowseTransportDeckSnapshot
}

type LocalDeckState = {
  song: ISongInfo | null
  currentSec: number
  lastObservedAtMs: number
  durationSec: number
  playing: boolean
  playbackRate: number
}

const createEmptyDeckSnapshot = (
  deck: HorizontalBrowseDeckKey
): HorizontalBrowseTransportDeckSnapshot => ({
  deck,
  label: '',
  playing: false,
  currentSec: 0,
  durationSec: 0,
  playbackRate: 1,
  bpm: 0,
  effectiveBpm: 0,
  renderCurrentSec: 0,
  syncEnabled: false,
  syncLock: 'off',
  leader: false
})

const createEmptySnapshot = (): HorizontalBrowseTransportSnapshot => ({
  leaderDeck: undefined,
  top: createEmptyDeckSnapshot('top'),
  bottom: createEmptyDeckSnapshot('bottom')
})

export const createHorizontalBrowseNativeTransport = () => {
  const state = reactive<HorizontalBrowseTransportSnapshot>(createEmptySnapshot())

  const invoke = async (channel: string, ...args: unknown[]) =>
    (await window.electron.ipcRenderer.invoke(
      channel,
      ...args
    )) as HorizontalBrowseTransportSnapshot

  const applySnapshot = (snapshot: HorizontalBrowseTransportSnapshot | null | undefined) => {
    if (!snapshot) return
    state.leaderDeck = snapshot.leaderDeck
    state.top = { ...snapshot.top }
    state.bottom = { ...snapshot.bottom }
  }

  const reset = async () => {
    await window.electron.ipcRenderer.invoke('horizontal-browse-transport:reset')
    applySnapshot(createEmptySnapshot())
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
        durationSec: Number(payload.top.durationSec) || 0,
        currentSec: Number(payload.top.currentSec) || 0,
        lastObservedAtMs: Number(payload.top.lastObservedAtMs) || 0,
        playing: Boolean(payload.top.playing),
        playbackRate: Number(payload.top.playbackRate) || 1
      },
      bottom: {
        filePath: payload.bottom.song?.filePath || '',
        title: payload.bottom.song?.title || payload.bottom.song?.fileName || '',
        bpm: Number(payload.bottom.song?.bpm) || 0,
        firstBeatMs: Number(payload.bottom.song?.firstBeatMs) || 0,
        durationSec: Number(payload.bottom.durationSec) || 0,
        currentSec: Number(payload.bottom.currentSec) || 0,
        lastObservedAtMs: Number(payload.bottom.lastObservedAtMs) || 0,
        playing: Boolean(payload.bottom.playing),
        playbackRate: Number(payload.bottom.playbackRate) || 1
      }
    })
    applySnapshot(snapshot)
    return snapshot
  }

  const beatsync = async (deck: HorizontalBrowseDeckKey) => {
    const snapshot = await invoke('horizontal-browse-transport:beatsync', deck, performance.now())
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
    const snapshot = await invoke(
      'horizontal-browse-transport:set-playing',
      deck,
      performance.now(),
      playing
    )
    applySnapshot(snapshot)
    return snapshot
  }

  const seek = async (deck: HorizontalBrowseDeckKey, currentSec: number) => {
    const snapshot = await invoke(
      'horizontal-browse-transport:seek',
      deck,
      performance.now(),
      currentSec
    )
    applySnapshot(snapshot)
    return snapshot
  }

  const setGain = async (deck: HorizontalBrowseDeckKey, gain: number) => {
    const snapshot = await invoke('horizontal-browse-transport:set-gain', deck, gain)
    applySnapshot(snapshot)
    return snapshot
  }

  const snapshot = async (nowMs?: number) => {
    const next = await invoke('horizontal-browse-transport:snapshot', nowMs)
    applySnapshot(next)
    return next
  }

  return {
    state,
    reset,
    setState,
    beatsync,
    setSyncEnabled,
    setLeader,
    setPlaying,
    seek,
    setGain,
    snapshot
  }
}
