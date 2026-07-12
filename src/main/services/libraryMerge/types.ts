export type LibraryMergeMode = 'copy' | 'delete-source'

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
  onProgress?: (progress: LibraryMergeProgress) => void
}

export class LibraryMergeError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'LibraryMergeError'
  }
}
