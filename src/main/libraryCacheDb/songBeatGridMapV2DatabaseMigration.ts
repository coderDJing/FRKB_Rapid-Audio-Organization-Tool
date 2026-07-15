import type { SqliteDatabase } from '../libraryDb'
import { stripMixtapeGridCopies } from '../services/mixtapeAnalysisInfo'
import { migrateSongInfoBeatGridMapV2 } from './songBeatGridMapV2Migration'

type JsonRow = { rowid: number; json: string | null }

export type SongBeatGridMapV2DatabaseMigrationReport = {
  canonicalMigrated: number
  canonicalInvalidGrid: number
  canonicalWithoutGrid: number
  mixtapeGridCopiesRemoved: number
  setGridCopiesRemoved: number
}

export type SongBeatGridMapV2DatabaseMigrationProgress = {
  processedRows: number
  totalRows: number
}

export type SongBeatGridMapV2DatabaseMigrationOptions = {
  onProgress?: (progress: SongBeatGridMapV2DatabaseMigrationProgress) => void
  transactional?: boolean
}

const hasTable = (db: SqliteDatabase, tableName: string): boolean =>
  Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName)
  )

const parseInfoJson = (raw: unknown): Record<string, unknown> | null => {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

const countRows = (db: SqliteDatabase, tableName: string): number => {
  if (!hasTable(db, tableName)) return 0
  const row = db.prepare(`SELECT COUNT(1) as count FROM ${tableName}`).get() as { count?: unknown }
  const count = Number(row?.count)
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
}

const migrateCanonicalTable = (
  db: SqliteDatabase,
  tableName: 'song_cache' | 'external_analysis_cache',
  report: SongBeatGridMapV2DatabaseMigrationReport,
  onRowProcessed: () => void
): void => {
  if (!hasTable(db, tableName)) return
  const rows = db.prepare(`SELECT rowid, info_json as json FROM ${tableName}`).all() as JsonRow[]
  const update = db.prepare(`UPDATE ${tableName} SET info_json = ? WHERE rowid = ?`)
  for (const row of rows) {
    const info = parseInfoJson(row.json)
    if (!info) continue
    const result = migrateSongInfoBeatGridMapV2(info)
    if (result.outcome === 'migrated') report.canonicalMigrated += 1
    if (result.outcome === 'invalid-grid') report.canonicalInvalidGrid += 1
    if (result.outcome === 'no-grid') report.canonicalWithoutGrid += 1
    const nextJson = JSON.stringify(result.info)
    if (nextJson !== row.json) update.run(nextJson, row.rowid)
    onRowProcessed()
  }
}

const removeProjectGridCopies = (
  db: SqliteDatabase,
  tableName: 'mixtape_items' | 'set_items',
  jsonColumn: 'info_json' | 'analysis_json',
  onRowProcessed: () => void
): number => {
  if (!hasTable(db, tableName)) return 0
  const rows = db
    .prepare(`SELECT rowid, ${jsonColumn} as json FROM ${tableName}`)
    .all() as JsonRow[]
  const update = db.prepare(`UPDATE ${tableName} SET ${jsonColumn} = ? WHERE rowid = ?`)
  let removed = 0
  for (const row of rows) {
    const info = parseInfoJson(row.json)
    if (info && stripMixtapeGridCopies(info)) {
      update.run(JSON.stringify(info), row.rowid)
      removed += 1
    }
    onRowProcessed()
  }
  return removed
}

export const migrateSongBeatGridMapV2Database = (
  db: SqliteDatabase,
  options: SongBeatGridMapV2DatabaseMigrationOptions = {}
): SongBeatGridMapV2DatabaseMigrationReport => {
  const report: SongBeatGridMapV2DatabaseMigrationReport = {
    canonicalMigrated: 0,
    canonicalInvalidGrid: 0,
    canonicalWithoutGrid: 0,
    mixtapeGridCopiesRemoved: 0,
    setGridCopiesRemoved: 0
  }
  const totalRows =
    countRows(db, 'song_cache') +
    countRows(db, 'external_analysis_cache') +
    countRows(db, 'mixtape_items') +
    countRows(db, 'set_items')
  let processedRows = 0
  let lastReportedProcessedRows = -1
  const reportProgress = (force = false) => {
    if (!options.onProgress) return
    if (
      (force || processedRows === totalRows || processedRows % 25 === 0) &&
      processedRows !== lastReportedProcessedRows
    ) {
      options.onProgress({ processedRows, totalRows })
      lastReportedProcessedRows = processedRows
    }
  }
  const onRowProcessed = () => {
    processedRows += 1
    reportProgress()
  }
  const runMigration = () => {
    reportProgress(true)
    migrateCanonicalTable(db, 'song_cache', report, onRowProcessed)
    migrateCanonicalTable(db, 'external_analysis_cache', report, onRowProcessed)
    report.mixtapeGridCopiesRemoved = removeProjectGridCopies(
      db,
      'mixtape_items',
      'info_json',
      onRowProcessed
    )
    report.setGridCopiesRemoved = removeProjectGridCopies(
      db,
      'set_items',
      'analysis_json',
      onRowProcessed
    )
    reportProgress(true)
  }
  if (options.transactional === false) {
    runMigration()
  } else {
    db.transaction(runMigration)()
  }
  return report
}
