import type { SqliteDatabase } from '../libraryDb'

export const CURATED_LIBRARY_SYNC_SCHEMA_VERSION = 40

const CURATED_SYNC_FILES_SQL = `
  CREATE TABLE IF NOT EXISTS curated_sync_files (
    file_id TEXT PRIMARY KEY,
    relative_path TEXT NOT NULL,
    parent_uuid TEXT NOT NULL,
    file_name TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    content_size INTEGER NOT NULL,
    mtime_ms INTEGER,
    track_number INTEGER,
    added_at_ms INTEGER,
    updated_at_ms INTEGER NOT NULL,
    location TEXT NOT NULL DEFAULT 'curated',
    location_path TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_curated_sync_files_rel
    ON curated_sync_files(relative_path);
  CREATE INDEX IF NOT EXISTS idx_curated_sync_files_sha
    ON curated_sync_files(content_sha256);
  CREATE INDEX IF NOT EXISTS idx_curated_sync_files_parent
    ON curated_sync_files(parent_uuid);
  CREATE INDEX IF NOT EXISTS idx_curated_sync_files_location
    ON curated_sync_files(location);
`

const listTableColumns = (db: SqliteDatabase, tableName: string): Set<string> => {
  const normalized = String(tableName || '')
    .trim()
    .replace(/[^a-zA-Z0-9_]/g, '')
  if (!normalized) return new Set()
  try {
    const rows = db.prepare<{ name?: string }>(`PRAGMA table_info(${normalized})`).all()
    const columns = new Set<string>()
    for (const row of rows) {
      const name = String(row?.name || '').trim()
      if (name) columns.add(name)
    }
    return columns
  } catch {
    return new Set()
  }
}

const addColumnIfMissing = (
  db: SqliteDatabase,
  tableName: string,
  columnName: string,
  ddl: string
) => {
  const columns = listTableColumns(db, tableName)
  if (columns.has(columnName)) return
  try {
    db.exec(ddl)
  } catch {}
}

export const applyCuratedLibrarySyncSchema = (db: SqliteDatabase): void => {
  db.exec(CURATED_SYNC_FILES_SQL)
  addColumnIfMissing(
    db,
    'recycle_bin_records',
    'file_id',
    'ALTER TABLE recycle_bin_records ADD COLUMN file_id TEXT'
  )
  addColumnIfMissing(
    db,
    'recycle_bin_records',
    'content_sha256',
    'ALTER TABLE recycle_bin_records ADD COLUMN content_sha256 TEXT'
  )
  addColumnIfMissing(
    db,
    'recycle_bin_records',
    'content_size',
    'ALTER TABLE recycle_bin_records ADD COLUMN content_size INTEGER'
  )
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_recycle_bin_file_id ON recycle_bin_records(file_id)')
  } catch {}
}
