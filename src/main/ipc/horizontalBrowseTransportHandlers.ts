import { ipcMain } from 'electron'
import { log } from '../log'

type HorizontalBrowseTransportDeckInput = {
  filePath?: string
  title?: string
  bpm?: number
  firstBeatMs?: number
  durationSec: number
  currentSec: number
  lastObservedAtMs: number
  playing: boolean
  playbackRate: number
}

type HorizontalBrowseTransportStateInput = {
  nowMs?: number
  top: HorizontalBrowseTransportDeckInput
  bottom: HorizontalBrowseTransportDeckInput
}

type RustHorizontalBrowseTransportBinding = {
  horizontalBrowseTransportReset?: () => void
  horizontalBrowseTransportSetDeckState?: (
    deck: string,
    nowMs: number | undefined,
    payload: HorizontalBrowseTransportDeckInput
  ) => unknown
  horizontalBrowseTransportSetState?: (payload: HorizontalBrowseTransportStateInput) => unknown
  horizontalBrowseTransportSetSyncEnabled?: (
    deck: string,
    nowMs: number | undefined,
    enabled: boolean
  ) => unknown
  horizontalBrowseTransportBeatsync?: (deck: string, nowMs?: number) => unknown
  horizontalBrowseTransportSetLeader?: (deck?: string, nowMs?: number) => unknown
  horizontalBrowseTransportSetPlaying?: (deck: string, nowMs: number, playing: boolean) => unknown
  horizontalBrowseTransportSeek?: (deck: string, nowMs: number, currentSec: number) => unknown
  horizontalBrowseTransportSetGain?: (deck: string, gain: number) => unknown
  horizontalBrowseTransportSnapshot?: (nowMs?: number) => unknown
}

const resolveBinding = (): RustHorizontalBrowseTransportBinding => {
  try {
    return require('rust_package') as RustHorizontalBrowseTransportBinding
  } catch (error) {
    log.error('[horizontal-browse-transport] load rust_package failed', error)
    return {}
  }
}

const requireFn = <T extends keyof RustHorizontalBrowseTransportBinding>(
  binding: RustHorizontalBrowseTransportBinding,
  key: T
) => {
  const fn = binding[key]
  if (typeof fn !== 'function') {
    throw new Error(`rust_package.${String(key)} unavailable`)
  }
  return fn as NonNullable<RustHorizontalBrowseTransportBinding[T]>
}

export function registerHorizontalBrowseTransportHandlers() {
  ipcMain.handle('horizontal-browse-transport:reset', async () => {
    const binding = resolveBinding()
    const fn = requireFn(binding, 'horizontalBrowseTransportReset')
    return fn()
  })

  ipcMain.handle(
    'horizontal-browse-transport:set-deck-state',
    async (
      _event,
      deck: string,
      nowMs: number | undefined,
      payload: HorizontalBrowseTransportDeckInput
    ) => {
      const binding = resolveBinding()
      const fn = requireFn(binding, 'horizontalBrowseTransportSetDeckState')
      return fn(deck, nowMs, payload)
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-state',
    async (_event, payload: HorizontalBrowseTransportStateInput) => {
      const binding = resolveBinding()
      const fn = requireFn(binding, 'horizontalBrowseTransportSetState')
      return fn(payload)
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-sync-enabled',
    async (_event, deck: string, nowMs: number | undefined, enabled: boolean) => {
      const binding = resolveBinding()
      const fn = requireFn(binding, 'horizontalBrowseTransportSetSyncEnabled')
      return fn(deck, nowMs, enabled)
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:beatsync',
    async (_event, deck: string, nowMs?: number) => {
      const binding = resolveBinding()
      const fn = requireFn(binding, 'horizontalBrowseTransportBeatsync')
      return fn(deck, nowMs)
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-leader',
    async (_event, deck?: string | null, nowMs?: number) => {
      const binding = resolveBinding()
      const fn = requireFn(binding, 'horizontalBrowseTransportSetLeader')
      return fn(deck || undefined, nowMs)
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-playing',
    async (_event, deck: string, nowMs: number, playing: boolean) => {
      const binding = resolveBinding()
      const fn = requireFn(binding, 'horizontalBrowseTransportSetPlaying')
      return fn(deck, nowMs, playing)
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:seek',
    async (_event, deck: string, nowMs: number, currentSec: number) => {
      const binding = resolveBinding()
      const fn = requireFn(binding, 'horizontalBrowseTransportSeek')
      return fn(deck, nowMs, currentSec)
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-gain',
    async (_event, deck: string, gain: number) => {
      const binding = resolveBinding()
      const fn = requireFn(binding, 'horizontalBrowseTransportSetGain')
      return fn(deck, gain)
    }
  )

  ipcMain.handle('horizontal-browse-transport:snapshot', async (_event, nowMs?: number) => {
    const binding = resolveBinding()
    const fn = requireFn(binding, 'horizontalBrowseTransportSnapshot')
    return fn(nowMs)
  })
}
