import type {
  IPioneerPlaylistTrack,
  IPioneerPlaylistTreeNode,
  IPioneerPreviewWaveformData
} from '../../../types/globals'

export type RekordboxDesktopLibraryErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'PYTHON_RUNTIME_MISSING'
  | 'BRIDGE_SCRIPT_MISSING'
  | 'HELPER_PROTOCOL_ERROR'
  | 'HELPER_RUNTIME_ERROR'
  | 'PYREKORDBOX_UNAVAILABLE'
  | 'REKORDBOX_NOT_FOUND'
  | 'REKORDBOX_DB_BUSY'
  | 'REKORDBOX_DB_OPEN_FAILED'
  | 'PLAYLIST_NOT_FOUND'
  | 'INVALID_PLAYLIST_ID'

export type RekordboxDesktopLibraryProbe = {
  available: boolean
  supported: boolean
  sourceKey: string
  sourceName: string
  sourceRootPath: string
  dbPath: string
  dbDir: string
  shareDir: string
  playlistTotal: number
  folderTotal: number
  trackTotal: number
  appVersion?: string
  libraryVersion?: string
  errorCode?: RekordboxDesktopLibraryErrorCode
  errorMessage?: string
}

export type RekordboxDesktopLibraryTreeLoadResult = {
  probe: RekordboxDesktopLibraryProbe
  nodes: IPioneerPlaylistTreeNode[]
}

export type RekordboxDesktopLibraryTrackLoadResult = {
  probe: RekordboxDesktopLibraryProbe
  playlistId: number
  playlistName: string
  trackTotal: number
  tracks: IPioneerPlaylistTrack[]
}

export type RekordboxDesktopPreviewWaveformLoadItem = {
  analyzePath: string
  data: IPioneerPreviewWaveformData | null
  error?: string
}

export type RekordboxDesktopHelperError = {
  code?: RekordboxDesktopLibraryErrorCode | string
  message: string
}

export type RekordboxDesktopHelperProbePayload = {
  available?: boolean
  supported?: boolean
  sourceKey?: string
  sourceName?: string
  sourceRootPath?: string
  dbPath?: string
  dbDir?: string
  shareDir?: string
  playlistTotal?: number
  folderTotal?: number
  trackTotal?: number
  appVersion?: string
  libraryVersion?: string
  errorCode?: RekordboxDesktopLibraryErrorCode | string
  errorMessage?: string
}

export type RekordboxDesktopHelperTreeNode = {
  id?: number | string
  parentId?: number | string
  name?: string
  isFolder?: boolean
  order?: number | string
}

export type RekordboxDesktopHelperTreePayload = {
  probe?: RekordboxDesktopHelperProbePayload
  nodes?: RekordboxDesktopHelperTreeNode[]
}

export type RekordboxDesktopHelperTrackRecord = {
  rowKey?: string
  playlistId?: number | string
  playlistName?: string
  trackId?: number | string
  entryIndex?: number | string
  title?: string
  artist?: string
  album?: string
  label?: string
  genre?: string
  filePath?: string
  fileName?: string
  fileFormat?: string
  container?: string
  duration?: string
  durationSec?: number | string
  bpm?: number | string | null
  key?: string | null
  bitrate?: number | string | null
  sampleRate?: number | string | null
  sampleDepth?: number | string | null
  trackNumber?: number | string | null
  discNumber?: number | string | null
  year?: number | string | null
  analyzePath?: string | null
  comment?: string | null
  dateAdded?: string | null
  artworkPath?: string | null
  coverPath?: string | null
}

export type RekordboxDesktopHelperTracksPayload = {
  probe?: RekordboxDesktopHelperProbePayload
  playlistId?: number | string
  playlistName?: string
  trackTotal?: number | string
  tracks?: RekordboxDesktopHelperTrackRecord[]
}
