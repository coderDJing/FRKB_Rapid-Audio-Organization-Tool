export type RekordboxXmlExportMode = 'copy' | 'move'

export type RekordboxXmlExportSourceLibraryName = 'FilterLibrary' | 'CuratedLibrary'

export type RekordboxXmlExportTrackInput = {
  filePath: string
  displayName?: string
  artist?: string
  album?: string
  genre?: string
  label?: string
  bitrate?: number
  duration?: string
}

export type RekordboxXmlExportSelectedTracksSource = {
  kind: 'selected-tracks'
  songListUUID: string
  tracks: RekordboxXmlExportTrackInput[]
}

export type RekordboxXmlExportPlaylistSource = {
  kind: 'playlist'
  songListUUID: string
  songListPath: string
  playlistName: string
}

export type RekordboxXmlExportSource =
  | RekordboxXmlExportSelectedTracksSource
  | RekordboxXmlExportPlaylistSource

export type RekordboxXmlExportRequest = {
  jobId: string
  targetRootDir: string
  exportDirName: string
  xmlFileName: string
  xmlPlaylistName: string
  mode: RekordboxXmlExportMode
  sourceLibraryName: RekordboxXmlExportSourceLibraryName
  source: RekordboxXmlExportSource
}

export type RekordboxXmlExportSuccessSummary = {
  mode: RekordboxXmlExportMode
  trackCount: number
  exportDirPath: string
  xmlPath: string
  playlistName: string
  sourceFilePaths: string[]
  exportedFilePaths: string[]
}

export type RekordboxXmlExportFailureSummary = {
  errorCode: string
  errorMessage: string
  rolledBack: boolean
  libraryChanged: boolean
  cancelled: boolean
  logPath: string
}

export type RekordboxXmlExportResponse =
  | {
      ok: true
      summary: RekordboxXmlExportSuccessSummary
    }
  | {
      ok: false
      summary: RekordboxXmlExportFailureSummary
    }
