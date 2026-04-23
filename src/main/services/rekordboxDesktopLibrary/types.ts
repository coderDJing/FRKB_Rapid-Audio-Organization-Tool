import type {
  IPioneerPlaylistTrack,
  IPioneerPlaylistTreeNode,
  IPioneerPreviewWaveformData
} from '../../../types/globals'
import type { RekordboxDesktopWriteAvailability } from '../../../shared/rekordboxDesktopPlaylist'

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
  | 'PLAYLIST_PARENT_NOT_FOUND'
  | 'INVALID_PLAYLIST_ID'
  | 'INVALID_PLAYLIST_NAME'
  | 'INVALID_PLAYLIST_FOLDER_NAME'
  | 'TRACK_FILE_MISSING'
  | 'PLAYLIST_CREATE_FAILED'
  | 'PLAYLIST_APPEND_FAILED'
  | 'PLAYLIST_MOVE_FAILED'
  | 'PLAYLIST_RENAME_FAILED'
  | 'PLAYLIST_DELETE_FAILED'
  | 'PLAYLIST_TRACK_REMOVE_FAILED'
  | 'PLAYLIST_TRACK_REORDER_FAILED'
  | 'PLAYLIST_FOLDER_CREATE_FAILED'
  | 'TRACK_IMPORT_FAILED'

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
  writeStatus?: RekordboxDesktopWriteAvailability
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
  writeStatus?: Partial<RekordboxDesktopWriteAvailability>
}

export type RekordboxDesktopHelperWriteAvailabilityPayload =
  Partial<RekordboxDesktopWriteAvailability>

export type RekordboxDesktopHelperTreeNode = {
  id?: number | string
  parentId?: number | string
  name?: string
  isFolder?: boolean
  isSmartPlaylist?: boolean
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

export type RekordboxDesktopHelperCreatePlaylistTrack = {
  filePath?: string
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  genre?: string
  composer?: string
  lyricist?: string
  label?: string
  isrc?: string
  comment?: string
  year?: string
  trackNumber?: number | string | null
  discNumber?: number | string | null
  durationSeconds?: number | string | null
  bitrate?: number | string | null
}

export type RekordboxDesktopHelperCreatePlaylistPayload = {
  probe?: RekordboxDesktopHelperProbePayload
  playlistId?: number | string
  playlistName?: string
  trackTotal?: number | string
  addedToPlaylistCount?: number | string
  addedToCollectionCount?: number | string
  reusedCollectionCount?: number | string
  skippedDuplicateCount?: number | string
}

export type RekordboxDesktopHelperCreateFolderPayload = {
  probe?: RekordboxDesktopHelperProbePayload
  folderId?: number | string
  folderName?: string
  parentId?: number | string
}

export type RekordboxDesktopHelperCreateEmptyPlaylistPayload = {
  probe?: RekordboxDesktopHelperProbePayload
  playlistId?: number | string
  playlistName?: string
  parentId?: number | string
}

export type RekordboxDesktopHelperMovePlaylistPayload = {
  probe?: RekordboxDesktopHelperProbePayload
  playlistId?: number | string
  parentId?: number | string
  seq?: number | string
}

export type RekordboxDesktopHelperRenamePlaylistPayload = {
  probe?: RekordboxDesktopHelperProbePayload
  playlistId?: number | string
  playlistName?: string
  parentId?: number | string
  isFolder?: boolean
}

export type RekordboxDesktopHelperDeletePlaylistPayload = {
  probe?: RekordboxDesktopHelperProbePayload
  playlistId?: number | string
  parentId?: number | string
  playlistName?: string
  isFolder?: boolean
}

export type RekordboxDesktopHelperRemovePlaylistTracksPayload = {
  probe?: RekordboxDesktopHelperProbePayload
  playlistId?: number | string
  requestedCount?: number | string
  removedCount?: number | string
  skippedCount?: number | string
}

export type RekordboxDesktopHelperReorderPlaylistTracksPayload = {
  probe?: RekordboxDesktopHelperProbePayload
  playlistId?: number | string
  requestedCount?: number | string
  movedCount?: number | string
  targetIndex?: number | string
}

export type RekordboxDesktopHelperProgressPayload = {
  stage?: string
  completedTracks?: number | string
  totalTracks?: number | string
}
