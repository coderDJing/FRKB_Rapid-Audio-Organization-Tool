import { ipcMain } from 'electron'
import type {
  HorizontalBrowseDeckKey,
  HorizontalBrowseTransportBandState,
  HorizontalBrowseTransportDeckInput,
  HorizontalBrowseTransportStateInput
} from '@shared/horizontalBrowseTransport'
import { RECORDING_LIBRARY_CHANGED_EVENT } from '@shared/recordingLibrary'
import { horizontalBrowseTransportBridge } from './horizontalBrowseTransportBridge'
import {
  broadcastHorizontalBrowseTransportSnapshot,
  startHorizontalBrowseTransportSnapshotBroadcaster
} from './horizontalBrowseTransportSnapshotBroadcaster'
import mainWindow from '../window/mainWindow'
import { createRecordingOutputPath } from '../recordingLibraryService'
import { markGlobalSongSearchDirty } from '../services/globalSongSearch'

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
    'horizontal-browse-transport:set-playback-rate',
    async (_event, deck: HorizontalBrowseDeckKey, nowMs: number, playbackRate: number) => {
      const snapshot = horizontalBrowseTransportBridge.setPlaybackRate(deck, nowMs, playbackRate)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-tempo-nudge-playback-rate',
    async (_event, deck: HorizontalBrowseDeckKey, nowMs: number, playbackRate: number) => {
      const snapshot = horizontalBrowseTransportBridge.setTempoNudgePlaybackRate(
        deck,
        nowMs,
        playbackRate
      )
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-master-tempo-enabled',
    async (_event, deck: HorizontalBrowseDeckKey, nowMs: number, enabled: boolean) => {
      const snapshot = horizontalBrowseTransportBridge.setMasterTempoEnabled(deck, nowMs, enabled)
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
      payload: {
        filePath?: string
        bpm?: number
        firstBeatMs?: number
        barBeatOffset?: number
        timeBasisOffsetMs?: number
      }
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
    'horizontal-browse-transport:align-to-leader',
    async (
      _event,
      deck: HorizontalBrowseDeckKey,
      nowMs?: number,
      targetSec?: number,
      skipGridSnap?: boolean
    ) => {
      const snapshot = horizontalBrowseTransportBridge.alignToLeader(
        deck,
        nowMs,
        targetSec,
        skipGridSnap
      )
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
    'horizontal-browse-transport:set-band-state',
    async (_event, deck: HorizontalBrowseDeckKey, bands: HorizontalBrowseTransportBandState) => {
      const snapshot = horizontalBrowseTransportBridge.setBandState(deck, bands)
      broadcastHorizontalBrowseTransportSnapshot(snapshot)
      return snapshot
    }
  )

  ipcMain.handle(
    'horizontal-browse-transport:set-cue-monitor-enabled',
    async (_event, deck: HorizontalBrowseDeckKey, enabled: boolean) => {
      const snapshot = horizontalBrowseTransportBridge.setCueMonitorEnabled(deck, enabled)
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
    'horizontal-browse-transport:set-scrub-preview',
    async (
      _event,
      deck: HorizontalBrowseDeckKey,
      nowMs: number,
      active: boolean,
      currentSec: number,
      rate: number
    ) => {
      const snapshot = horizontalBrowseTransportBridge.setScrubPreview(
        deck,
        nowMs,
        active,
        currentSec,
        rate
      )
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
    'horizontal-browse-transport:set-auto-gain-enabled',
    async (_event, deck: HorizontalBrowseDeckKey, enabled: boolean) => {
      const snapshot = horizontalBrowseTransportBridge.setAutoGainEnabled(deck, enabled)
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

  ipcMain.handle('horizontal-browse-transport:recording-start', async () => {
    const outputPath = await createRecordingOutputPath()
    return horizontalBrowseTransportBridge.startRecording(outputPath)
  })

  ipcMain.handle('horizontal-browse-transport:recording-stop', async () => {
    const status = horizontalBrowseTransportBridge.stopRecording()
    if (status.recorded) {
      markGlobalSongSearchDirty('recording-library')
      mainWindow.instance?.webContents.send(RECORDING_LIBRARY_CHANGED_EVENT, status)
    }
    return status
  })

  ipcMain.handle('horizontal-browse-transport:recording-snapshot', async () =>
    horizontalBrowseTransportBridge.recordingSnapshot()
  )
}
