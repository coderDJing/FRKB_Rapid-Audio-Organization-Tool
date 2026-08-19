export const LIBRARY_RELOCATE_JOURNAL_VERSION = 1
export const LIBRARY_RELOCATE_DEST_MARKER = '.frkb-relocate-in-progress.json'
export const LIBRARY_RELOCATE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024

export const LIBRARY_RELOCATE_MERGE_MARKERS = [
  '.frkb-merge.lock',
  '.frkb-merge',
  '.frkb-curated-merge',
  '.frkb-merge-preflight'
] as const

export type LibraryRelocatePhase =
  | 'prompt'
  | 'abort-only'
  | 'preparing'
  | 'copying'
  | 'renaming'
  | 'verifying'
  | 'switching'
  | 'deleting-source'
  | 'cleanup'
  | 'completed'
  | 'failed'
  | 'source-cleanup-failed'

export type LibraryRelocateErrorCode =
  | 'MERGE_PENDING'
  | 'LIBRARY_BUSY'
  | 'RELOCATE_ACTIVE'
  | 'SOURCE_NOT_READY'
  | 'PARENT_MISSING'
  | 'PARENT_IS_LIBRARY'
  | 'PARENT_INSIDE_LIBRARY'
  | 'DEST_EXISTS'
  | 'NESTED_PATH'
  | 'SAME_PATH'
  | 'INSUFFICIENT_SPACE'
  | 'SPACE_UNAVAILABLE'
  | 'CANCELED'
  | 'COPY_FAILED'
  | 'VERIFY_FAILED'
  | 'DELETE_SOURCE_FAILED'
  | 'JOURNAL_INVALID'
  | 'PARENT_NOT_DIRECTORY'

export type LibraryRelocateJournal = {
  version: typeof LIBRARY_RELOCATE_JOURNAL_VERSION
  sourcePath: string
  destPath: string
  parentPath: string
  folderName: string
  totalBytes: number
  totalFiles: number
  copiedBytes: number
  copiedFiles: number
  phase: LibraryRelocatePhase
  sameVolume: boolean
  createdAt: string
  updatedAt: string
}

export type LibraryRelocatePreview = {
  sourcePath: string
  destPath: string
  parentPath: string
  folderName: string
  totalBytes: number
  totalFiles: number
  sameVolume: boolean
}

export type LibraryRelocateProgress = {
  phase: LibraryRelocatePhase
  copiedBytes: number
  totalBytes: number
  copiedFiles: number
  totalFiles: number
  currentPath: string
  sameVolume: boolean
  sourcePath: string
  destPath: string
  errorCode?: LibraryRelocateErrorCode
  errorMessage?: string
  leftoverSourcePath?: string
  canCancel: boolean
}

export type LibraryInventoryFile = {
  relativePath: string
  absPath: string
  size: number
}

export type LibraryInventory = {
  files: LibraryInventoryFile[]
  totalBytes: number
}

export type PendingRelocateInspection =
  | { kind: 'none' }
  | { kind: 'orphan' }
  | {
      kind: 'prompt'
      journal: LibraryRelocateJournal
      sourceExists: true
      destExists: boolean
    }
  | {
      kind: 'abort-only'
      journal: LibraryRelocateJournal
      sourceExists: false
      destExists: boolean
    }
  | {
      kind: 'auto-finish'
      journal: LibraryRelocateJournal
    }

export class LibraryRelocateError extends Error {
  readonly code: LibraryRelocateErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: LibraryRelocateErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'LibraryRelocateError'
    this.code = code
    this.details = details
  }
}
