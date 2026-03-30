import path = require('path')
import fs = require('fs-extra')
import store from './store'
import { log } from './log'

const DB_FILE_NAME = 'FRKB.database.sqlite'
const SCHEMA_VERSION = 23

type SqliteDatabase = any

let db: SqliteDatabase | null = null
let dbRoot: string | null = null

function hasTable(dbInstance: SqliteDatabase, tableName: string): boolean {
  const normalized = String(tableName || '').trim()
  if (!normalized) return false
  try {
    const row = dbInstance
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`)
      .get(normalized)
    return Boolean(row?.name)
  } catch {
    return false
  }
}

function listTableColumns(dbInstance: SqliteDatabase, tableName: string): Set<string> {
  const normalized = String(tableName || '').trim()
  if (!normalized || !hasTable(dbInstance, normalized)) return new Set()
  const safeTableName = normalized.replace(/[^a-zA-Z0-9_]/g, '')
  if (!safeTableName) return new Set()
  try {
    const rows = dbInstance.prepare(`PRAGMA table_info(${safeTableName})`).all() as Array<{
      name?: string
    }>
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
  if (userVersion < 6) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS mixtape_items (
        id TEXT PRIMARY KEY,
        playlist_uuid TEXT NOT NULL,
        file_path TEXT NOT NULL,
        mix_order INTEGER NOT NULL,
        origin_playlist_uuid TEXT,
        origin_path_snapshot TEXT,
        info_json TEXT,
        created_at_ms INTEGER NOT NULL,
        FOREIGN KEY (playlist_uuid) REFERENCES library_nodes(uuid) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_mixtape_items_playlist ON mixtape_items(playlist_uuid);
      CREATE INDEX IF NOT EXISTS idx_mixtape_items_order ON mixtape_items(playlist_uuid, mix_order);
    `)
  }
  if (userVersion < 7) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS mixtape_waveform_cache (
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
      CREATE INDEX IF NOT EXISTS idx_mixtape_waveform_cache_root ON mixtape_waveform_cache(list_root);
    `)
  }
  if (userVersion < 8) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS mixtape_raw_waveform_cache (
        list_root TEXT NOT NULL,
        file_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        version INTEGER NOT NULL,
        sample_rate INTEGER NOT NULL,
        rate INTEGER NOT NULL,
        duration REAL NOT NULL,
        frames INTEGER NOT NULL,
        min_left BLOB NOT NULL,
        max_left BLOB NOT NULL,
        min_right BLOB NOT NULL,
        max_right BLOB NOT NULL,
        PRIMARY KEY (list_root, file_path)
      );
      CREATE INDEX IF NOT EXISTS idx_mixtape_raw_waveform_cache_root ON mixtape_raw_waveform_cache(list_root);
    `)
  }
  if (userVersion < 10) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS mixtape_waveform_hires_cache (
        list_root TEXT NOT NULL,
        file_path TEXT NOT NULL,
        target_rate INTEGER NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        version INTEGER NOT NULL,
        sample_rate INTEGER NOT NULL,
        step REAL NOT NULL,
        duration REAL NOT NULL,
        frames INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (list_root, file_path, target_rate)
      );
      CREATE INDEX IF NOT EXISTS idx_mixtape_waveform_hires_cache_root ON mixtape_waveform_hires_cache(list_root);
      DROP TABLE IF EXISTS mixtape_transcode_cache;
    `)
  }
  if (userVersion < 11) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS mixtape_projects (
        playlist_uuid TEXT PRIMARY KEY,
        mix_mode TEXT NOT NULL DEFAULT 'stem' CHECK (mix_mode IN ('eq', 'stem')),
        stem_mode TEXT NOT NULL DEFAULT '4stems' CHECK (stem_mode IN ('3stems', '4stems')),
        stem_profile TEXT NOT NULL DEFAULT 'quality' CHECK (stem_profile IN ('quality')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY (playlist_uuid) REFERENCES library_nodes(uuid) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_mixtape_projects_mix_mode ON mixtape_projects(mix_mode);
      CREATE INDEX IF NOT EXISTS idx_mixtape_projects_stem_mode ON mixtape_projects(stem_mode);
      CREATE INDEX IF NOT EXISTS idx_mixtape_projects_stem_profile ON mixtape_projects(stem_profile);
    `)
  }
  if (userVersion < 12) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS mixtape_stem_assets (
        list_root TEXT NOT NULL,
        file_path TEXT NOT NULL,
        stem_mode TEXT NOT NULL CHECK (stem_mode IN ('3stems', '4stems')),
        model TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'ready', 'failed')),
        vocal_path TEXT,
        inst_path TEXT,
        bass_path TEXT,
        drums_path TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (list_root, file_path, stem_mode, model)
      );
      CREATE INDEX IF NOT EXISTS idx_mixtape_stem_assets_root ON mixtape_stem_assets(list_root);
      CREATE INDEX IF NOT EXISTS idx_mixtape_stem_assets_file ON mixtape_stem_assets(file_path);
      CREATE INDEX IF NOT EXISTS idx_mixtape_stem_assets_status ON mixtape_stem_assets(status);
    `)
  }
  if (userVersion < 13) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS mixtape_stem_waveform_cache (
        list_root TEXT NOT NULL,
        file_path TEXT NOT NULL,
        stem_mode TEXT NOT NULL CHECK (stem_mode IN ('3stems', '4stems')),
        model TEXT NOT NULL,
        stem_version TEXT NOT NULL,
        target_rate INTEGER NOT NULL,
        source_signature TEXT NOT NULL,
        cache_version INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        meta_json TEXT NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (list_root, file_path, stem_mode, model, stem_version, target_rate)
      );
      CREATE INDEX IF NOT EXISTS idx_mixtape_stem_waveform_cache_root ON mixtape_stem_waveform_cache(list_root);
      CREATE INDEX IF NOT EXISTS idx_mixtape_stem_waveform_cache_file ON mixtape_stem_waveform_cache(file_path);
    `)
  }
  if (userVersion < 14) {
    try {
      instance.exec(
        `ALTER TABLE mixtape_projects ADD COLUMN stem_profile TEXT NOT NULL DEFAULT 'quality' CHECK (stem_profile IN ('quality'))`
      )
    } catch {}
    instance.exec(`
      UPDATE mixtape_projects
      SET stem_profile = 'quality';
      CREATE INDEX IF NOT EXISTS idx_mixtape_projects_stem_profile ON mixtape_projects(stem_profile);
    `)
  }
  if (userVersion < 15) {
  }
  if (userVersion < 16) {
    try {
      instance.exec(
        `ALTER TABLE mixtape_projects ADD COLUMN mix_mode TEXT NOT NULL DEFAULT 'stem' CHECK (mix_mode IN ('eq', 'stem'))`
      )
    } catch {}
    instance.exec(`
      UPDATE mixtape_projects
      SET mix_mode = CASE
            WHEN mix_mode IN ('eq', 'stem') THEN mix_mode
            WHEN mix_mode = 'traditional' THEN 'eq'
            ELSE 'stem'
          END;
      CREATE INDEX IF NOT EXISTS idx_mixtape_projects_mix_mode ON mixtape_projects(mix_mode);
    `)
  }
  if (userVersion < 17) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS mixtape_stem_assets (
        list_root TEXT NOT NULL,
        file_path TEXT NOT NULL,
        stem_mode TEXT NOT NULL CHECK (stem_mode IN ('3stems', '4stems')),
        model TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'ready', 'failed')),
        vocal_path TEXT,
        inst_path TEXT,
        bass_path TEXT,
        drums_path TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (list_root, file_path, stem_mode, model)
      );
      CREATE INDEX IF NOT EXISTS idx_mixtape_stem_assets_root ON mixtape_stem_assets(list_root);
      CREATE INDEX IF NOT EXISTS idx_mixtape_stem_assets_file ON mixtape_stem_assets(file_path);
      CREATE INDEX IF NOT EXISTS idx_mixtape_stem_assets_status ON mixtape_stem_assets(status);
    `)

    let columns = listTableColumns(instance, 'mixtape_stem_assets')
    if (!columns.has('inst_path')) {
      if (columns.has('harmonic_path')) {
        try {
          instance.exec(`ALTER TABLE mixtape_stem_assets RENAME COLUMN harmonic_path TO inst_path`)
        } catch {}
      }
      columns = listTableColumns(instance, 'mixtape_stem_assets')
      if (!columns.has('inst_path')) {
        try {
          instance.exec(`ALTER TABLE mixtape_stem_assets ADD COLUMN inst_path TEXT`)
        } catch {}
      }
    }

    columns = listTableColumns(instance, 'mixtape_stem_assets')
    if (columns.has('inst_path') && columns.has('harmonic_path')) {
      try {
        instance.exec(`
          UPDATE mixtape_stem_assets
          SET inst_path = CASE
                WHEN inst_path IS NULL OR inst_path = '' THEN harmonic_path
                ELSE inst_path
              END
          WHERE harmonic_path IS NOT NULL AND harmonic_path != '';
        `)
      } catch {}
    }
  }
  if (userVersion < 18) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS mixtape_projects__next (
        playlist_uuid TEXT PRIMARY KEY,
        mix_mode TEXT NOT NULL DEFAULT 'stem' CHECK (mix_mode IN ('eq', 'stem')),
        stem_mode TEXT NOT NULL DEFAULT '4stems' CHECK (stem_mode IN ('3stems', '4stems')),
        stem_profile TEXT NOT NULL DEFAULT 'quality' CHECK (stem_profile IN ('quality')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY (playlist_uuid) REFERENCES library_nodes(uuid) ON DELETE CASCADE
      );
    `)
    const projectColumns = listTableColumns(instance, 'mixtape_projects')
    const stemProfileSelect = projectColumns.has('stem_profile') ? 'stem_profile' : `'quality'`
    instance.exec(`
      INSERT INTO mixtape_projects__next (
        playlist_uuid,
        mix_mode,
        stem_mode,
        stem_profile,
        created_at_ms,
        updated_at_ms
      )
      SELECT
        playlist_uuid,
        CASE
          WHEN mix_mode = 'traditional' THEN 'eq'
          WHEN mix_mode = 'eq' THEN 'eq'
          ELSE 'stem'
        END,
        CASE
          WHEN stem_mode IN ('3stems', '4stems') THEN stem_mode
          ELSE '4stems'
        END,
        ${stemProfileSelect},
        created_at_ms,
        updated_at_ms
      FROM mixtape_projects;

      DROP TABLE mixtape_projects;
      ALTER TABLE mixtape_projects__next RENAME TO mixtape_projects;
      CREATE INDEX IF NOT EXISTS idx_mixtape_projects_mix_mode ON mixtape_projects(mix_mode);
      CREATE INDEX IF NOT EXISTS idx_mixtape_projects_stem_mode ON mixtape_projects(stem_mode);
      CREATE INDEX IF NOT EXISTS idx_mixtape_projects_stem_profile ON mixtape_projects(stem_profile);
    `)
  }
  if (userVersion < 23) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS library_stem_assets (
        library_root TEXT NOT NULL,
        source_signature TEXT NOT NULL,
        file_path TEXT NOT NULL,
        stem_mode TEXT NOT NULL CHECK (stem_mode IN ('3stems', '4stems')),
        model TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'ready', 'failed')),
        vocal_path TEXT,
        inst_path TEXT,
        bass_path TEXT,
        drums_path TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (library_root, source_signature, stem_mode, model)
      );
      CREATE INDEX IF NOT EXISTS idx_library_stem_assets_root ON library_stem_assets(library_root);
      CREATE INDEX IF NOT EXISTS idx_library_stem_assets_file ON library_stem_assets(file_path);
      CREATE INDEX IF NOT EXISTS idx_library_stem_assets_status ON library_stem_assets(status);
    `)
  }
  if (userVersion < 19) {
    const projectColumns = listTableColumns(instance, 'mixtape_projects')
    if (projectColumns.has('stem_profile')) {
      instance.exec(`
        UPDATE mixtape_projects
        SET mix_mode = CASE
              WHEN mix_mode = 'traditional' THEN 'eq'
              WHEN mix_mode = 'eq' THEN 'eq'
              ELSE 'stem'
            END,
            stem_profile = 'quality';
        CREATE INDEX IF NOT EXISTS idx_mixtape_projects_stem_profile ON mixtape_projects(stem_profile);
      `)
    } else {
      instance.exec(`
        CREATE TABLE IF NOT EXISTS mixtape_projects__next_v19 (
          playlist_uuid TEXT PRIMARY KEY,
          mix_mode TEXT NOT NULL DEFAULT 'stem' CHECK (mix_mode IN ('eq', 'stem')),
          stem_mode TEXT NOT NULL DEFAULT '4stems' CHECK (stem_mode IN ('3stems', '4stems')),
          stem_profile TEXT NOT NULL DEFAULT 'quality' CHECK (stem_profile IN ('quality')),
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          FOREIGN KEY (playlist_uuid) REFERENCES library_nodes(uuid) ON DELETE CASCADE
        );

        INSERT INTO mixtape_projects__next_v19 (
          playlist_uuid,
          mix_mode,
          stem_mode,
          stem_profile,
          created_at_ms,
          updated_at_ms
        )
        SELECT
          playlist_uuid,
          CASE
            WHEN mix_mode = 'traditional' THEN 'eq'
            WHEN mix_mode = 'eq' THEN 'eq'
            ELSE 'stem'
          END,
          CASE
            WHEN stem_mode IN ('3stems', '4stems') THEN stem_mode
            ELSE '4stems'
          END,
          'quality',
          created_at_ms,
          updated_at_ms
        FROM mixtape_projects;

        DROP TABLE mixtape_projects;
        ALTER TABLE mixtape_projects__next_v19 RENAME TO mixtape_projects;
        CREATE INDEX IF NOT EXISTS idx_mixtape_projects_mix_mode ON mixtape_projects(mix_mode);
        CREATE INDEX IF NOT EXISTS idx_mixtape_projects_stem_mode ON mixtape_projects(stem_mode);
        CREATE INDEX IF NOT EXISTS idx_mixtape_projects_stem_profile ON mixtape_projects(stem_profile);
      `)
    }
  }
  if (userVersion < 20) {
    const projectColumns = listTableColumns(instance, 'mixtape_projects')
    if (projectColumns.has('stem_strategy_confirmed')) {
      instance.exec(`
        CREATE TABLE IF NOT EXISTS mixtape_projects__next_v20 (
          playlist_uuid TEXT PRIMARY KEY,
          mix_mode TEXT NOT NULL DEFAULT 'stem' CHECK (mix_mode IN ('eq', 'stem')),
          stem_mode TEXT NOT NULL DEFAULT '4stems' CHECK (stem_mode IN ('3stems', '4stems')),
          stem_profile TEXT NOT NULL DEFAULT 'quality' CHECK (stem_profile IN ('quality')),
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          FOREIGN KEY (playlist_uuid) REFERENCES library_nodes(uuid) ON DELETE CASCADE
        );

        INSERT INTO mixtape_projects__next_v20 (
          playlist_uuid,
          mix_mode,
          stem_mode,
          stem_profile,
          created_at_ms,
          updated_at_ms
        )
        SELECT
          playlist_uuid,
          CASE
            WHEN mix_mode = 'traditional' THEN 'eq'
            WHEN mix_mode = 'eq' THEN 'eq'
            ELSE 'stem'
          END,
          CASE
            WHEN stem_mode IN ('3stems', '4stems') THEN stem_mode
            ELSE '4stems'
          END,
          CASE
            WHEN stem_profile IN ('quality') THEN stem_profile
            ELSE 'quality'
          END,
          created_at_ms,
          updated_at_ms
        FROM mixtape_projects;

        DROP TABLE mixtape_projects;
        ALTER TABLE mixtape_projects__next_v20 RENAME TO mixtape_projects;
        CREATE INDEX IF NOT EXISTS idx_mixtape_projects_mix_mode ON mixtape_projects(mix_mode);
        CREATE INDEX IF NOT EXISTS idx_mixtape_projects_stem_mode ON mixtape_projects(stem_mode);
        CREATE INDEX IF NOT EXISTS idx_mixtape_projects_stem_profile ON mixtape_projects(stem_profile);
      `)
    }
  }
  if (userVersion < 21) {
    const projectColumns = listTableColumns(instance, 'mixtape_projects')
    if (!projectColumns.has('info_json')) {
      try {
        instance.exec(`ALTER TABLE mixtape_projects ADD COLUMN info_json TEXT`)
      } catch {}
    }
  }
  if (userVersion < 22) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS pioneer_preview_waveform_cache (
        list_root TEXT NOT NULL,
        analyze_path TEXT NOT NULL,
        cache_version INTEGER NOT NULL,
        signature TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ready', 'missing')),
        preview_file_path TEXT,
        data_json TEXT,
        error TEXT,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (list_root, analyze_path)
      );
      CREATE INDEX IF NOT EXISTS idx_pioneer_preview_waveform_cache_root ON pioneer_preview_waveform_cache(list_root);
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
