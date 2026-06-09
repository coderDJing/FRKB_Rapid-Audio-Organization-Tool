import { getLibraryDb, type SqliteDatabase } from '../libraryDb'
import { log } from '../log'
import {
  resolveListRootInput,
  resolveFilePathInput,
  resolveAbsoluteListRoot
} from './pathResolvers'

type WaveformCacheRow = {
  file_path?: string
}

export function migrateWaveformCacheRows(
  db: SqliteDatabase,
  oldListRoot: string,
  newListRootKey: string,
  listRootAbs: string
): number {
  try {
    const rows = db
      .prepare<WaveformCacheRow>('SELECT file_path FROM waveform_cache WHERE list_root = ?')
      .all(oldListRoot)
    if (!rows || rows.length === 0) return 0
    const del = db.prepare('DELETE FROM waveform_cache WHERE list_root = ? AND file_path = ?')
    const update = db.prepare(
      'UPDATE waveform_cache SET list_root = ?, file_path = ? WHERE list_root = ? AND file_path = ?'
    )
    let moved = 0
    const run = db.transaction(() => {
      for (const row of rows) {
        const filePath = row?.file_path ? String(row.file_path) : ''
        if (!filePath) continue
        const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
        if (!resolvedFile) continue
        const newFileKey = resolvedFile.key
        del.run(newListRootKey, newFileKey)
        const result = update.run(newListRootKey, newFileKey, oldListRoot, filePath)
        moved += result?.changes ? Number(result.changes) : 0
      }
    })
    run()
    return moved
  } catch {
    return 0
  }
}

export async function updateWaveformCacheStat(
  listRoot: string,
  filePath: string,
  stat: { size: number; mtimeMs: number }
): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath) return false
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return false
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
  if (!resolvedFile) return false
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  if (!Number.isFinite(stat?.size) || !Number.isFinite(stat?.mtimeMs)) return false
  try {
    const update = db.prepare(
      'UPDATE waveform_cache SET size = ?, mtime_ms = ? WHERE list_root = ? AND file_path = ?'
    )
    const run = db.transaction(() => {
      update.run(stat.size, stat.mtimeMs, listRootKey, resolvedFile.key)
      if (resolvedFile.keyRaw) {
        update.run(stat.size, stat.mtimeMs, listRootKey, resolvedFile.keyRaw)
      }
      if (legacyListRoot && resolvedFile.legacyAbs) {
        update.run(stat.size, stat.mtimeMs, legacyListRoot, resolvedFile.legacyAbs)
      }
    })
    run()
    return true
  } catch (error) {
    log.error('[sqlite] waveform cache stat update failed', error)
    return false
  }
}

export async function removeWaveformCacheEntry(
  listRoot: string,
  filePath: string
): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath) return false
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return false
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
  if (!resolvedFile) return false
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  try {
    const del = db.prepare('DELETE FROM waveform_cache WHERE list_root = ? AND file_path = ?')
    del.run(listRootKey, resolvedFile.key)
    if (resolvedFile.keyRaw) del.run(listRootKey, resolvedFile.keyRaw)
    if (legacyListRoot && resolvedFile.legacyAbs) del.run(legacyListRoot, resolvedFile.legacyAbs)
    return true
  } catch (error) {
    log.error('[sqlite] waveform cache delete failed', error)
    return false
  }
}
