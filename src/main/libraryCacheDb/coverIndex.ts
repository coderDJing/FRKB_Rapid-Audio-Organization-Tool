import path = require('path')
import fs = require('fs-extra')
import { getLibraryDb } from '../libraryDb'
import { log } from '../log'
import type { CoverIndexEntry } from './types'
import {
  resolveListRootInput,
  resolveFilePathInput,
  resolveAbsoluteListRoot,
  resolveAbsoluteFilePath
} from './pathResolvers'

const migratedCoverRoots = new Set<string>()

export function migrateCoverIndexRows(
  db: any,
  oldListRoot: string,
  newListRootKey: string,
  listRootAbs: string
): number {
  try {
    const rows = db
      .prepare('SELECT file_path, hash, ext FROM cover_index WHERE list_root = ?')
      .all(oldListRoot)
    if (!rows || rows.length === 0) return 0
    const del = db.prepare('DELETE FROM cover_index WHERE list_root = ? AND file_path = ?')
    const update = db.prepare(
      'UPDATE cover_index SET list_root = ?, file_path = ? WHERE list_root = ? AND file_path = ?'
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

export async function ensureCoverIndexMigrated(db: any, listRoot: string): Promise<void> {
  const resolved = resolveListRootInput(listRoot)
  if (!resolved) return
  const listRootKey = resolved.key
  const listRootAbs = resolved.abs
  if (!listRootKey || migratedCoverRoots.has(listRootKey)) return
  migratedCoverRoots.add(listRootKey)
  try {
    const countRow = db
      .prepare('SELECT COUNT(1) as count FROM cover_index WHERE list_root = ?')
      .get(listRootKey)
    if (countRow && Number(countRow.count) > 0) return
    if (!listRootAbs) return
    const indexPath = path.join(listRootAbs, '.frkb_covers', '.index.json')
    if (!(await fs.pathExists(indexPath))) return
    const json = await fs.readJSON(indexPath).catch(() => null)
    const fileToHash = json && typeof json === 'object' ? (json.fileToHash as any) : null
    const hashToExt = json && typeof json === 'object' ? (json.hashToExt as any) : null
    if (!fileToHash || typeof fileToHash !== 'object') return
    const rows: CoverIndexEntry[] = []
    for (const [filePath, hash] of Object.entries(fileToHash)) {
      if (!filePath || typeof hash !== 'string' || !hash) continue
      const extRaw = hashToExt && typeof hashToExt === 'object' ? hashToExt[hash] : null
      const ext = typeof extRaw === 'string' && extRaw.trim() ? extRaw : '.jpg'
      const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
      if (!resolvedFile) continue
      rows.push({ filePath: resolvedFile.key, hash, ext })
    }
    if (!rows.length) return
    const insert = db.prepare(
      'INSERT OR REPLACE INTO cover_index (list_root, file_path, hash, ext) VALUES (?, ?, ?, ?)'
    )
    const run = db.transaction((items: CoverIndexEntry[]) => {
      for (const row of items) {
        insert.run(listRootKey, row.filePath, row.hash, row.ext)
      }
    })
    run(rows)
  } catch (error) {
    log.error('[sqlite] cover index migrate failed', error)
  }
}

export async function loadCoverIndexEntry(
  listRoot: string,
  filePath: string
): Promise<{ hash: string; ext: string } | null | undefined> {
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath) return undefined
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return undefined
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
  if (!resolvedFile) return undefined
  const fileKey = resolvedFile.key
  const fileKeyRaw = resolvedFile.keyRaw
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  const legacyFilePath = resolvedFile.legacyAbs
  try {
    await ensureCoverIndexMigrated(db, listRoot)
    let row = db
      .prepare('SELECT hash, ext FROM cover_index WHERE list_root = ? AND file_path = ?')
      .get(listRootKey, fileKey)
    let hitListRoot = listRootKey
    let hitFilePath = fileKey
    let legacyHit = false
    if (!row && fileKeyRaw) {
      row = db
        .prepare('SELECT hash, ext FROM cover_index WHERE list_root = ? AND file_path = ?')
        .get(listRootKey, fileKeyRaw)
      if (row) {
        hitListRoot = listRootKey
        hitFilePath = fileKeyRaw
        legacyHit = true
      }
    }
    if (!row && legacyListRoot && legacyFilePath) {
      row = db
        .prepare('SELECT hash, ext FROM cover_index WHERE list_root = ? AND file_path = ?')
        .get(legacyListRoot, legacyFilePath)
      if (row) {
        hitListRoot = legacyListRoot
        hitFilePath = legacyFilePath
        legacyHit = true
      }
    }
    if (!row || !row.hash) return null
    if (legacyHit && resolvedRoot.isRelativeKey) {
      try {
        const del = db.prepare('DELETE FROM cover_index WHERE list_root = ? AND file_path = ?')
        const update = db.prepare(
          'UPDATE cover_index SET list_root = ?, file_path = ? WHERE list_root = ? AND file_path = ?'
        )
        del.run(listRootKey, fileKey)
        update.run(listRootKey, fileKey, hitListRoot, hitFilePath)
      } catch {}
    }
    return { hash: String(row.hash), ext: String(row.ext || '.jpg') }
  } catch (error) {
    log.error('[sqlite] cover index load failed', error)
    return undefined
  }
}

export async function upsertCoverIndexEntry(
  listRoot: string,
  filePath: string,
  hash: string,
  ext: string
): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath || !hash) return false
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
    await ensureCoverIndexMigrated(db, listRoot)
    db.prepare(
      'INSERT INTO cover_index (list_root, file_path, hash, ext) VALUES (?, ?, ?, ?) ON CONFLICT(list_root, file_path) DO UPDATE SET hash = excluded.hash, ext = excluded.ext'
    ).run(listRootKey, resolvedFile.key, hash, ext || '.jpg')
    if (resolvedFile.keyRaw && resolvedFile.keyRaw !== resolvedFile.key) {
      db.prepare('DELETE FROM cover_index WHERE list_root = ? AND file_path = ?').run(
        listRootKey,
        resolvedFile.keyRaw
      )
    }
    if (legacyListRoot && resolvedFile.legacyAbs) {
      db.prepare('DELETE FROM cover_index WHERE list_root = ? AND file_path = ?').run(
        legacyListRoot,
        resolvedFile.legacyAbs
      )
    }
    return true
  } catch (error) {
    log.error('[sqlite] cover index upsert failed', error)
    return false
  }
}

export async function removeCoverIndexEntry(
  listRoot: string,
  filePath: string
): Promise<{ hash: string; ext: string } | null | undefined> {
  const db = getLibraryDb()
  if (!db || !listRoot || !filePath) return undefined
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return undefined
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
  if (!resolvedFile) return undefined
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  try {
    await ensureCoverIndexMigrated(db, listRoot)
    let row = db
      .prepare('SELECT hash, ext FROM cover_index WHERE list_root = ? AND file_path = ?')
      .get(listRootKey, resolvedFile.key)
    if (!row && resolvedFile.keyRaw) {
      row = db
        .prepare('SELECT hash, ext FROM cover_index WHERE list_root = ? AND file_path = ?')
        .get(listRootKey, resolvedFile.keyRaw)
    }
    if (!row && legacyListRoot && resolvedFile.legacyAbs) {
      row = db
        .prepare('SELECT hash, ext FROM cover_index WHERE list_root = ? AND file_path = ?')
        .get(legacyListRoot, resolvedFile.legacyAbs)
    }
    if (!row || !row.hash) return null
    db.prepare('DELETE FROM cover_index WHERE list_root = ? AND file_path = ?').run(
      listRootKey,
      resolvedFile.key
    )
    if (resolvedFile.keyRaw) {
      db.prepare('DELETE FROM cover_index WHERE list_root = ? AND file_path = ?').run(
        listRootKey,
        resolvedFile.keyRaw
      )
    }
    if (legacyListRoot && resolvedFile.legacyAbs) {
      db.prepare('DELETE FROM cover_index WHERE list_root = ? AND file_path = ?').run(
        legacyListRoot,
        resolvedFile.legacyAbs
      )
    }
    return { hash: String(row.hash), ext: String(row.ext || '.jpg') }
  } catch (error) {
    log.error('[sqlite] cover index delete failed', error)
    return undefined
  }
}

export async function loadCoverIndexEntries(listRoot: string): Promise<CoverIndexEntry[] | null> {
  const db = getLibraryDb()
  if (!db || !listRoot) return null
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return null
  const listRootKey = resolvedRoot.key
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  try {
    await ensureCoverIndexMigrated(db, listRoot)
    const rows = db
      .prepare('SELECT file_path, hash, ext FROM cover_index WHERE list_root = ?')
      .all(listRootKey)
    const legacyRows = legacyListRoot
      ? db
          .prepare('SELECT file_path, hash, ext FROM cover_index WHERE list_root = ?')
          .all(legacyListRoot)
      : []
    const toEntries = (rowsToUse: any[], rootKey: string, legacyRelRoot?: string) =>
      (rowsToUse || [])
        .filter((row: any) => row && row.file_path && row.hash)
        .map((row: any) => {
          let absFilePath = resolveAbsoluteFilePath(rootKey, String(row.file_path))
          if (legacyRelRoot) {
            const resolvedLegacy = resolveFilePathInput(legacyRelRoot, String(row.file_path))
            if (resolvedLegacy && resolvedLegacy.isRelativeKey) {
              absFilePath = resolveAbsoluteFilePath(listRootKey, resolvedLegacy.key)
            }
          }
          return {
            filePath: absFilePath,
            hash: String(row.hash),
            ext: String(row.ext || '.jpg')
          }
        })
    const result = [
      ...toEntries(rows, listRootKey),
      ...toEntries(legacyRows, legacyListRoot || '', legacyListRoot)
    ]
    if (legacyRows && legacyRows.length > 0 && legacyListRoot && resolvedRoot.isRelativeKey) {
      const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
      if (listRootAbs) {
        migrateCoverIndexRows(db, legacyListRoot, listRootKey, listRootAbs)
      }
    }
    return result
  } catch (error) {
    log.error('[sqlite] cover index list failed', error)
    return null
  }
}

export async function removeCoverIndexEntries(
  listRoot: string,
  filePaths: string[]
): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot) return false
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return false
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  if (!Array.isArray(filePaths) || filePaths.length === 0) return true
  try {
    await ensureCoverIndexMigrated(db, listRoot)
    const del = db.prepare('DELETE FROM cover_index WHERE list_root = ? AND file_path = ?')
    const run = db.transaction((items: string[]) => {
      for (const fp of items) {
        const resolvedFile = resolveFilePathInput(listRootAbs, fp)
        if (!resolvedFile) continue
        del.run(listRootKey, resolvedFile.key)
        if (resolvedFile.keyRaw) {
          del.run(listRootKey, resolvedFile.keyRaw)
        }
        if (legacyListRoot && resolvedFile.legacyAbs) {
          del.run(legacyListRoot, resolvedFile.legacyAbs)
        }
      }
    })
    run(filePaths)
    return true
  } catch (error) {
    log.error('[sqlite] cover index bulk delete failed', error)
    return false
  }
}

export async function clearCoverIndex(listRoot: string): Promise<boolean> {
  const db = getLibraryDb()
  if (!db || !listRoot) return false
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return false
  const listRootKey = resolvedRoot.key
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  try {
    db.prepare('DELETE FROM cover_index WHERE list_root = ?').run(listRootKey)
    if (legacyListRoot) {
      db.prepare('DELETE FROM cover_index WHERE list_root = ?').run(legacyListRoot)
    }
    return true
  } catch (error) {
    log.error('[sqlite] cover index clear failed', error)
    return false
  }
}

export async function countCoverIndexByHash(
  listRoot: string,
  hash: string
): Promise<number | null> {
  const db = getLibraryDb()
  if (!db || !listRoot || !hash) return null
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return null
  const listRootKey = resolvedRoot.key
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  try {
    const row = db
      .prepare('SELECT COUNT(1) as count FROM cover_index WHERE list_root = ? AND hash = ?')
      .get(listRootKey, hash)
    let total = row ? Number(row.count) : 0
    if (legacyListRoot) {
      const legacyRow = db
        .prepare('SELECT COUNT(1) as count FROM cover_index WHERE list_root = ? AND hash = ?')
        .get(legacyListRoot, hash)
      total += legacyRow ? Number(legacyRow.count) : 0
    }
    return total
  } catch (error) {
    log.error('[sqlite] cover index count failed', error)
    return null
  }
}
