import { ipcMain } from 'electron'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportDeckInput,
  HorizontalBrowseTransportStateInput
} from '@shared/horizontalBrowseTransport'
import { horizontalBrowseTransportBridge } from './horizontalBrowseTransportBridge'
import {
  broadcastHorizontalBrowseTransportSnapshot,
  startHorizontalBrowseTransportSnapshotBroadcaster
} from './horizontalBrowseTransportSnapshotBroadcaster'

export function registerHorizontalBrowseTransportHandlers() {
  startHorizontalBrowseTransportSnapshotBroadcaster(() =>
    horizontalBrowseTransportBridge.snapshot()
  )

  ipcMain.handle('horizontal-browse-transport:reset', async () => {
    await horizontalBrowseTransportBridge.reset()
    const snapshot = horizontalBrowseTransportBridge.snapshot()
    broadcastHorizontalBrowseTransportSnapshot(snapshot)
    return snapshot
  })

  ipcMain.handle(
    'horizontal-browse-transport:set-deck-state',
    async (
      _event,
      deck: HorizontalBrowseDeckKey,
      nowMs: number | undefined,
      payload: HorizontalBrowseTransportDeckInput
    ) => {
      const snapshot = horizontalBrowseTransportBridge.setDeckState(deck, nowMs, payload)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-state',
    async (_event, payload: HorizontalBrowseTransportStateInput) => {
      const snapshot = horizontalBrowseTransportBridge.setState(payload)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-beat-grid',
    async (
      _event,
      deck: HorizontalBrowseDeckKey,
      nowMs: number | undefined,
      payload: { filePath?: string; bpm?: number; firstBeatMs?: number }
    ) => {
      const snapshot = horizontalBrowseTransportBridge.setBeatGrid(deck, nowMs, payload)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-sync-enabled',
    async (_event, deck: HorizontalBrowseDeckKey, nowMs: number | undefined, enabled: boolean) => {
      const snapshot = horizontalBrowseTransportBridge.setSyncEnabled(deck, nowMs, enabled)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:beatsync',
    async (_event, deck: HorizontalBrowseDeckKey, nowMs?: number) => {
      const snapshot = horizontalBrowseTransportBridge.beatsync(deck, nowMs)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-leader',
    async (_event, deck?: HorizontalBrowseDeckKey | null, nowMs?: number) => {
      const snapshot = horizontalBrowseTransportBridge.setLeader(deck || undefined, nowMs)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-playing',
    async (_event, deck: HorizontalBrowseDeckKey, nowMs: number, playing: boolean) => {
      const snapshot = horizontalBrowseTransportBridge.setPlaying(deck, nowMs, playing)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:seek',
    async (_event, deck: HorizontalBrowseDeckKey, nowMs: number, currentSec: number) => {
      const snapshot = horizontalBrowseTransportBridge.seek(deck, nowMs, currentSec)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-metronome',
    async (_event, deck: HorizontalBrowseDeckKey, enabled: boolean, volumeLevel: number) => {
      const snapshot = horizontalBrowseTransportBridge.setMetronome(deck, enabled, volumeLevel)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:toggle-loop',
    async (_event, deck: HorizontalBrowseDeckKey, nowMs: number) => {
      const snapshot = horizontalBrowseTransportBridge.toggleLoop(deck, nowMs)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:step-loop-beats',
    async (_event, deck: HorizontalBrowseDeckKey, nowMs: number, direction: number) => {
      const snapshot = horizontalBrowseTransportBridge.stepLoopBeats(deck, nowMs, direction)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-loop-from-range',
    async (_event, deck: HorizontalBrowseDeckKey, startSec: number, endSec: number) => {
      const snapshot = horizontalBrowseTransportBridge.setLoopFromRange(deck, startSec, endSec)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:clear-loop',
    async (_event, deck: HorizontalBrowseDeckKey) => {
      const snapshot = horizontalBrowseTransportBridge.clearLoop(deck)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-gain',
    async (_event, deck: HorizontalBrowseDeckKey, gain: number) => {
      const snapshot = horizontalBrowseTransportBridge.setGain(deck, gain)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-output-state',
    async (_event, crossfaderValue: number, masterGain: number) => {
      const snapshot = horizontalBrowseTransportBridge.setOutputState(crossfaderValue, masterGain)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle('horizontal-browse-transport:snapshot', async (_event, nowMs?: number) =>
    horizontalBrowseTransportBridge.snapshot(nowMs)
  )

  ipcMain.handle('horizontal-browse-transport:visualizer-snapshot', async () =>
    horizontalBrowseTransportBridge.visualizerSnapshot()
  )
}
