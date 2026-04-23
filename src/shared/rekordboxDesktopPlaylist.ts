import type { ISongHotCue, ISongMemoryCue } from '../types/globals'

export type RekordboxDesktopPlaylistTrackInput = {
  filePath: string
  displayName?: string
  artist?: string
  album?: string
  genre?: string
  label?: string
  bitrate?: number
  duration?: string
  hotCues?: ISongHotCue[]
  memoryCues?: ISongMemoryCue[]
}

export type RekordboxDesktopWriteAvailabilityStatus =
  | 'available'
  | 'busy'
  | 'unavailable'
  | 'unknown'

export type RekordboxDesktopWriteAvailability = {
  writable: boolean
  status: RekordboxDesktopWriteAvailabilityStatus
  errorCode?: string
  errorMessage?: string
  rekordboxPid?: number
  checkedAt: number
}

export type RekordboxDesktopPlaylistSelectedTracksSource = {
  kind: 'selected-tracks'
  songListUUID: string
  tracks: RekordboxDesktopPlaylistTrackInput[]
}

export type RekordboxDesktopPlaylistSource = {
  kind: 'playlist'
  songListUUID: string
  songListPath: string
  playlistName: string
}

export type RekordboxDesktopPlaylistWriteTarget =
  | {
      mode: 'create'
      playlistName: string
      parentId?: number
    }
  | {
      mode: 'append'
      playlistId: number
      playlistName?: string
    }

export type RekordboxDesktopPlaylistRequest = {
  jobId: string
  target: RekordboxDesktopPlaylistWriteTarget
  source: RekordboxDesktopPlaylistSelectedTracksSource | RekordboxDesktopPlaylistSource
}

export type RekordboxDesktopPlaylistSuccessSummary = {
  mode: 'create' | 'append'
  playlistId: number
  playlistName: string
  trackCount: number
  addedToPlaylistCount: number
  addedToCollectionCount: number
  reusedCollectionCount: number
  skippedDuplicateCount: number
}

export type RekordboxDesktopPlaylistFailureSummary = {
  errorCode: string
  errorMessage: string
  logPath: string
}

export type RekordboxDesktopPlaylistResponse =
  | {
      ok: true
      summary: RekordboxDesktopPlaylistSuccessSummary
    }
  | {
      ok: false
      summary: RekordboxDesktopPlaylistFailureSummary
    }

export type RekordboxDesktopCreateFolderRequest = {
  folderName: string
  parentId?: number
}

export type RekordboxDesktopCreateEmptyPlaylistRequest = {
  playlistName: string
  parentId?: number
}

export type RekordboxDesktopCreateEmptyPlaylistSuccessSummary = {
  playlistId: number
  playlistName: string
  parentId: number
}

export type RekordboxDesktopCreateFolderSuccessSummary = {
  folderId: number
  folderName: string
  parentId: number
}

export type RekordboxDesktopCreateFolderResponse =
  | {
      ok: true
      summary: RekordboxDesktopCreateFolderSuccessSummary
    }
  | {
      ok: false
      summary: RekordboxDesktopPlaylistFailureSummary
    }

export type RekordboxDesktopCreateEmptyPlaylistResponse =
  | {
      ok: true
      summary: RekordboxDesktopCreateEmptyPlaylistSuccessSummary
    }
  | {
      ok: false
      summary: RekordboxDesktopPlaylistFailureSummary
    }

export type RekordboxDesktopMovePlaylistRequest = {
  playlistId: number
  parentId?: number
  seq: number
}

export type RekordboxDesktopMovePlaylistSuccessSummary = {
  playlistId: number
  parentId: number
  seq: number
}

export type RekordboxDesktopMovePlaylistResponse =
  | {
      ok: true
      summary: RekordboxDesktopMovePlaylistSuccessSummary
    }
  | {
      ok: false
      summary: RekordboxDesktopPlaylistFailureSummary
    }

export type RekordboxDesktopRenamePlaylistRequest = {
  playlistId: number
  name: string
}

export type RekordboxDesktopRenamePlaylistSuccessSummary = {
  playlistId: number
  playlistName: string
  parentId: number
  isFolder: boolean
}

export type RekordboxDesktopRenamePlaylistResponse =
  | {
      ok: true
      summary: RekordboxDesktopRenamePlaylistSuccessSummary
    }
  | {
      ok: false
      summary: RekordboxDesktopPlaylistFailureSummary
    }

export type RekordboxDesktopDeletePlaylistRequest = {
  playlistId: number
}

export type RekordboxDesktopDeletePlaylistSuccessSummary = {
  playlistId: number
  parentId: number
  isFolder: boolean
  playlistName: string
}

export type RekordboxDesktopDeletePlaylistResponse =
  | {
      ok: true
      summary: RekordboxDesktopDeletePlaylistSuccessSummary
    }
  | {
      ok: false
      summary: RekordboxDesktopPlaylistFailureSummary
    }

export type RekordboxDesktopRemovePlaylistTracksRequest = {
  playlistId: number
  rowKeys: string[]
}

export type RekordboxDesktopRemovePlaylistTracksSuccessSummary = {
  playlistId: number
  requestedCount: number
  removedCount: number
  skippedCount: number
}

export type RekordboxDesktopRemovePlaylistTracksResponse =
  | {
      ok: true
      summary: RekordboxDesktopRemovePlaylistTracksSuccessSummary
    }
  | {
      ok: false
      summary: RekordboxDesktopPlaylistFailureSummary
    }

export type RekordboxDesktopReorderPlaylistTracksRequest = {
  playlistId: number
  rowKeys: string[]
  targetIndex: number
}

export type RekordboxDesktopReorderPlaylistTracksSuccessSummary = {
  playlistId: number
  requestedCount: number
  movedCount: number
  targetIndex: number
}

export type RekordboxDesktopReorderPlaylistTracksResponse =
  | {
      ok: true
      summary: RekordboxDesktopReorderPlaylistTracksSuccessSummary
    }
  | {
      ok: false
      summary: RekordboxDesktopPlaylistFailureSummary
    }

export type RekordboxDesktopCopyTracksToStorageRequest = {
  targetRootDir: string
  tracks: RekordboxDesktopPlaylistTrackInput[]
}

export type RekordboxDesktopCopyTracksToStorageSuccessSummary = {
  targetRootDir: string
  trackCount: number
  sourceFilePaths: string[]
  copiedTracks: RekordboxDesktopPlaylistTrackInput[]
}

export type RekordboxDesktopCopyTracksToStorageResponse =
  | {
      ok: true
      summary: RekordboxDesktopCopyTracksToStorageSuccessSummary
    }
  | {
      ok: false
      summary: RekordboxDesktopPlaylistFailureSummary
    }

export type RekordboxDesktopCleanupCopiedTracksRequest = {
  filePaths: string[]
}
