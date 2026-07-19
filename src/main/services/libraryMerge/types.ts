export type LibraryMergeMode = 'copy' | 'delete-source'

export type LibraryMergeScope = 'full' | 'curated'

/**
 * Curated-merge only. Full library merge always renames colliding playlists.
 * - rename: keep both playlists; source gets ` (from <label>)` suffix
 * - merge-into: import source tracks into the existing same-name playlist
 */
export type LibraryMergeDuplicatePlaylistPolicy = 'rename' | 'merge-into'

export type LibraryMergePhase =
  | 'preflight'
  | 'staging'
  | 'promoting'
  | 'committing'
  | 'deleting-source'
  | 'completed'
  | 'failed'

export type LibraryMergeProgress = {
  phase: LibraryMergePhase
  copiedBytes: number
  totalBytes: number
  copiedFiles: number
  totalFiles: number
  currentPath?: string
}

export type LibraryMergeCapacity = {
  payloadBytes: number
  databasePeakBytes: number
  sourceSchemaSnapshotBytes: number
  journalBytes: number
  safetyBytes: number
  requiredBytes: number
  remainingRequiredBytes: number
  availableBytes: number | null
}

export type LibraryMergePlanSummary = {
  sourceRoot: string
  targetRoot: string
  sourceLabel: string
  sourceManifestUuid: string
  targetManifestUuid: string
  songListCount: number
  renamedSongListCount: number
  /** Curated merge-into: same-name source playlists mapped onto existing target playlists. */
  mergedIntoSongListCount: number
  duplicatePlaylistPolicy: LibraryMergeDuplicatePlaylistPolicy
  copiedFileCount: number
  copiedBytes: number
  capacity: LibraryMergeCapacity
}

export type LibraryMergeResult = LibraryMergePlanSummary & {
  mode: LibraryMergeMode
  scope: LibraryMergeScope
  sourceDeleted: boolean
  sourceDeleteError?: string
  copiedAnalysisRows: number
  mergedFingerprintCount: number
}

export type LibraryMergeOptions = {
  sourceRoot: string
  targetRoot: string
  appVersion?: string
  mode: LibraryMergeMode
  scope?: LibraryMergeScope
  /** Only honored for curated scope; full merge always uses rename. */
  duplicatePlaylistPolicy?: LibraryMergeDuplicatePlaylistPolicy
  onProgress?: (progress: LibraryMergeProgress) => void
}

export type LibraryMergeBusyReason =
  | 'key-analysis'
  | 'metadata-auto-fill'
  | 'mixtape-waveform'
  | 'mixtape-raw-waveform'
  | 'background-task'
  | 'import'
  | 'audio-conversion'
  | 'playlist-batch-rename'
  | 'mixtape-stem'
  | 'mixtape-window'
  | 'recording'

export type LibraryMergeBusyClassification = {
  cancellable: LibraryMergeBusyReason[]
  blocking: LibraryMergeBusyReason[]
}

export class LibraryMergeError extends Error {
  readonly code: string
  readonly details?: Record<string, unknown>

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.code = code
    this.name = 'LibraryMergeError'
    this.details = details
  }
}
