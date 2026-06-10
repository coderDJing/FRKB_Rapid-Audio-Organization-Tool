import type { ISongInfo } from 'src/types/globals'

export type MainWindowBrowseMode = 'browser' | 'horizontal' | 'edit'

export type MainWindowPlaybackSnapshot = {
  sourceMode: MainWindowBrowseMode
  song: ISongInfo
  songListUUID: string
  songListData: ISongInfo[]
  currentSec: number
  shouldPlay: boolean
}

export type MainWindowPlaybackHandoff = MainWindowPlaybackSnapshot & {
  id: number
  targetMode: MainWindowBrowseMode
}

export type MainWindowPlaybackSnapshotRequest = {
  sourceMode: MainWindowBrowseMode
  respond: (snapshot: MainWindowPlaybackSnapshot | null) => void
}

export const MAIN_WINDOW_PLAYBACK_SNAPSHOT_REQUEST_EVENT = 'main-window-playback:snapshot-request'

export const clonePlaybackHandoffSong = (song: ISongInfo): ISongInfo => ({ ...song })

export const clonePlaybackHandoffSongList = (songs: ISongInfo[] | undefined): ISongInfo[] =>
  Array.isArray(songs) ? songs.map((song) => clonePlaybackHandoffSong(song)) : []

export const normalizePlaybackHandoffSeconds = (value: unknown, durationSec?: number): number => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  const nonNegative = Math.max(0, numeric)
  const duration = Number(durationSec)
  if (!Number.isFinite(duration) || duration <= 0) return nonNegative
  return Math.min(nonNegative, duration)
}

export const isMainWindowPlaybackSnapshotRequest = (
  payload: unknown
): payload is MainWindowPlaybackSnapshotRequest => {
  const candidate =
    payload && typeof payload === 'object'
      ? (payload as { sourceMode?: unknown; respond?: unknown })
      : null
  return (
    (candidate?.sourceMode === 'browser' ||
      candidate?.sourceMode === 'horizontal' ||
      candidate?.sourceMode === 'edit') &&
    typeof candidate.respond === 'function'
  )
}
