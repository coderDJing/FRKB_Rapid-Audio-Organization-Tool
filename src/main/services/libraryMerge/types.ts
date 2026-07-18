export type LibraryMergeMode = 'copy' | 'delete-source'

export type LibraryMergeScope = 'full' | 'curated'

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
  | 'library-tree-watcher'
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
