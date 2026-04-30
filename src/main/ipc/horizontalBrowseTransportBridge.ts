import type {
  HorizontalBrowseTransportBeatGridInput,
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckInput,
  HorizontalBrowseTransportSnapshot,
  HorizontalBrowseTransportStateInput,
  HorizontalBrowseTransportVisualizerSnapshot
} from '@shared/horizontalBrowseTransport'
import { log } from '../log'

type RustHorizontalBrowseTransportBinding = {
  horizontalBrowseTransportReset?: () => void
  horizontalBrowseTransportSetDeckState?: (
    deck: HorizontalBrowseDeckKey,
    nowMs: number | undefined,
    payload: HorizontalBrowseTransportDeckInput
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSetState?: (
    payload: HorizontalBrowseTransportStateInput
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSetBeatGrid?: (
    deck: HorizontalBrowseDeckKey,
    nowMs: number | undefined,
    payload: HorizontalBrowseTransportBeatGridInput
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSetSyncEnabled?: (
    deck: HorizontalBrowseDeckKey,
    nowMs: number | undefined,
    enabled: boolean
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportBeatsync?: (
    deck: HorizontalBrowseDeckKey,
    nowMs?: number
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportAlignToLeader?: (
    deck: HorizontalBrowseDeckKey,
    nowMs?: number,
    targetSec?: number
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSetLeader?: (
    deck?: HorizontalBrowseDeckKey,
    nowMs?: number
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSetPlaying?: (
    deck: HorizontalBrowseDeckKey,
    nowMs: number,
    playing: boolean
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSeek?: (
    deck: HorizontalBrowseDeckKey,
    nowMs: number,
    currentSec: number
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSetMetronome?: (
    deck: HorizontalBrowseDeckKey,
    enabled: boolean,
    volumeLevel: number
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportToggleLoop?: (
    deck: HorizontalBrowseDeckKey,
    nowMs: number
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportStepLoopBeats?: (
    deck: HorizontalBrowseDeckKey,
    nowMs: number,
    direction: number
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSetLoopFromRange?: (
    deck: HorizontalBrowseDeckKey,
    startSec: number,
    endSec: number
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportClearLoop?: (
    deck: HorizontalBrowseDeckKey
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSetGain?: (
    deck: HorizontalBrowseDeckKey,
    gain: number
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSetOutputState?: (
    crossfaderValue: number,
    masterGain: number
  ) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportSnapshot?: (nowMs?: number) => HorizontalBrowseTransportSnapshot
  horizontalBrowseTransportVisualizerSnapshot?: () => HorizontalBrowseTransportVisualizerSnapshot
}

let cachedBinding: RustHorizontalBrowseTransportBinding | null = null

const resolveBinding = (): RustHorizontalBrowseTransportBinding => {
  if (cachedBinding) return cachedBinding
  try {
    cachedBinding = require('rust_package') as RustHorizontalBrowseTransportBinding
    return cachedBinding
  } catch (error) {
    log.error('[horizontal-browse-transport] load rust_package failed', error)
    return {}
  }
}

const requireFn = <T extends keyof RustHorizontalBrowseTransportBinding>(
  key: T
): NonNullable<RustHorizontalBrowseTransportBinding[T]> => {
  const fn = resolveBinding()[key]
  if (typeof fn !== 'function') {
    throw new Error(`rust_package.${String(key)} unavailable`)
  }
  return fn as NonNullable<RustHorizontalBrowseTransportBinding[T]>
}

export const horizontalBrowseTransportBridge = {
  reset() {
    return requireFn('horizontalBrowseTransportReset')()
  },
  setDeckState(
    deck: HorizontalBrowseDeckKey,
    nowMs: number | undefined,
    payload: HorizontalBrowseTransportDeckInput
  ) {
    return requireFn('horizontalBrowseTransportSetDeckState')(deck, nowMs, payload)
  },
  setState(payload: HorizontalBrowseTransportStateInput) {
    return requireFn('horizontalBrowseTransportSetState')(payload)
  },
  setBeatGrid(
    deck: HorizontalBrowseDeckKey,
    nowMs: number | undefined,
    payload: HorizontalBrowseTransportBeatGridInput
  ) {
    return requireFn('horizontalBrowseTransportSetBeatGrid')(deck, nowMs, payload)
  },
  setSyncEnabled(deck: HorizontalBrowseDeckKey, nowMs: number | undefined, enabled: boolean) {
    return requireFn('horizontalBrowseTransportSetSyncEnabled')(deck, nowMs, enabled)
  },
  beatsync(deck: HorizontalBrowseDeckKey, nowMs?: number) {
    return requireFn('horizontalBrowseTransportBeatsync')(deck, nowMs)
  },
  alignToLeader(deck: HorizontalBrowseDeckKey, nowMs?: number, targetSec?: number) {
    return requireFn('horizontalBrowseTransportAlignToLeader')(deck, nowMs, targetSec)
  },
  setLeader(deck?: HorizontalBrowseDeckKey, nowMs?: number) {
    return requireFn('horizontalBrowseTransportSetLeader')(deck, nowMs)
  },
  setPlaying(deck: HorizontalBrowseDeckKey, nowMs: number, playing: boolean) {
    return requireFn('horizontalBrowseTransportSetPlaying')(deck, nowMs, playing)
  },
  seek(deck: HorizontalBrowseDeckKey, nowMs: number, currentSec: number) {
    return requireFn('horizontalBrowseTransportSeek')(deck, nowMs, currentSec)
  },
  setMetronome(deck: HorizontalBrowseDeckKey, enabled: boolean, volumeLevel: number) {
    return requireFn('horizontalBrowseTransportSetMetronome')(deck, enabled, volumeLevel)
  },
  toggleLoop(deck: HorizontalBrowseDeckKey, nowMs: number) {
    return requireFn('horizontalBrowseTransportToggleLoop')(deck, nowMs)
  },
  stepLoopBeats(deck: HorizontalBrowseDeckKey, nowMs: number, direction: number) {
    return requireFn('horizontalBrowseTransportStepLoopBeats')(deck, nowMs, direction)
  },
  setLoopFromRange(deck: HorizontalBrowseDeckKey, startSec: number, endSec: number) {
    return requireFn('horizontalBrowseTransportSetLoopFromRange')(deck, startSec, endSec)
  },
  clearLoop(deck: HorizontalBrowseDeckKey) {
    return requireFn('horizontalBrowseTransportClearLoop')(deck)
  },
  setGain(deck: HorizontalBrowseDeckKey, gain: number) {
    return requireFn('horizontalBrowseTransportSetGain')(deck, gain)
  },
  setOutputState(crossfaderValue: number, masterGain: number) {
    return requireFn('horizontalBrowseTransportSetOutputState')(crossfaderValue, masterGain)
  },
  snapshot(nowMs?: number) {
    return requireFn('horizontalBrowseTransportSnapshot')(nowMs)
  },
  visualizerSnapshot() {
    return requireFn('horizontalBrowseTransportVisualizerSnapshot')()
  }
}
