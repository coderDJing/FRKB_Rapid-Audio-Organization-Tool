import { getLibraryDb } from '../libraryDb'
import type { SqliteDatabase } from '../libraryDb'
import { log } from '../log'
import { performance } from 'node:perf_hooks'
import { collectSqliteReadContext, type SqliteReadContext } from '../services/sqliteReadDiagnostics'
import { readSongCacheOffMainThread } from '../services/songCacheReadWorker'
import type { SongCacheDbRow } from './songCacheRead'
import type { ISongInfo } from '../../types/globals'
import type { SongCacheEntry } from './types'
import {
  toNumber,
  resolveListRootInput,
  resolveFilePathInput,
  resolveAbsoluteListRoot,
  resolveAbsoluteFilePath
} from './pathResolvers'

type SongCacheLoadHelpers = {
  ensureMigrated: (db: SqliteDatabase, listRoot: string) => Promise<void>
  findLooseRoots: (
    db: SqliteDatabase,
    candidates: Array<string | null | undefined>,
    listRootKey: string
  ) => string[]
  migrateRows: (
    db: SqliteDatabase,
    oldListRoot: string,
    newListRootKey: string,
    listRootAbs: string
  ) => number
}

// 临时诊断：经扫描结果返回主进程，仅慢打开时落盘，根因修复复测后删除。
export type SongCacheLoadTimings = {
  migrationCheckMs: number
  readAndWorkerMs: number
  parseAndMapMs: number
  looseRootLookupMs: number
  migrationWriteMs: number
  totalMs: number
  context?: SqliteReadContext
}

const contextCollected = new WeakSet<SqliteDatabase>()

export async function loadSongCacheWithHelpers(
  listRoot: string,
  helpers: SongCacheLoadHelpers,
  onTimings?: (timings: SongCacheLoadTimings) => void
): Promise<Map<string, SongCacheEntry> | null> {
  const db = getLibraryDb()
  if (!db || !listRoot) return null
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return null
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  const startedAt = performance.now()
  const timings: SongCacheLoadTimings = {
    migrationCheckMs: 0,
    readAndWorkerMs: 0,
    parseAndMapMs: 0,
    looseRootLookupMs: 0,
    migrationWriteMs: 0,
    totalMs: 0
  }
  try {
    await helpers.ensureMigrated(db, listRoot)
    timings.migrationCheckMs = Math.round(performance.now() - startedAt)
    // 主进程只做路径映射；可能等待磁盘/锁的全量 SELECT 在只读 worker 中执行。
    const map = await (async () => {
      const loaded = new Map<string, SongCacheEntry>()
      const appendRows = (rowsToUse: SongCacheDbRow[], rootKey: string, legacyRelRoot?: string) => {
        const parseStartedAt = performance.now()
        for (const row of rowsToUse) {
          if (!row || !row.file_path || row.info_json === undefined) continue
          let info: ISongInfo | null = null
          try {
            info = JSON.parse(String(row.info_json)) as ISongInfo
          } catch {
            info = null
          }
          const size = toNumber(row.size)
          const mtimeMs = toNumber(row.mtime_ms)
          if (!info || size === null || mtimeMs === null) continue
          let absFilePath = resolveAbsoluteFilePath(rootKey, String(row.file_path))
          if (legacyRelRoot) {
            const resolvedLegacy = resolveFilePathInput(legacyRelRoot, String(row.file_path))
            if (resolvedLegacy && resolvedLegacy.isRelativeKey) {
              absFilePath = resolveAbsoluteFilePath(listRootKey, resolvedLegacy.key)
            }
          }
          info.filePath = absFilePath
          loaded.set(absFilePath, { size, mtimeMs, info })
        }
        timings.parseAndMapMs += Math.round(performance.now() - parseStartedAt)
      }
      const readStartedAt = performance.now()
      const [rows, legacyRows = []] = await readSongCacheOffMainThread(
        db,
        legacyListRoot ? [listRootKey, legacyListRoot] : [listRootKey]
      )
      timings.readAndWorkerMs += Math.round(performance.now() - readStartedAt)
      // await 期间允许用户切库，不能把旧库结果按新库根目录映射或迁移。
      if (getLibraryDb() !== db) return null
      const looseStartedAt = performance.now()
      const looseRoots =
        rows.length === 0 && legacyRows.length === 0
          ? helpers
              .findLooseRoots(db, [listRoot, listRootAbs, listRootKey], listRootKey)
              .filter((root) => root !== listRootKey && root !== legacyListRoot)
          : []
      timings.looseRootLookupMs = Math.round(performance.now() - looseStartedAt)
      if (looseRoots.length > 0) {
        const extraReadStartedAt = performance.now()
        const extraBatches = await readSongCacheOffMainThread(db, looseRoots)
        timings.readAndWorkerMs += Math.round(performance.now() - extraReadStartedAt)
        if (getLibraryDb() !== db) return null
        for (const [index, root] of looseRoots.entries()) {
          const extraRows = extraBatches[index]
          if (extraRows && extraRows.length > 0) {
            appendRows(extraRows, root, listRootAbs)
            if (resolvedRoot.isRelativeKey && listRootAbs) {
              const migrationStartedAt = performance.now()
              helpers.migrateRows(db, root, listRootKey, listRootAbs)
              timings.migrationWriteMs += Math.round(performance.now() - migrationStartedAt)
            }
          }
        }
      }
      appendRows(rows, listRootKey)
      if (legacyRows && legacyRows.length > 0 && legacyListRoot && listRootAbs) {
        appendRows(legacyRows, legacyListRoot, legacyListRoot)
        if (resolvedRoot.isRelativeKey) {
          const migrationStartedAt = performance.now()
          helpers.migrateRows(db, legacyListRoot, listRootKey, listRootAbs)
          timings.migrationWriteMs += Math.round(performance.now() - migrationStartedAt)
        }
      }
      return loaded
    })()
    return map
  } catch (error) {
    log.error('[sqlite] song cache load failed', error)
    return null
  } finally {
    if (onTimings) {
      timings.totalMs = Math.round(performance.now() - startedAt)
      if (timings.totalMs >= 500 && getLibraryDb() === db && !contextCollected.has(db)) {
        contextCollected.add(db)
        timings.context = collectSqliteReadContext(
          db,
          'SELECT file_path, size, mtime_ms, info_json FROM song_cache WHERE list_root = ?',
          [listRootKey]
        )
      }
      onTimings(timings)
    }
  }
}
