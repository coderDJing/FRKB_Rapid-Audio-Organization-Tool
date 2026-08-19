import fs from 'fs-extra'
import path from 'node:path'
import url from '../../url'
import {
  LIBRARY_RELOCATE_JOURNAL_VERSION,
  type LibraryRelocateJournal,
  type LibraryRelocatePhase
} from './types'

const getJournalPath = (): string =>
  path.join(url.userDataDir, 'config', 'libraryRelocateJournal.json')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const isPhase = (value: unknown): value is LibraryRelocatePhase =>
  typeof value === 'string' &&
  [
    'prompt',
    'abort-only',
    'preparing',
    'copying',
    'renaming',
    'verifying',
    'switching',
    'deleting-source',
    'cleanup',
    'completed',
    'failed',
    'source-cleanup-failed'
  ].includes(value)

const parseJournal = (value: unknown): LibraryRelocateJournal | null => {
  if (!isRecord(value)) return null
  if (value.version !== LIBRARY_RELOCATE_JOURNAL_VERSION) return null
  if (!isPhase(value.phase)) return null
  const sourcePath = String(value.sourcePath || '').trim()
  const destPath = String(value.destPath || '').trim()
  const parentPath = String(value.parentPath || '').trim()
  const folderName = String(value.folderName || '').trim()
  if (!sourcePath || !destPath || !parentPath || !folderName) return null
  const totalBytes = Number(value.totalBytes)
  const totalFiles = Number(value.totalFiles)
  const copiedBytes = Number(value.copiedBytes)
  const copiedFiles = Number(value.copiedFiles)
  return {
    version: LIBRARY_RELOCATE_JOURNAL_VERSION,
    sourcePath,
    destPath,
    parentPath,
    folderName,
    totalBytes: Number.isFinite(totalBytes) && totalBytes >= 0 ? totalBytes : 0,
    totalFiles: Number.isFinite(totalFiles) && totalFiles >= 0 ? totalFiles : 0,
    copiedBytes: Number.isFinite(copiedBytes) && copiedBytes >= 0 ? copiedBytes : 0,
    copiedFiles: Number.isFinite(copiedFiles) && copiedFiles >= 0 ? copiedFiles : 0,
    phase: value.phase,
    sameVolume: value.sameVolume === true,
    createdAt: String(value.createdAt || ''),
    updatedAt: String(value.updatedAt || '')
  }
}

export const hasLibraryRelocateJournalSync = (): boolean => {
  try {
    return fs.pathExistsSync(getJournalPath())
  } catch {
    return false
  }
}

export const readLibraryRelocateJournal = async (): Promise<LibraryRelocateJournal | null> => {
  try {
    const journalPath = getJournalPath()
    if (!(await fs.pathExists(journalPath))) return null
    return parseJournal(await fs.readJson(journalPath))
  } catch {
    return null
  }
}

export const writeLibraryRelocateJournal = async (
  journal: LibraryRelocateJournal
): Promise<void> => {
  const journalPath = getJournalPath()
  const next: LibraryRelocateJournal = {
    ...journal,
    version: LIBRARY_RELOCATE_JOURNAL_VERSION,
    updatedAt: new Date().toISOString()
  }
  await fs.ensureDir(path.dirname(journalPath))
  const tempPath = `${journalPath}.tmp`
  await fs.outputJson(tempPath, next)
  await fs.move(tempPath, journalPath, { overwrite: true })
}

export const clearLibraryRelocateJournal = async (): Promise<void> => {
  const journalPath = getJournalPath()
  try {
    await fs.remove(journalPath)
  } catch {}
  try {
    await fs.remove(`${journalPath}.tmp`)
  } catch {}
}

export const patchLibraryRelocateJournal = async (
  patch: Partial<LibraryRelocateJournal> & Pick<LibraryRelocateJournal, 'sourcePath' | 'destPath'>
): Promise<LibraryRelocateJournal> => {
  const current = (await readLibraryRelocateJournal()) || {
    version: LIBRARY_RELOCATE_JOURNAL_VERSION,
    sourcePath: patch.sourcePath,
    destPath: patch.destPath,
    parentPath: patch.parentPath || path.dirname(patch.destPath),
    folderName: patch.folderName || path.basename(patch.destPath),
    totalBytes: 0,
    totalFiles: 0,
    copiedBytes: 0,
    copiedFiles: 0,
    phase: patch.phase || 'preparing',
    sameVolume: patch.sameVolume === true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  const next: LibraryRelocateJournal = {
    ...current,
    ...patch,
    version: LIBRARY_RELOCATE_JOURNAL_VERSION
  }
  await writeLibraryRelocateJournal(next)
  return next
}
