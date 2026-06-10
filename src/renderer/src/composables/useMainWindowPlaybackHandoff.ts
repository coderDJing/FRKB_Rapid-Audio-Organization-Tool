import emitter from '@renderer/utils/mitt'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import {
  MAIN_WINDOW_PLAYBACK_SNAPSHOT_REQUEST_EVENT,
  clonePlaybackHandoffSong,
  clonePlaybackHandoffSongList,
  normalizePlaybackHandoffSeconds,
  type MainWindowBrowseMode,
  type MainWindowPlaybackSnapshot,
  type MainWindowPlaybackSnapshotRequest
} from '@renderer/utils/mainWindowPlaybackHandoff'

type RuntimeStore = ReturnType<typeof useRuntimeStore>

const MAIN_WINDOW_PLAYBACK_SNAPSHOT_TIMEOUT_MS = 200

const normalizeMainWindowBrowseMode = (value: unknown): MainWindowBrowseMode =>
  value === 'horizontal' || value === 'edit' ? value : 'browser'

export const useMainWindowPlaybackHandoff = (runtime: RuntimeStore) => {
  let handoffId = 0

  const requestMainWindowPlaybackSnapshot = (sourceMode: MainWindowBrowseMode) =>
    new Promise<MainWindowPlaybackSnapshot | null>((resolve) => {
      let settled = false
      let timer: number | null = window.setTimeout(() => {
        finish(null)
      }, MAIN_WINDOW_PLAYBACK_SNAPSHOT_TIMEOUT_MS)

      const finish = (snapshot: MainWindowPlaybackSnapshot | null) => {
        if (settled) return
        settled = true
        if (timer !== null) {
          window.clearTimeout(timer)
          timer = null
        }
        resolve(snapshot)
      }

      const request: MainWindowPlaybackSnapshotRequest = {
        sourceMode,
        respond: finish
      }
      emitter.emit(MAIN_WINDOW_PLAYBACK_SNAPSHOT_REQUEST_EVENT, request)
    })

  const stageMainWindowPlaybackHandoff = async (targetMode: MainWindowBrowseMode) => {
    const sourceMode = normalizeMainWindowBrowseMode(runtime.mainWindowBrowseMode)
    runtime.mainWindowPlaybackHandoff = null
    if (sourceMode === targetMode) return

    const snapshot = await requestMainWindowPlaybackSnapshot(sourceMode)
    if (!snapshot?.song) return

    const id = ++handoffId
    runtime.mainWindowPlaybackHandoff = {
      id,
      sourceMode,
      targetMode,
      song: clonePlaybackHandoffSong(snapshot.song),
      songListUUID: String(snapshot.songListUUID || '').trim(),
      songListData: clonePlaybackHandoffSongList(snapshot.songListData),
      currentSec: normalizePlaybackHandoffSeconds(snapshot.currentSec),
      shouldPlay: Boolean(snapshot.shouldPlay)
    }
  }

  return {
    stageMainWindowPlaybackHandoff
  }
}
