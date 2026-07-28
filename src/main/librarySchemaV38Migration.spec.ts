import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  migrateLibrarySchemaV38ToV39,
  REKORDBOX_EXTERNAL_CACHE_CLEANUP_SCHEMA_VERSION
} from './librarySchemaV38Migration'

const temporaryDirectories: string[] = []

const createV38Database = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-schema-v38-'))
  temporaryDirectories.push(directory)
  const databasePath = path.join(directory, 'FRKB.database.sqlite')
  const Database = require('better-sqlite3') as typeof import('better-sqlite3')
  const db = new Database(databasePath)
  try {
    db.exec(`
      PRAGMA user_version = 38;
      CREATE TABLE external_analysis_cache (source_kind TEXT NOT NULL, source_id TEXT NOT NULL);
      CREATE TABLE external_analysis_devices (source_kind TEXT NOT NULL, source_id TEXT NOT NULL);
      CREATE TABLE pioneer_preview_waveform_cache (source_path TEXT NOT NULL);
    `)
    const insertExternalCache = db.prepare(
      'INSERT INTO external_analysis_cache (source_kind, source_id) VALUES (?, ?)'
    )
    insertExternalCache.run('rekordbox-usb', 'usb-1')
    insertExternalCache.run('rekordbox-desktop', 'desktop-1')
    insertExternalCache.run('external-playback', 'local')
    const insertExternalDevice = db.prepare(
      'INSERT INTO external_analysis_devices (source_kind, source_id) VALUES (?, ?)'
    )
    insertExternalDevice.run('rekordbox-usb', 'usb-1')
    insertExternalDevice.run('external-playback', 'local')
    db.prepare('INSERT INTO pioneer_preview_waveform_cache (source_path) VALUES (?)').run('a')
    db.prepare('INSERT INTO pioneer_preview_waveform_cache (source_path) VALUES (?)').run('b')
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

describe('v38 to v39 Rekordbox external cache cleanup', () => {
  it('removes only Rekordbox-derived caches, verifies the deletion, and retains external playback', async () => {
    const databasePath = await createV38Database()
    const backupPath = `${databasePath}.migration-backup`

    const result = await migrateLibrarySchemaV38ToV39(databasePath, { backupPath })

    expect(result).toMatchObject({
      migrated: true,
      databaseVersion: REKORDBOX_EXTERNAL_CACHE_CLEANUP_SCHEMA_VERSION,
      removedExternalAnalysisRows: 2,
      removedExternalDeviceRows: 1,
      removedPreviewWaveformRows: 2
    })

    const Database = require('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(databasePath, { readonly: true, fileMustExist: true })
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(
        REKORDBOX_EXTERNAL_CACHE_CLEANUP_SCHEMA_VERSION
      )
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM external_analysis_cache WHERE source_kind IN ('rekordbox-usb', 'rekordbox-desktop')"
          )
          .get()
      ).toEqual({ count: 0 })
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM external_analysis_cache WHERE source_kind = 'external-playback'"
          )
          .get()
      ).toEqual({ count: 1 })
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM external_analysis_devices WHERE source_kind IN ('rekordbox-usb', 'rekordbox-desktop')"
          )
          .get()
      ).toEqual({ count: 0 })
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM pioneer_preview_waveform_cache').get()
      ).toEqual({
        count: 0
      })
    } finally {
      db.close()
    }
    await expect(fs.stat(backupPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('safely replaces a verified backup left by an interrupted pre-commit migration', async () => {
    const databasePath = await createV38Database()
    const backupPath = `${databasePath}.interrupted-backup`
    const Database = require('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(databasePath, { fileMustExist: true })
    const backupDb = db as typeof db & { backup: (targetPath: string) => Promise<unknown> }
    try {
      await backupDb.backup(backupPath)
    } finally {
      db.close()
    }

    const result = await migrateLibrarySchemaV38ToV39(databasePath, { backupPath })

    expect(result).toMatchObject({
      migrated: true,
      databaseVersion: REKORDBOX_EXTERNAL_CACHE_CLEANUP_SCHEMA_VERSION,
      recoveredInterruptedBackup: true
    })
    await expect(fs.stat(backupPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('discards only incomplete backup artifacts before recreating a verified backup from the V38 main database', async () => {
    const databasePath = await createV38Database()
    const backupPath = `${databasePath}.incomplete-backup`
    await fs.writeFile(backupPath, '')
    await fs.writeFile(`${backupPath}.recovery-next`, 'not a sqlite database')
    await fs.writeFile(`${backupPath}.recovery-next-journal`, 'interrupted')

    const result = await migrateLibrarySchemaV38ToV39(databasePath, { backupPath })

    expect(result).toMatchObject({
      migrated: true,
      databaseVersion: REKORDBOX_EXTERNAL_CACHE_CLEANUP_SCHEMA_VERSION,
      recoveredInterruptedBackup: true,
      discardedInvalidBackupArtifacts: true
    })
    await expect(fs.stat(backupPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(`${backupPath}.recovery-next`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(`${backupPath}.recovery-next-journal`)).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})
