import path = require('path')
import fs = require('fs-extra')
import { getLibraryDb, getMetaValue, setMetaValue } from '../libraryDb'
import { log } from '../log'
import type { LegacyCacheRoots } from './types'
import {
  toNumber,
  extractLibraryRelative,
  getDatabaseRootAbs,
  isUnderPath,
  normalizeInfoJsonFilePath,
  normalizeRoot,
  resolveAbsoluteFilePath,
  resolveAbsoluteListRoot,
  resolveListRootInput
} from './pathResolvers'
import { ensureSongCacheMigrated, migrateSongCacheRows } from './songCache'
import { ensureCoverIndexMigrated, migrateCoverIndexRows } from './coverIndex'
import { migrateWaveformCacheRows } from './waveformCache'

const CACHE_KEY_MIGRATION_META_KEY_V2 = 'cache_key_relative_migrated_v2'
let cacheKeyMigrationScheduled = false

export async function renameCacheRoot(
  oldRoot: string,
  newRoot: string
): Promise<{
  songCacheUpdated: number
  coverIndexUpdated: number
  waveformCacheUpdated: number
  mixtapeWaveformCacheUpdated: number
  mixtapeRawWaveformCacheUpdated: number
  mixtapeWaveformHiresCacheUpdated: number
}> {
  const db = getLibraryDb()
  if (!db || !oldRoot || !newRoot) {
    return {
      songCacheUpdated: 0,
      coverIndexUpdated: 0,
      waveformCacheUpdated: 0,
      mixtapeWaveformCacheUpdated: 0,
      mixtapeRawWaveformCacheUpdated: 0,
      mixtapeWaveformHiresCacheUpdated: 0
    }
  }
  const oldResolved = resolveListRootInput(oldRoot)
  const newResolved = resolveListRootInput(newRoot)
  if (!oldResolved || !newResolved) {
    return {
      songCacheUpdated: 0,
      coverIndexUpdated: 0,
      waveformCacheUpdated: 0,
      mixtapeWaveformCacheUpdated: 0,
      mixtapeRawWaveformCacheUpdated: 0,
      mixtapeWaveformHiresCacheUpdated: 0
    }
  }
  const oldKey = oldResolved.key
  const newKey = newResolved.key
  if (!oldKey || !newKey) {
    return {
      songCacheUpdated: 0,
      coverIndexUpdated: 0,
      waveformCacheUpdated: 0,
      mixtapeWaveformCacheUpdated: 0,
      mixtapeRawWaveformCacheUpdated: 0,
      mixtapeWaveformHiresCacheUpdated: 0
    }
  }
  const normalizedOld = normalizeRoot(oldKey)
  const normalizedNew = normalizeRoot(newKey)
  if (!normalizedOld || !normalizedNew || normalizedOld === normalizedNew) {
    return {
      songCacheUpdated: 0,
      coverIndexUpdated: 0,
      waveformCacheUpdated: 0,
      mixtapeWaveformCacheUpdated: 0,
      mixtapeRawWaveformCacheUpdated: 0,
      mixtapeWaveformHiresCacheUpdated: 0
    }
  }
  const oldAbs = oldResolved.abs || resolveAbsoluteListRoot(oldKey)

  let songCacheUpdated = 0
  let coverIndexUpdated = 0
  let waveformCacheUpdated = 0
  let mixtapeWaveformCacheUpdated = 0
  let mixtapeRawWaveformCacheUpdated = 0
  let mixtapeWaveformHiresCacheUpdated = 0
  try {
    const deleteSong = db.prepare('DELETE FROM song_cache WHERE list_root = ? AND file_path = ?')
    const updateSong = db.prepare(
      'UPDATE song_cache SET list_root = ?, file_path = ?, info_json = ? WHERE list_root = ? AND file_path = ?'
    )
    const deleteCover = db.prepare('DELETE FROM cover_index WHERE list_root = ? AND file_path = ?')
    const updateCover = db.prepare(
      'UPDATE cover_index SET list_root = ?, file_path = ? WHERE list_root = ? AND file_path = ?'
    )
    const deleteWaveform = db.prepare(
      'DELETE FROM waveform_cache WHERE list_root = ? AND file_path = ?'
    )
    const updateWaveform = db.prepare(
      'UPDATE waveform_cache SET list_root = ?, file_path = ? WHERE list_root = ? AND file_path = ?'
    )
    const deleteMixtapeWaveform = db.prepare(
      'DELETE FROM mixtape_waveform_cache WHERE list_root = ? AND file_path = ?'
    )
    const updateMixtapeWaveform = db.prepare(
      'UPDATE mixtape_waveform_cache SET list_root = ?, file_path = ? WHERE list_root = ? AND file_path = ?'
    )
    const deleteMixtapeRawWaveform = db.prepare(
      'DELETE FROM mixtape_raw_waveform_cache WHERE list_root = ? AND file_path = ?'
    )
    const updateMixtapeRawWaveform = db.prepare(
      'UPDATE mixtape_raw_waveform_cache SET list_root = ?, file_path = ? WHERE list_root = ? AND file_path = ?'
    )
    const deleteMixtapeWaveformHires = db.prepare(
      'DELETE FROM mixtape_waveform_hires_cache WHERE list_root = ? AND file_path = ? AND target_rate = ?'
    )
    const updateMixtapeWaveformHires = db.prepare(
      'UPDATE mixtape_waveform_hires_cache SET list_root = ?, file_path = ? WHERE list_root = ? AND file_path = ? AND target_rate = ?'
    )

    const run = db.transaction(() => {
      const processRoot = (rootKey: string) => {
        const songRows = db
          .prepare('SELECT file_path, info_json FROM song_cache WHERE list_root = ?')
          .all(rootKey)
        const coverRows = db
          .prepare('SELECT file_path FROM cover_index WHERE list_root = ?')
          .all(rootKey)
        const waveformRows = db
          .prepare('SELECT file_path FROM waveform_cache WHERE list_root = ?')
          .all(rootKey)
        const mixtapeWaveformRows = db
          .prepare('SELECT file_path FROM mixtape_waveform_cache WHERE list_root = ?')
          .all(rootKey)
        const mixtapeRawWaveformRows = db
          .prepare('SELECT file_path FROM mixtape_raw_waveform_cache WHERE list_root = ?')
          .all(rootKey)
        const mixtapeWaveformHiresRows = db
          .prepare(
            'SELECT file_path, target_rate FROM mixtape_waveform_hires_cache WHERE list_root = ?'
          )
          .all(rootKey)

        for (const row of songRows || []) {
          const filePath = row?.file_path ? String(row.file_path) : ''
          if (!filePath) continue
          let newFileKey = filePath
          if (path.isAbsolute(filePath)) {
            if (oldAbs && isUnderPath(oldAbs, filePath)) {
              newFileKey = normalizeRoot(path.relative(oldAbs, filePath))
            } else {
              newFileKey = normalizeRoot(filePath)
            }
          } else {
            newFileKey = normalizeRoot(filePath)
          }
          const absFilePath = resolveAbsoluteFilePath(newKey, newFileKey)
          const nextInfoJson = normalizeInfoJsonFilePath(row?.info_json, absFilePath)
          deleteSong.run(newKey, newFileKey)
          const result = updateSong.run(newKey, newFileKey, nextInfoJson, rootKey, filePath)
          songCacheUpdated += result?.changes ? Number(result.changes) : 0
        }

        for (const row of coverRows || []) {
          const filePath = row?.file_path ? String(row.file_path) : ''
          if (!filePath) continue
          let newFileKey = filePath
          if (path.isAbsolute(filePath)) {
            if (oldAbs && isUnderPath(oldAbs, filePath)) {
              newFileKey = normalizeRoot(path.relative(oldAbs, filePath))
            } else {
              newFileKey = normalizeRoot(filePath)
            }
          } else {
            newFileKey = normalizeRoot(filePath)
          }
          deleteCover.run(newKey, newFileKey)
          const result = updateCover.run(newKey, newFileKey, rootKey, filePath)
          coverIndexUpdated += result?.changes ? Number(result.changes) : 0
        }

        for (const row of waveformRows || []) {
          const filePath = row?.file_path ? String(row.file_path) : ''
          if (!filePath) continue
          let newFileKey = filePath
          if (path.isAbsolute(filePath)) {
            if (oldAbs && isUnderPath(oldAbs, filePath)) {
              newFileKey = normalizeRoot(path.relative(oldAbs, filePath))
            } else {
              newFileKey = normalizeRoot(filePath)
            }
          } else {
            newFileKey = normalizeRoot(filePath)
          }
          deleteWaveform.run(newKey, newFileKey)
          const result = updateWaveform.run(newKey, newFileKey, rootKey, filePath)
          waveformCacheUpdated += result?.changes ? Number(result.changes) : 0
        }

        for (const row of mixtapeWaveformRows || []) {
          const filePath = row?.file_path ? String(row.file_path) : ''
          if (!filePath) continue
          let newFileKey = filePath
          if (path.isAbsolute(filePath)) {
            if (oldAbs && isUnderPath(oldAbs, filePath)) {
              newFileKey = normalizeRoot(path.relative(oldAbs, filePath))
            } else {
              newFileKey = normalizeRoot(filePath)
            }
          } else {
            newFileKey = normalizeRoot(filePath)
          }
          deleteMixtapeWaveform.run(newKey, newFileKey)
          const result = updateMixtapeWaveform.run(newKey, newFileKey, rootKey, filePath)
          mixtapeWaveformCacheUpdated += result?.changes ? Number(result.changes) : 0
        }

        for (const row of mixtapeRawWaveformRows || []) {
          const filePath = row?.file_path ? String(row.file_path) : ''
          if (!filePath) continue
          let newFileKey = filePath
          if (path.isAbsolute(filePath)) {
            if (oldAbs && isUnderPath(oldAbs, filePath)) {
              newFileKey = normalizeRoot(path.relative(oldAbs, filePath))
            } else {
              newFileKey = normalizeRoot(filePath)
            }
          } else {
            newFileKey = normalizeRoot(filePath)
          }
          deleteMixtapeRawWaveform.run(newKey, newFileKey)
          const result = updateMixtapeRawWaveform.run(newKey, newFileKey, rootKey, filePath)
          mixtapeRawWaveformCacheUpdated += result?.changes ? Number(result.changes) : 0
        }

        for (const row of mixtapeWaveformHiresRows || []) {
          const filePath = row?.file_path ? String(row.file_path) : ''
          const targetRate = toNumber(row?.target_rate)
          if (!filePath || targetRate === null || targetRate <= 0) continue
          let newFileKey = filePath
          if (path.isAbsolute(filePath)) {
            if (oldAbs && isUnderPath(oldAbs, filePath)) {
              newFileKey = normalizeRoot(path.relative(oldAbs, filePath))
            } else {
              newFileKey = normalizeRoot(filePath)
            }
          } else {
            newFileKey = normalizeRoot(filePath)
          }
          deleteMixtapeWaveformHires.run(newKey, newFileKey, targetRate)
          const result = updateMixtapeWaveformHires.run(
            newKey,
            newFileKey,
            rootKey,
            filePath,
            targetRate
          )
          mixtapeWaveformHiresCacheUpdated += result?.changes ? Number(result.changes) : 0
        }
      }

      processRoot(oldKey)
      if (oldResolved.legacyAbs && oldResolved.legacyAbs !== oldKey) {
        processRoot(oldResolved.legacyAbs)
      }
    })

    run()
  } catch (error) {
    log.error('[sqlite] cache root rename failed', error)
  }

  return {
    songCacheUpdated,
    coverIndexUpdated,
    waveformCacheUpdated,
    mixtapeWaveformCacheUpdated,
    mixtapeRawWaveformCacheUpdated,
    mixtapeWaveformHiresCacheUpdated
  }
}

export async function pruneCachesByRoots(keepRoots: Iterable<string> | null | undefined): Promise<{
  songCacheRemoved: number
  coverIndexRemoved: number
  waveformCacheRemoved: number
  mixtapeWaveformCacheRemoved: number
  mixtapeRawWaveformCacheRemoved: number
  mixtapeWaveformHiresCacheRemoved: number
}> {
  const db = getLibraryDb()
  if (!db) {
    return {
      songCacheRemoved: 0,
      coverIndexRemoved: 0,
      waveformCacheRemoved: 0,
      mixtapeWaveformCacheRemoved: 0,
      mixtapeRawWaveformCacheRemoved: 0,
      mixtapeWaveformHiresCacheRemoved: 0
    }
  }
  try {
    const keepSet = new Set<string>()
    if (keepRoots) {
      for (const root of keepRoots) {
        const resolved = resolveListRootInput(root)
        if (!resolved) continue
        const addKeep = (value?: string) => {
          const normalized = normalizeRoot(value)
          if (normalized) keepSet.add(normalized)
        }
        addKeep(resolved.key)
        addKeep(resolved.keyRaw)
        addKeep(resolved.legacyAbs)
      }
    }

    const pruneTable = (
      table:
        | 'song_cache'
        | 'cover_index'
        | 'waveform_cache'
        | 'mixtape_waveform_cache'
        | 'mixtape_raw_waveform_cache'
        | 'mixtape_waveform_hires_cache'
    ): number => {
      const rows = db.prepare(`SELECT DISTINCT list_root FROM ${table}`).all()
      if (!rows || rows.length === 0) return 0
      const toRemove: string[] = []
      for (const row of rows) {
        const raw = row?.list_root
        const normalized = normalizeRoot(raw)
        if (!normalized || !keepSet.has(normalized)) {
          toRemove.push(String(raw))
        }
      }
      if (toRemove.length === 0) return 0
      const del = db.prepare(`DELETE FROM ${table} WHERE list_root = ?`)
      let removed = 0
      const run = db.transaction((items: string[]) => {
        for (const item of items) {
          const info = del.run(item) as any
          removed += Number(info?.changes || 0)
        }
      })
      run(toRemove)
      return removed
    }

    const songCacheRemoved = pruneTable('song_cache')
    const coverIndexRemoved = pruneTable('cover_index')
    const waveformCacheRemoved = pruneTable('waveform_cache')
    const mixtapeWaveformCacheRemoved = pruneTable('mixtape_waveform_cache')
    const mixtapeRawWaveformCacheRemoved = pruneTable('mixtape_raw_waveform_cache')
    const mixtapeWaveformHiresCacheRemoved = pruneTable('mixtape_waveform_hires_cache')
    return {
      songCacheRemoved,
      coverIndexRemoved,
      waveformCacheRemoved,
      mixtapeWaveformCacheRemoved,
      mixtapeRawWaveformCacheRemoved,
      mixtapeWaveformHiresCacheRemoved
    }
  } catch (error) {
    log.error('[sqlite] cache prune failed', error)
    return {
      songCacheRemoved: 0,
      coverIndexRemoved: 0,
      waveformCacheRemoved: 0,
      mixtapeWaveformCacheRemoved: 0,
      mixtapeRawWaveformCacheRemoved: 0,
      mixtapeWaveformHiresCacheRemoved: 0
    }
  }
}

function collectMigratableCacheRoots(db: any, baseRoot: string): Set<string> {
  const targets = new Set<string>()
  if (!db || !baseRoot) return targets
  const tables: Array<
    | 'song_cache'
    | 'cover_index'
    | 'waveform_cache'
    | 'mixtape_waveform_cache'
    | 'mixtape_raw_waveform_cache'
    | 'mixtape_waveform_hires_cache'
  > = [
    'song_cache',
    'cover_index',
    'waveform_cache',
    'mixtape_waveform_cache',
    'mixtape_raw_waveform_cache',
    'mixtape_waveform_hires_cache'
  ]
  for (const table of tables) {
    const rows = db.prepare(`SELECT DISTINCT list_root FROM ${table}`).all()
    for (const row of rows || []) {
      const raw = row?.list_root ? String(row.list_root) : ''
      if (!raw) continue
      if (!path.isAbsolute(raw)) continue
      if (isUnderPath(baseRoot, raw) || extractLibraryRelative(raw)) {
        targets.add(raw)
      }
    }
  }
  return targets
}

export async function migrateCacheKeysToRelativeIfNeeded(): Promise<void> {
  const db = getLibraryDb()
  if (!db) return
  try {
    if (getMetaValue(db, CACHE_KEY_MIGRATION_META_KEY_V2) === '1') return
    const baseRoot = getDatabaseRootAbs()
    if (!baseRoot) return
    const roots = collectMigratableCacheRoots(db, baseRoot)
    if (roots.size === 0) {
      setMetaValue(db, CACHE_KEY_MIGRATION_META_KEY_V2, '1')
      return
    }
    for (const root of roots) {
      const rel = isUnderPath(baseRoot, root)
        ? path.relative(baseRoot, root)
        : extractLibraryRelative(root)
      if (!rel) continue
      const newKey = normalizeRoot(rel)
      if (!newKey) continue
      const songMoved = migrateSongCacheRows(db, root, newKey, root)
      const coverMoved = migrateCoverIndexRows(db, root, newKey, root)
      const waveformMoved = migrateWaveformCacheRows(db, root, newKey, root)
    }
    const remaining = collectMigratableCacheRoots(db, baseRoot)
    if (remaining.size === 0) {
      setMetaValue(db, CACHE_KEY_MIGRATION_META_KEY_V2, '1')
    }
  } catch (error) {
    log.error('[sqlite] cache key migration failed', error)
  }
}

export function scheduleCacheKeyMigration(): void {
  if (cacheKeyMigrationScheduled) return
  cacheKeyMigrationScheduled = true
  setTimeout(() => {
    if (!getDatabaseRootAbs()) {
      cacheKeyMigrationScheduled = false
      return
    }
    migrateCacheKeysToRelativeIfNeeded().catch(() => {})
  }, 3000)
}

export async function migrateLegacyCachesInLibrary(
  dbRoot: string,
  roots?: LegacyCacheRoots
): Promise<void> {
  const db = getLibraryDb()
  if (!db || !dbRoot) return
  const resolvedRoots = roots || (await scanLegacyCacheRoots(dbRoot))
  if (resolvedRoots.songRoots.size === 0 && resolvedRoots.coverRoots.size === 0) return
  for (const root of resolvedRoots.songRoots) {
    await ensureSongCacheMigrated(db, root)
  }
  for (const root of resolvedRoots.coverRoots) {
    await ensureCoverIndexMigrated(db, root)
  }
}

export async function scanLegacyCacheRoots(dbRoot: string): Promise<LegacyCacheRoots> {
  const songRoots = new Set<string>()
  const coverRoots = new Set<string>()
  if (!dbRoot) return { songRoots, coverRoots }
  const libRoot = path.join(dbRoot, 'library')
  if (!(await fs.pathExists(libRoot))) return { songRoots, coverRoots }

  const walk = async (dir: string) => {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      let hasSongCache = false
      let hasCoverDir = false
      for (const entry of entries) {
        if (entry.isFile() && entry.name === '.songs.cache.json') {
          hasSongCache = true
        } else if (entry.isDirectory() && entry.name === '.frkb_covers') {
          hasCoverDir = true
        }
      }
      if (hasSongCache) songRoots.add(dir)
      if (hasCoverDir) {
        const indexPath = path.join(dir, '.frkb_covers', '.index.json')
        if (await fs.pathExists(indexPath)) {
          coverRoots.add(dir)
        }
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name === '.frkb_covers') continue
        const full = path.join(dir, entry.name)
        await walk(full)
      }
    } catch {}
  }

  await walk(libRoot)
  return { songRoots, coverRoots }
}
