import path = require('path')
import fs = require('fs-extra')
import store from './store'
import { log } from './log'
import {
  assertRegisteredLibraryMetadataKey,
  LibraryMetadataContractError
} from '../shared/libraryMetadataContracts'
import {
  assertLibraryMergeParticipantCoverage,
  LibraryMergeParticipantContractError
} from './services/libraryMerge/participants'

const DB_FILE_NAME = 'FRKB.database.sqlite'
const SCHEMA_VERSION = 38
export const MAX_SUPPORTED_DATABASE_SCHEMA_VERSION = SCHEMA_VERSION

type SqliteDatabaseCtor = typeof import('better-sqlite3')

export type SqliteDatabase = InstanceType<SqliteDatabaseCtor>
type SqliteRow = Record<string, unknown>

export class DatabaseSchemaVersionError extends Error {
  readonly databasePath: string
  readonly databaseVersion: number
  readonly maximumSupportedVersion: number

  constructor(databasePath: string, databaseVersion: number, maximumSupportedVersion: number) {
    super(
      `数据库版本 ${databaseVersion} 高于当前软件支持上限 ${maximumSupportedVersion}：${databasePath}`
    )
    this.name = 'DatabaseSchemaVersionError'
    this.databasePath = databasePath
    this.databaseVersion = databaseVersion
    this.maximumSupportedVersion = maximumSupportedVersion
  }
}

export class DatabaseSchemaMigrationRequiredError extends Error {
  constructor(
    readonly databasePath: string,
    readonly databaseVersion: number
  ) {
    super(`数据库需要先完成受保护升级：${databasePath}（当前版本 ${databaseVersion}）`)
    this.name = 'DatabaseSchemaMigrationRequiredError'
  }
}

export const isDatabaseSchemaVersionError = (error: unknown): error is DatabaseSchemaVersionError =>
  error instanceof DatabaseSchemaVersionError

export const isDatabaseSchemaMigrationRequiredError = (
  error: unknown
): error is DatabaseSchemaMigrationRequiredError =>
  error instanceof DatabaseSchemaMigrationRequiredError

export function isSqliteRow(value: unknown): value is SqliteRow {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

let db: SqliteDatabase | null = null
let dbRoot: string | null = null

const isConfiguredDevDatabase = (dirPath: string): boolean => {
  if (process.env.FRKB_APP_PACKAGED === '1') return false
  const configured = String(process.env.FRKB_DEV_DATABASE_URL || '').trim()
  if (!configured || !dirPath) return false
  const current = path.resolve(dirPath)
  const expected = path.resolve(configured)
  return process.platform === 'win32'
    ? current.toLocaleLowerCase() === expected.toLocaleLowerCase()
    : current === expected
}

function hasTable(dbInstance: SqliteDatabase, tableName: string): boolean {
  const normalized = String(tableName || '').trim()
  if (!normalized) return false
  try {
    const row = dbInstance
      .prepare<{
        name?: string
      }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`)
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
    const rows = dbInstance.prepare<{ name?: string }>(`PRAGMA table_info(${safeTableName})`).all()
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

function assertStoredMetadataContracts(dbInstance: SqliteDatabase): void {
  const rows = dbInstance.prepare('SELECT key FROM meta ORDER BY key ASC').all() as Array<{
    key?: unknown
  }>
  for (const row of rows) {
    assertRegisteredLibraryMetadataKey(typeof row.key === 'string' ? row.key : '')
  }
}

const readDatabaseSchemaVersion = (dbInstance: SqliteDatabase): number => {
  const value = Number(dbInstance.pragma('user_version', { simple: true }))
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

const assertSupportedDatabaseSchemaVersion = (dbPath: string, userVersion: number): void => {
  if (userVersion > MAX_SUPPORTED_DATABASE_SCHEMA_VERSION) {
    throw new DatabaseSchemaVersionError(dbPath, userVersion, MAX_SUPPORTED_DATABASE_SCHEMA_VERSION)
  }
}

// 只读预检必须发生在任何 WAL、迁移或业务查询之前。
export function assertExistingDatabaseSchemaSupported(dbPath: string): number {
  const normalizedPath = String(dbPath || '').trim()
  if (!normalizedPath) throw new Error('数据库路径不能为空')
  const Database = require('better-sqlite3') as SqliteDatabaseCtor
  const instance = new Database(normalizedPath, { readonly: true, fileMustExist: true })
  try {
    const userVersion = readDatabaseSchemaVersion(instance)
    assertSupportedDatabaseSchemaVersion(normalizedPath, userVersion)
    return userVersion
  } finally {
    instance.close()
  }
}

function createDatabase(dbPath: string): SqliteDatabase {
  const Database = require('better-sqlite3') as SqliteDatabaseCtor
  const instance = new Database(dbPath)
  const userVersion = readDatabaseSchemaVersion(instance)
  try {
    assertSupportedDatabaseSchemaVersion(dbPath, userVersion)
    if (userVersion > 0 && userVersion < SCHEMA_VERSION) {
      throw new DatabaseSchemaMigrationRequiredError(dbPath, userVersion)
    }
  } catch (error) {
    instance.close()
    throw error
  }
  instance.pragma('journal_mode = WAL')
  instance.pragma('busy_timeout = 5000')
  instance.pragma('foreign_keys = ON')
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
        mean_left BLOB,
        mean_right BLOB,
        rms_left BLOB,
        rms_right BLOB,
        PRIMARY KEY (list_root, file_path)
      );
      CREATE INDEX IF NOT EXISTS idx_mixtape_raw_waveform_cache_root ON mixtape_raw_waveform_cache(list_root);
    `)
  }
  if (userVersion < 10) {
    instance.exec(`
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
    instance.transaction(() => {
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
    })()
  }
  if (userVersion < 16) {
    instance.transaction(() => {
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
    })()
  }
  if (userVersion < 17) {
    instance.transaction(() => {
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
            instance.exec(
              `ALTER TABLE mixtape_stem_assets RENAME COLUMN harmonic_path TO inst_path`
            )
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
    })()
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
    instance.transaction(() => {
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
    })()
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
      instance.transaction(() => {
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
      })()
    }
  }
  if (userVersion < 20) {
    const projectColumns = listTableColumns(instance, 'mixtape_projects')
    if (projectColumns.has('stem_strategy_confirmed')) {
      instance.transaction(() => {
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
      })()
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
  if (userVersion < 24) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS external_analysis_devices (
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        root_path TEXT,
        last_seen_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (source_kind, source_id)
      );
      CREATE INDEX IF NOT EXISTS idx_external_analysis_devices_seen ON external_analysis_devices(last_seen_at_ms);

      CREATE TABLE IF NOT EXISTS external_analysis_cache (
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        info_json TEXT NOT NULL,
        waveform_version INTEGER,
        waveform_sample_rate INTEGER,
        waveform_step REAL,
        waveform_duration REAL,
        waveform_frames INTEGER,
        waveform_data BLOB,
        last_seen_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (source_kind, source_id, relative_path)
      );
      CREATE INDEX IF NOT EXISTS idx_external_analysis_cache_source ON external_analysis_cache(source_kind, source_id);
      CREATE INDEX IF NOT EXISTS idx_external_analysis_cache_file ON external_analysis_cache(file_path);
      CREATE INDEX IF NOT EXISTS idx_external_analysis_cache_seen ON external_analysis_cache(last_seen_at_ms);
    `)
  }
  // Safety net: ensure external analysis tables exist even if migration was interrupted
  instance.exec(`
    CREATE TABLE IF NOT EXISTS external_analysis_devices (
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      root_path TEXT,
      last_seen_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (source_kind, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_external_analysis_devices_seen ON external_analysis_devices(last_seen_at_ms);

    CREATE TABLE IF NOT EXISTS external_analysis_cache (
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      file_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      info_json TEXT NOT NULL,
      waveform_version INTEGER,
      waveform_sample_rate INTEGER,
      waveform_step REAL,
      waveform_duration REAL,
      waveform_frames INTEGER,
      waveform_data BLOB,
      last_seen_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (source_kind, source_id, relative_path)
    );
    CREATE INDEX IF NOT EXISTS idx_external_analysis_cache_source ON external_analysis_cache(source_kind, source_id);
    CREATE INDEX IF NOT EXISTS idx_external_analysis_cache_file ON external_analysis_cache(file_path);
    CREATE INDEX IF NOT EXISTS idx_external_analysis_cache_seen ON external_analysis_cache(last_seen_at_ms);
  `)
  if (userVersion < 25 && hasTable(instance, 'mixtape_raw_waveform_cache')) {
    instance.transaction(() => {
      const columns = listTableColumns(instance, 'mixtape_raw_waveform_cache')
      if (!columns.has('rms_left')) {
        instance.exec('ALTER TABLE mixtape_raw_waveform_cache ADD COLUMN rms_left BLOB;')
      }
      if (!columns.has('rms_right')) {
        instance.exec('ALTER TABLE mixtape_raw_waveform_cache ADD COLUMN rms_right BLOB;')
      }
    })()
  }
  if (userVersion < 26 && hasTable(instance, 'mixtape_raw_waveform_cache')) {
    const columns = listTableColumns(instance, 'mixtape_raw_waveform_cache')
    if (!columns.has('mean_left')) {
      instance.exec('ALTER TABLE mixtape_raw_waveform_cache ADD COLUMN mean_left BLOB;')
    }
    if (!columns.has('mean_right')) {
      instance.exec('ALTER TABLE mixtape_raw_waveform_cache ADD COLUMN mean_right BLOB;')
    }
  }
  if (userVersion < 27) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS compact_visual_waveform_cache (
        list_root TEXT NOT NULL,
        file_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        cache_version INTEGER NOT NULL,
        parameter_version INTEGER NOT NULL,
        duration REAL NOT NULL,
        detail_rate INTEGER NOT NULL,
        overview_rate INTEGER NOT NULL,
        frame_count INTEGER NOT NULL,
        payload BLOB NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (list_root, file_path)
      );
      CREATE INDEX IF NOT EXISTS idx_compact_visual_waveform_cache_root
        ON compact_visual_waveform_cache(list_root);
    `)
  }
  if (userVersion < 29) {
    instance.transaction(() => {
      instance.exec(`
        DROP TABLE IF EXISTS compact_visual_waveform_cache_chunks;
        DROP TABLE IF EXISTS compact_visual_waveform_cache_v29;
        CREATE TABLE IF NOT EXISTS compact_visual_waveform_cache (
          list_root TEXT NOT NULL,
          file_path TEXT NOT NULL,
          size INTEGER NOT NULL,
          mtime_ms REAL NOT NULL,
          cache_version INTEGER NOT NULL,
          parameter_version INTEGER NOT NULL,
          duration REAL NOT NULL,
          detail_rate INTEGER NOT NULL,
          overview_rate INTEGER NOT NULL,
          frame_count INTEGER NOT NULL,
          payload BLOB NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (list_root, file_path)
        );
        CREATE TABLE compact_visual_waveform_cache_v29 (
          list_root TEXT NOT NULL,
          file_path TEXT NOT NULL,
          size INTEGER NOT NULL,
          mtime_ms REAL NOT NULL,
          cache_version INTEGER NOT NULL,
          parameter_version INTEGER NOT NULL,
          duration REAL NOT NULL,
          detail_rate INTEGER NOT NULL,
          overview_rate INTEGER NOT NULL,
          frame_count INTEGER NOT NULL,
          payload BLOB NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (list_root, file_path)
        );
        INSERT OR REPLACE INTO compact_visual_waveform_cache_v29 (
          list_root, file_path, size, mtime_ms, cache_version, parameter_version, duration,
          detail_rate, overview_rate, frame_count, payload, updated_at_ms
        )
        SELECT
          list_root, file_path, size, mtime_ms, cache_version, parameter_version, duration,
          detail_rate, overview_rate, frame_count, payload, updated_at_ms
        FROM compact_visual_waveform_cache;
        DROP TABLE compact_visual_waveform_cache;
        ALTER TABLE compact_visual_waveform_cache_v29 RENAME TO compact_visual_waveform_cache;
      `)
    })()
  }
  instance.exec(`
    CREATE TABLE IF NOT EXISTS compact_visual_waveform_cache (
      list_root TEXT NOT NULL,
      file_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      cache_version INTEGER NOT NULL,
      parameter_version INTEGER NOT NULL,
      duration REAL NOT NULL,
      detail_rate INTEGER NOT NULL,
      overview_rate INTEGER NOT NULL,
      frame_count INTEGER NOT NULL,
      payload BLOB NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (list_root, file_path)
    );
    CREATE INDEX IF NOT EXISTS idx_compact_visual_waveform_cache_root
      ON compact_visual_waveform_cache(list_root);
  `)
  if (userVersion < 30) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS unified_display_waveform_cache (
        list_root TEXT NOT NULL,
        file_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        cache_version INTEGER NOT NULL,
        parameter_version INTEGER NOT NULL,
        duration REAL NOT NULL,
        detail_rate INTEGER NOT NULL,
        overview_rate INTEGER NOT NULL,
        frame_count INTEGER NOT NULL,
        payload BLOB NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (list_root, file_path)
      );
      CREATE INDEX IF NOT EXISTS idx_unified_display_waveform_cache_root
        ON unified_display_waveform_cache(list_root);
    `)
  }
  instance.exec(`
    CREATE TABLE IF NOT EXISTS unified_display_waveform_cache (
      list_root TEXT NOT NULL,
      file_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      cache_version INTEGER NOT NULL,
      parameter_version INTEGER NOT NULL,
      duration REAL NOT NULL,
      detail_rate INTEGER NOT NULL,
      overview_rate INTEGER NOT NULL,
      frame_count INTEGER NOT NULL,
      payload BLOB NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (list_root, file_path)
    );
    CREATE INDEX IF NOT EXISTS idx_unified_display_waveform_cache_root
      ON unified_display_waveform_cache(list_root);
  `)
  if (userVersion < 31) {
    instance.exec(`
      DELETE FROM waveform_cache;
      DELETE FROM compact_visual_waveform_cache;
    `)
  }
  if (userVersion < 32) {
    instance.exec(`
      DROP TABLE IF EXISTS mixtape_waveform_hires_cache;
    `)
  }
  if (userVersion < 33) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS waveform_surface_cache (
        list_root TEXT NOT NULL,
        file_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        cache_version INTEGER NOT NULL,
        list_preview_parameter_version INTEGER NOT NULL,
        global_overview_parameter_version INTEGER NOT NULL,
        duration REAL NOT NULL,
        sample_rate INTEGER NOT NULL,
        list_preview_frame_count INTEGER NOT NULL,
        global_overview_frame_count INTEGER NOT NULL,
        list_preview_payload BLOB NOT NULL,
        global_overview_payload BLOB NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (list_root, file_path)
      );
      CREATE INDEX IF NOT EXISTS idx_waveform_surface_cache_root
      ON waveform_surface_cache(list_root);
    `)
  }
  if (userVersion < 34) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS set_items (
        id TEXT PRIMARY KEY,
        playlist_uuid TEXT NOT NULL,
        file_path TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        origin_playlist_uuid TEXT,
        origin_path_snapshot TEXT,
        analysis_json TEXT,
        created_at_ms INTEGER NOT NULL,
        FOREIGN KEY (playlist_uuid) REFERENCES library_nodes(uuid) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_set_items_playlist ON set_items(playlist_uuid);
      CREATE INDEX IF NOT EXISTS idx_set_items_order ON set_items(playlist_uuid, sort_order);
    `)
  }
  instance.exec(`
    CREATE TABLE IF NOT EXISTS set_items (
      id TEXT PRIMARY KEY,
      playlist_uuid TEXT NOT NULL,
      file_path TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      origin_playlist_uuid TEXT,
      origin_path_snapshot TEXT,
      analysis_json TEXT,
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY (playlist_uuid) REFERENCES library_nodes(uuid) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_set_items_playlist ON set_items(playlist_uuid);
    CREATE INDEX IF NOT EXISTS idx_set_items_order ON set_items(playlist_uuid, sort_order);
  `)
  if (userVersion < 35) {
    const setItemColumns = listTableColumns(instance, 'set_items')
    if (!setItemColumns.has('analysis_json')) {
      try {
        instance.exec(`ALTER TABLE set_items ADD COLUMN analysis_json TEXT`)
      } catch {}
    }
  }
  instance.exec(`
    CREATE TABLE IF NOT EXISTS waveform_surface_cache (
      list_root TEXT NOT NULL,
      file_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      cache_version INTEGER NOT NULL,
      list_preview_parameter_version INTEGER NOT NULL,
      global_overview_parameter_version INTEGER NOT NULL,
      duration REAL NOT NULL,
      sample_rate INTEGER NOT NULL,
      list_preview_frame_count INTEGER NOT NULL,
      global_overview_frame_count INTEGER NOT NULL,
      list_preview_payload BLOB NOT NULL,
      global_overview_payload BLOB NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (list_root, file_path)
    );
    CREATE INDEX IF NOT EXISTS idx_waveform_surface_cache_root
      ON waveform_surface_cache(list_root);
  `)
  if (userVersion < SCHEMA_VERSION) {
    instance.pragma('user_version = ' + SCHEMA_VERSION)
  }
  try {
    assertLibraryMergeParticipantCoverage(instance)
    if (isConfiguredDevDatabase(path.dirname(dbPath))) {
      assertStoredMetadataContracts(instance)
    }
  } catch (error) {
    try {
      instance.close()
    } catch {}
    throw error
  }
  return instance
}

export function getLibraryDbPath(dirPath: string): string {
  return path.join(dirPath, DB_FILE_NAME)
}

// 用于不会成为当前活动库的隔离数据库副本。它复用正式 schema 迁移，但不会读写
// store、切换全局连接或影响正在使用的库。
export function migrateStandaloneLibraryDb(dbPath: string): void {
  const normalizedPath = String(dbPath || '').trim()
  if (!normalizedPath) throw new Error('数据库快照路径不能为空')
  const instance = createDatabase(normalizedPath)
  try {
    instance.pragma('wal_checkpoint(TRUNCATE)')
  } finally {
    instance.close()
  }
}

export function initLibraryDb(dirPath: string): SqliteDatabase | null {
  if (!dirPath) return null
  // 打开既有库不能产生任何文件。启动时设置里可能仍保留一个已被手动删除的库路径；
  // 若在这里补建根目录或 SQLite，后续启动检查就会把丢失的库误判为可修复的空库。
  const libraryDirPath = path.join(dirPath, 'library')
  if (!fs.pathExistsSync(dirPath) || !fs.pathExistsSync(libraryDirPath)) return null
  if (db && dbRoot === dirPath) return db
  try {
    closeLibraryDb()
    db = createDatabase(getLibraryDbPath(dirPath))
    dbRoot = dirPath
    return db
  } catch (error) {
    db = null
    dbRoot = dirPath
    log.error('[sqlite] init failed', error)
    if (
      isDatabaseSchemaVersionError(error) ||
      isDatabaseSchemaMigrationRequiredError(error) ||
      (isConfiguredDevDatabase(dirPath) &&
        (error instanceof LibraryMergeParticipantContractError ||
          error instanceof LibraryMetadataContractError))
    ) {
      throw error
    }
    return null
  }
}

// 注意：初始化失败后，每次调用都会重试（包括完整的迁移流程）。
// 这是故意的设计：用户修复问题后能立即恢复，无需等待重试间隔。
export function getLibraryDb(): SqliteDatabase | null {
  const dir = store.databaseDir || store.settingConfig?.databaseUrl || ''
  if (!dir) return null
  return initLibraryDb(dir)
}

export function closeLibraryDb(): void {
  if (db) {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)')
    } catch {}
    try {
      db.close()
    } catch {}
  }
  db = null
  dbRoot = null
}

export function getMetaValue(dbInstance: SqliteDatabase, key: string): string | null {
  try {
    const row = dbInstance
      .prepare<{ value?: string }>('SELECT value FROM meta WHERE key = ?')
      .get(key)
    return row ? String(row.value) : null
  } catch {
    return null
  }
}

export function setMetaValue(dbInstance: SqliteDatabase, key: string, value: string): void {
  const normalizedKey = String(key || '').trim()
  try {
    assertRegisteredLibraryMetadataKey(normalizedKey)
  } catch (error) {
    log.error('[sqlite] unregistered metadata key', error)
    throw error
  }
  try {
    dbInstance
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(normalizedKey, value)
  } catch {}
}
