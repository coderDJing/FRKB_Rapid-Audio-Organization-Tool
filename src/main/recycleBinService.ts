import path = require('path')
import fs = require('fs-extra')
import store from './store'
import { getCoreFsDirName, mapRendererPathToFsPath } from './utils'
import { log } from './log'
import {
  getRecycleBinRecord,
  upsertRecycleBinRecord,
  deleteRecycleBinRecord,
  type RecycleBinRecord
} from './recycleBinDb'
import {
  clearTrackCache,
  purgeCoverCacheForTrack,
  transferTrackCaches
} from './services/cacheMaintenance'
import { findSongListRootByPath } from './libraryTreeDb'
import { invalidateKeyAnalysisCache } from './services/keyAnalysisQueue'

export type RecycleBinSourceType = 'external' | 'import_dedup' | 'unknown'

export type RecycleBinMoveOptions = {
  originalPlaylistPath?: string | null
  sourceType?: RecycleBinSourceType | string | null
  deletedAtMs?: number
  originalFileName?: string | null
}

export type RecycleBinMoveResult = {
  status: 'moved' | 'skipped' | 'failed'
  srcPath: string
  destPath?: string
  destRelativePath?: string
  error?: string
}

export type RecycleBinRestoreResult = {
  status: 'restored' | 'missing_playlist' | 'missing_record' | 'missing_file' | 'failed'
  srcPath: string
  destPath?: string
  error?: string
  playlistPath?: string | null
}

type RecordLookup = { record: RecycleBinRecord | null; recordKey: string | null }

function getLibraryRootAbs(): string | null {
  const root = store.databaseDir
  if (!root) return null
  return path.join(root, 'library')
}

export function getRecycleBinRootAbs(): string | null {
  const libraryRoot = getLibraryRootAbs()
  if (!libraryRoot) return null
  return path.join(libraryRoot, getCoreFsDirName('RecycleBin'))
}

export function toLibraryRelativePath(absPath: string): string | null {
  const libraryRoot = getLibraryRootAbs()
  if (!libraryRoot || !absPath) return null
  const rel = path.relative(libraryRoot, absPath)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel
}

export function normalizeRendererPlaylistPath(rendererPath: string): string | null {
  if (!rendererPath) return null
  const libraryRoot = getLibraryRootAbs()
  if (!libraryRoot) return null
  const mapped = mapRendererPathToFsPath(rendererPath)
  const absPath = path.isAbsolute(mapped) ? mapped : path.join(store.databaseDir, mapped)
  const rel = path.relative(libraryRoot, absPath)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel
}

export async function resolveOriginalPlaylistPathForFile(filePath: string): Promise<string | null> {
  const libraryRoot = getLibraryRootAbs()
  if (!libraryRoot || !filePath) return null
  try {
    const listRoot = await findSongListRootByPath(path.dirname(filePath))
    if (listRoot) {
      const rel = path.relative(libraryRoot, listRoot)
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel
    }
  } catch {}
  const fallback = path.relative(libraryRoot, path.dirname(filePath))
  if (!fallback || fallback.startsWith('..') || path.isAbsolute(fallback)) return null
  return fallback
}

export function isInRecycleBinAbsPath(absPath: string): boolean {
  const recycleRoot = getRecycleBinRootAbs()
  if (!recycleRoot || !absPath) return false
  const normalized = path.resolve(absPath)
  const normalizedRoot = path.resolve(recycleRoot)
  return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + path.sep)
}

function parseRenameSeed(baseName: string): { stem: string; index: number | null } {
  const match = String(baseName).match(/^(.*?)(?:\s*\((\d+)\))?$/)
  if (!match) return { stem: baseName, index: null }
  const stem = match[1] ? String(match[1]).trimEnd() : ''
  const index = match[2] ? Number(match[2]) : null
  return { stem: stem || baseName, index: Number.isFinite(index) ? index : null }
}

async function resolveUniqueFileName(dirPath: string, fileName: string): Promise<string> {
  const ext = path.extname(fileName)
  const base = path.basename(fileName, ext)
  const { stem, index } = parseRenameSeed(base)
  const candidate = path.join(dirPath, fileName)
  if (!(await fs.pathExists(candidate))) return fileName
  let counter = index && index > 0 ? index + 1 : 1
  while (true) {
    const nextName = `${stem}(${counter})${ext}`
    if (!(await fs.pathExists(path.join(dirPath, nextName)))) {
      return nextName
    }
    counter += 1
  }
}

function resolveRecordByPath(filePath: string): RecordLookup {
  if (!filePath) return { record: null, recordKey: null }
  const rel = toLibraryRelativePath(filePath)
  if (rel) {
    const rec = getRecycleBinRecord(rel)
    if (rec) return { record: rec, recordKey: rel }
  }
  const direct = getRecycleBinRecord(filePath)
  if (direct) return { record: direct, recordKey: filePath }
  return { record: null, recordKey: rel || filePath }
}

export async function moveFileToRecycleBin(
  srcPath: string,
  options: RecycleBinMoveOptions = {}
): Promise<RecycleBinMoveResult> {
  const recycleRoot = getRecycleBinRootAbs()
  const libraryRoot = getLibraryRootAbs()
  if (!recycleRoot || !libraryRoot || !srcPath) {
    return { status: 'failed', srcPath, error: 'recycle bin root unavailable' }
  }
  const sourceListRoot = await findSongListRootByPath(path.dirname(srcPath))
  try {
    if (!(await fs.pathExists(srcPath))) {
      return { status: 'skipped', srcPath }
    }
    await fs.ensureDir(recycleRoot)
    const originalFileName = options.originalFileName || path.basename(srcPath)
    const targetName = await resolveUniqueFileName(recycleRoot, originalFileName)
    const destPath = path.join(recycleRoot, targetName)
    await fs.move(srcPath, destPath)
    try {
      await transferTrackCaches({
        fromRoot: sourceListRoot,
        toRoot: recycleRoot,
        fromPath: srcPath,
        toPath: destPath
      })
    } catch {}
    try {
      invalidateKeyAnalysisCache([srcPath, destPath])
    } catch {}
    const rel = toLibraryRelativePath(destPath)
    if (!rel) {
      return { status: 'failed', srcPath, destPath, error: 'invalid recycle bin path' }
    }
    const hasOriginalPlaylistPath = Object.prototype.hasOwnProperty.call(
      options,
      'originalPlaylistPath'
    )
    const originalPlaylistPath = hasOriginalPlaylistPath
      ? (options.originalPlaylistPath ?? null)
      : await resolveOriginalPlaylistPathForFile(srcPath)
    upsertRecycleBinRecord({
      filePath: rel,
      deletedAtMs: options.deletedAtMs ?? Date.now(),
      originalPlaylistPath: originalPlaylistPath ?? null,
      originalFileName: originalFileName ?? null,
      sourceType: options.sourceType ?? null
    })
    return { status: 'moved', srcPath, destPath, destRelativePath: rel }
  } catch (error: any) {
    log.error('[recycleBin] move failed', { srcPath, error })
    return { status: 'failed', srcPath, error: error?.message || String(error) }
  }
}

export async function restoreRecycleBinFile(filePath: string): Promise<RecycleBinRestoreResult> {
  if (!filePath) return { status: 'missing_record', srcPath: filePath }
  const recycleRoot = getRecycleBinRootAbs()
  const libraryRoot = getLibraryRootAbs()
  if (!recycleRoot || !libraryRoot) {
    return { status: 'failed', srcPath: filePath, error: 'recycle bin root unavailable' }
  }
  const { record, recordKey } = resolveRecordByPath(filePath)
  if (!record) return { status: 'missing_record', srcPath: filePath }
  const srcPath = path.isAbsolute(filePath) ? filePath : path.join(libraryRoot, record.filePath)
  try {
    if (!(await fs.pathExists(srcPath))) {
      if (recordKey) deleteRecycleBinRecord(recordKey)
      return { status: 'missing_file', srcPath }
    }
    const playlistRel = record.originalPlaylistPath
    if (!playlistRel) {
      return { status: 'missing_playlist', srcPath, playlistPath: null }
    }
    const destDir = path.join(libraryRoot, playlistRel)
    const destDirStat = await fs.stat(destDir).catch(() => null)
    if (!destDirStat || !destDirStat.isDirectory()) {
      return { status: 'missing_playlist', srcPath, playlistPath: playlistRel }
    }
    const desiredName = record.originalFileName || path.basename(srcPath)
    const finalName = await resolveUniqueFileName(destDir, desiredName)
    const destPath = path.join(destDir, finalName)
    await fs.move(srcPath, destPath)
    try {
      await transferTrackCaches({
        fromRoot: recycleRoot,
        toRoot: destDir,
        fromPath: srcPath,
        toPath: destPath
      })
    } catch {}
    try {
      invalidateKeyAnalysisCache([srcPath, destPath])
    } catch {}
    if (recordKey) deleteRecycleBinRecord(recordKey)
    return { status: 'restored', srcPath, destPath, playlistPath: playlistRel }
  } catch (error: any) {
    log.error('[recycleBin] restore failed', { srcPath, error })
    return { status: 'failed', srcPath, error: error?.message || String(error) }
  }
}

export async function permanentlyDeleteFile(filePath: string): Promise<boolean> {
  if (!filePath) return false
  const { record, recordKey } = resolveRecordByPath(filePath)
  const libraryRoot = getLibraryRootAbs()
  const srcPath = path.isAbsolute(filePath)
    ? filePath
    : libraryRoot
      ? path.join(libraryRoot, record?.filePath || filePath)
      : filePath
  try {
    await clearTrackCache(srcPath)
  } catch {}
  if (record?.originalPlaylistPath && record?.originalFileName && libraryRoot) {
    const originalPath = path.join(
      libraryRoot,
      record.originalPlaylistPath,
      record.originalFileName
    )
    if (path.resolve(originalPath) !== path.resolve(srcPath)) {
      try {
        await purgeCoverCacheForTrack(originalPath)
      } catch {}
    }
  }
  try {
    if (await fs.pathExists(srcPath)) {
      await fs.remove(srcPath)
    }
  } catch (error) {
    log.error('[recycleBin] delete file failed', { filePath: srcPath, error })
    return false
  }
  if (recordKey) {
    deleteRecycleBinRecord(recordKey)
  }
  return true
}

export default {
  getRecycleBinRootAbs,
  toLibraryRelativePath,
  normalizeRendererPlaylistPath,
  resolveOriginalPlaylistPathForFile,
  isInRecycleBinAbsPath,
  moveFileToRecycleBin,
  restoreRecycleBinFile,
  permanentlyDeleteFile
}
