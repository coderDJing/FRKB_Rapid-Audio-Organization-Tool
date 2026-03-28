export type PioneerLibraryKind = 'deviceLibrary' | 'oneLibrary'

export type PioneerDeviceLibraryProbe = {
  hasPioneerFolder: boolean
  hasRekordboxFolder: boolean
  hasExportPdb: boolean
  hasOneLibraryDb: boolean
  hasUsbAnlzFolder: boolean
  pioneerFolderPath: string | null
  rekordboxFolderPath: string | null
  exportPdbPath: string | null
  oneLibraryDbPath: string | null
  usbAnlzPath: string | null
  libraryTypes: PioneerLibraryKind[]
}

export type PioneerRemovableDriveInfo = {
  id: string
  name: string
  path: string
  volumeName: string
  fileSystem: string
  size: number
  freeSpace: number
  driveType: number | null
  driveTypeLabel: string
  isUsb: boolean
  isRemovable: boolean
  isPioneerDeviceLibrary: boolean
  supportedLibraryTypes: PioneerLibraryKind[]
  pioneer: PioneerDeviceLibraryProbe
}

export type PioneerPlaylistNodeRecord = {
  id: number
  parentId: number
  name: string
  isFolder: boolean
  order: number
}

export type PioneerPlaylistTrackRecordRaw = {
  playlistId: number
  trackId: number
  entryIndex: number
  title: string
  artist: string
  album: string
  label: string
  genre: string
  filePath: string
  fileName: string
  keyText: string
  bpm?: number
  durationSec: number
  bitrate?: number
  sampleRate?: number
  sampleDepth?: number
  trackNumber?: number
  discNumber?: number
  year?: number
  analyzePath: string
  comment: string
  dateAdded: string
  artworkId?: number
  artworkPath: string
}

export type PioneerPlaylistTreeLoadResult = {
  databasePath: string
  nodeTotal: number
  folderTotal: number
  playlistTotal: number
  nodes: PioneerPlaylistNodeRecord[]
}

export type PioneerPlaylistTrackLoadResult = {
  databasePath: string
  playlistId: number
  playlistName: string
  trackTotal: number
  tracks: PioneerPlaylistTrackRecordRaw[]
}

export type PioneerDriveEjectFailureCode =
  | 'INVALID_PATH'
  | 'EJECT_COMMAND_FAILED'
  | 'EJECT_TIMEOUT'
  | 'UNSUPPORTED_PLATFORM'

export type PioneerDriveEjectResult = {
  success: boolean
  path: string
  code?: PioneerDriveEjectFailureCode
  detail?: string
}
