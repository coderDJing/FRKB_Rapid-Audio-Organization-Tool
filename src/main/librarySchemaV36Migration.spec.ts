import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  LibrarySchemaV36MigrationError,
  migrateLibrarySchemaV35ToV36,
  SONG_BEAT_GRID_V2_SCHEMA_VERSION
} from './librarySchemaV36Migration'

const temporaryDirectories: string[] = []

const createV35Database = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-schema-v36-'))
  temporaryDirectories.push(directory)
  const databasePath = path.join(directory, 'FRKB.database.sqlite')
  const Database = require('better-sqlite3') as typeof import('better-sqlite3')
  const db = new Database(databasePath)
  db.exec(`
    PRAGMA user_version = 35;
    CREATE TABLE song_cache (info_json TEXT NOT NULL);
    CREATE TABLE external_analysis_cache (info_json TEXT NOT NULL);
    CREATE TABLE mixtape_items (info_json TEXT);
    CREATE TABLE set_items (analysis_json TEXT);
  `)
  db.prepare('INSERT INTO song_cache (info_json) VALUES (?)').run(
    JSON.stringify({
      bpm: 128,
      firstBeatMs: 0,
      barBeatOffset: 5,
      beatGridSource: 'analysis',
      timeBasisOffsetMs: 50.114
    })
  )
  db.close()
  return databasePath
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('v35 to v36 library schema migration', () => {
  it('backs up, migrates, advances the schema, and removes the successful temporary backup', async () => {
    const databasePath = await createV35Database()
    const backupPath = `${databasePath}.backup`
    const phases: string[] = []

    const result = await migrateLibrarySchemaV35ToV36(databasePath, {
      backupPath,
      getAvailableBytes: async () => Number.MAX_SAFE_INTEGER,
      onProgress: (progress) => phases.push(progress.phase)
    })

    expect(result).toMatchObject({
      migrated: true,
      databaseVersion: SONG_BEAT_GRID_V2_SCHEMA_VERSION,
      report: { canonicalMigrated: 1 }
    })
    await expect(fs.access(backupPath)).rejects.toThrow()
    const phaseTransitions = phases.filter(
      (phase, index) => index === 0 || phases[index - 1] !== phase
    )
    expect(phaseTransitions).toEqual([
      'checking-version',
      'checking-space',
      'creating-backup',
      'converting',
      'validating',
      'complete'
    ])

    const Database = require('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(databasePath, { readonly: true, fileMustExist: true })
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(SONG_BEAT_GRID_V2_SCHEMA_VERSION)
      const info = JSON.parse(
        (db.prepare('SELECT info_json FROM song_cache').get() as { info_json: string }).info_json
      )
      expect(info.beatGridMap).toMatchObject({ version: 2, source: 'analysis' })
      expect(info.timeBasisOffsetMs).toBe(50.114)
    } finally {
      db.close()
    }
  })

  it('fails closed before backing up when disk capacity is insufficient', async () => {
    const databasePath = await createV35Database()
    const backupPath = `${databasePath}.backup`
    const phases: string[] = []

    await expect(
      migrateLibrarySchemaV35ToV36(databasePath, {
        backupPath,
        getAvailableBytes: async () => 0,
        onProgress: (progress) => phases.push(progress.phase)
      })
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_SPACE'
    } satisfies Partial<LibrarySchemaV36MigrationError>)
    await expect(fs.access(backupPath)).rejects.toThrow()
    expect(phases).toEqual(['checking-version', 'checking-space', 'failed'])
  })
})
