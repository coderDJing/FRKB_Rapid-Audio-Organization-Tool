import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  CURATED_LIBRARY_SYNC_SCHEMA_VERSION,
  migrateLibrarySchemaV39ToV40
} from './librarySchemaV40Migration'

const temporaryDirectories: string[] = []

const createV39Database = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-schema-v40-'))
  temporaryDirectories.push(directory)
  const databasePath = path.join(directory, 'FRKB.database.sqlite')
  const Database = require('better-sqlite3') as typeof import('better-sqlite3')
  const db = new Database(databasePath)
  try {
    db.exec(`
      PRAGMA user_version = 39;
      CREATE TABLE recycle_bin_records (
        file_path TEXT PRIMARY KEY,
        deleted_at_ms INTEGER NOT NULL,
        original_playlist_path TEXT,
        original_file_name TEXT,
        source_type TEXT
      );
    `)
  } finally {
    db.close()
  }
  return databasePath
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('v39 to v40 curated library sync schema', () => {
  it('creates curated_sync_files and adds recycle identity columns', async () => {
    const databasePath = await createV39Database()
    const result = await migrateLibrarySchemaV39ToV40(databasePath)
    expect(result).toMatchObject({
      migrated: true,
      databaseVersion: CURATED_LIBRARY_SYNC_SCHEMA_VERSION
    })

    const Database = require('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(databasePath, { readonly: true, fileMustExist: true })
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(CURATED_LIBRARY_SYNC_SCHEMA_VERSION)
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'curated_sync_files'"
        )
        .all() as Array<{ name: string }>
      expect(tables).toEqual([{ name: 'curated_sync_files' }])
      const columns = db.prepare('PRAGMA table_info(recycle_bin_records)').all() as Array<{
        name: string
      }>
      const names = new Set(columns.map((column) => column.name))
      expect(names.has('file_id')).toBe(true)
      expect(names.has('content_sha256')).toBe(true)
      expect(names.has('content_size')).toBe(true)
    } finally {
      db.close()
    }
  })

  it('is a no-op when the database is not v39', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-schema-v40-skip-'))
    temporaryDirectories.push(directory)
    const databasePath = path.join(directory, 'FRKB.database.sqlite')
    const Database = require('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(databasePath)
    db.pragma('user_version = 38')
    db.close()

    const result = await migrateLibrarySchemaV39ToV40(databasePath)
    expect(result).toMatchObject({ migrated: false, databaseVersion: 38 })
  })
})
