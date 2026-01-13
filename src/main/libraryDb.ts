import path = require('path')
import fs = require('fs-extra')
import store from './store'
import { log } from './log'

const DB_FILE_NAME = 'FRKB.database.sqlite'
const SCHEMA_VERSION = 5

type SqliteDatabase = any

let db: SqliteDatabase | null = null
let dbRoot: string | null = null

function createDatabase(dbPath: string): SqliteDatabase {
  const Database = require('better-sqlite3')
  const instance = new Database(dbPath)
  instance.pragma('foreign_keys = ON')
  const userVersion = instance.pragma('user_version', { simple: true }) as number
  if (userVersion < 1) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fingerprints (
        mode TEXT NOT NULL,
        hash TEXT NOT NULL,
        PRIMARY KEY (mode, hash)
      );
      CREATE INDEX IF NOT EXISTS idx_fingerprints_mode ON fingerprints(mode);
    `)
  }
  if (userVersion < 2) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS song_cache (
        list_root TEXT NOT NULL,
        file_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        info_json TEXT NOT NULL,
        PRIMARY KEY (list_root, file_path)
      );
      CREATE INDEX IF NOT EXISTS idx_song_cache_root ON song_cache(list_root);
      CREATE TABLE IF NOT EXISTS cover_index (
        list_root TEXT NOT NULL,
        file_path TEXT NOT NULL,
        hash TEXT NOT NULL,
        ext TEXT NOT NULL,
        PRIMARY KEY (list_root, file_path)
      );
      CREATE INDEX IF NOT EXISTS idx_cover_index_root ON cover_index(list_root);
      CREATE INDEX IF NOT EXISTS idx_cover_index_hash ON cover_index(list_root, hash);
    `)
  }
  if (userVersion < 3) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS library_nodes (
        uuid TEXT PRIMARY KEY,
        parent_uuid TEXT,
        dir_name TEXT NOT NULL,
        node_type TEXT NOT NULL,
        sort_order INTEGER,
        FOREIGN KEY (parent_uuid) REFERENCES library_nodes(uuid) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_library_nodes_parent ON library_nodes(parent_uuid);
      CREATE INDEX IF NOT EXISTS idx_library_nodes_type ON library_nodes(node_type);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_library_nodes_parent_dir ON library_nodes(parent_uuid, dir_name);
    `)
  }
  if (userVersion < 4) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS waveform_cache (
        list_root TEXT NOT NULL,
        file_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        version INTEGER NOT NULL,
        sample_rate INTEGER NOT NULL,
        step REAL NOT NULL,
        duration REAL NOT NULL,
        frames INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (list_root, file_path)
      );
      CREATE INDEX IF NOT EXISTS idx_waveform_cache_root ON waveform_cache(list_root);
    `)
  }
  if (userVersion < 5) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS recycle_bin_records (
        file_path TEXT PRIMARY KEY,
        deleted_at_ms INTEGER NOT NULL,
        original_playlist_path TEXT,
        original_file_name TEXT,
        source_type TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_recycle_bin_deleted_at ON recycle_bin_records(deleted_at_ms);
      CREATE INDEX IF NOT EXISTS idx_recycle_bin_playlist ON recycle_bin_records(original_playlist_path);
    `)
  }
  if (userVersion < SCHEMA_VERSION) {
    instance.pragma('user_version = ' + SCHEMA_VERSION)
  }
  return instance
}

export function getLibraryDbPath(dirPath: string): string {
  return path.join(dirPath, DB_FILE_NAME)
}

export function initLibraryDb(dirPath: string): SqliteDatabase | null {
  if (!dirPath) return null
  if (db && dbRoot === dirPath) return db
  try {
    closeLibraryDb()
    fs.ensureDirSync(dirPath)
    db = createDatabase(getLibraryDbPath(dirPath))
    dbRoot = dirPath
    return db
  } catch (error) {
    db = null
    dbRoot = dirPath
    log.error('[sqlite] init failed', error)
    return null
  }
}

export function getLibraryDb(): SqliteDatabase | null {
  const dir = store.databaseDir || store.settingConfig?.databaseUrl || ''
  if (!dir) return null
  return initLibraryDb(dir)
}

export function closeLibraryDb(): void {
  if (db) {
    try {
      db.close()
    } catch {}
  }
  db = null
  dbRoot = null
}

export function getMetaValue(dbInstance: SqliteDatabase, key: string): string | null {
  try {
    const row = dbInstance.prepare('SELECT value FROM meta WHERE key = ?').get(key)
    return row ? String(row.value) : null
  } catch {
    return null
  }
}

export function setMetaValue(dbInstance: SqliteDatabase, key: string, value: string): void {
  try {
    dbInstance
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value)
  } catch {}
}
