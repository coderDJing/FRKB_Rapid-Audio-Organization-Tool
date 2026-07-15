import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { migrateSongBeatGridMapV2Database } from './songBeatGridMapV2DatabaseMigration'

const temporaryDirectories: string[] = []

const createDatabase = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frkb-grid-v2-migration-'))
  temporaryDirectories.push(directory)
  const Database = require('better-sqlite3') as typeof import('better-sqlite3')
  const db = new Database(path.join(directory, 'library.sqlite'))
  db.exec(`
    CREATE TABLE song_cache (info_json TEXT NOT NULL);
    CREATE TABLE external_analysis_cache (info_json TEXT NOT NULL);
    CREATE TABLE mixtape_items (info_json TEXT);
    CREATE TABLE set_items (analysis_json TEXT);
  `)
  return db
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('SongBeatGridMap v2 SQLite migration', () => {
  it('converts canonical rows and removes project grid copies in one transaction', async () => {
    const db = await createDatabase()
    try {
      db.prepare('INSERT INTO song_cache (info_json) VALUES (?)').run(
        JSON.stringify({
          bpm: 128,
          firstBeatMs: 125,
          barBeatOffset: 6,
          beatGridSource: 'analysis',
          key: '8A',
          songStructure: { keep: true }
        })
      )
      db.prepare('INSERT INTO external_analysis_cache (info_json) VALUES (?)').run(
        JSON.stringify({ bpm: 126, firstBeatMs: 0, barBeatOffset: 'bad', key: '1A' })
      )
      db.prepare('INSERT INTO mixtape_items (info_json) VALUES (?)').run(
        JSON.stringify({
          bpm: 128,
          barBeatOffset: 0,
          beatGridMap: { version: 1 },
          originalBpm: 126
        })
      )
      db.prepare('INSERT INTO set_items (analysis_json) VALUES (?)').run(
        JSON.stringify({ bpm: 128, firstBeatMs: 125, barBeatOffset: 0, key: '8A' })
      )

      const progress: Array<{ processedRows: number; totalRows: number }> = []
      expect(
        migrateSongBeatGridMapV2Database(db, {
          onProgress: (value) => progress.push(value)
        })
      ).toEqual({
        canonicalMigrated: 1,
        canonicalInvalidGrid: 1,
        canonicalWithoutGrid: 0,
        mixtapeGridCopiesRemoved: 1,
        setGridCopiesRemoved: 1
      })
      expect(progress).toEqual([
        { processedRows: 0, totalRows: 4 },
        { processedRows: 4, totalRows: 4 }
      ])

      const canonical = JSON.parse(
        (db.prepare('SELECT info_json FROM song_cache').get() as { info_json: string }).info_json
      )
      expect(canonical).toMatchObject({
        key: '8A',
        songStructure: { keep: true },
        beatGridMap: {
          version: 2,
          source: 'analysis',
          clips: [{ downbeatBeatOffset: 2 }]
        }
      })
      expect(canonical).not.toHaveProperty('barBeatOffset')

      const invalid = JSON.parse(
        (db.prepare('SELECT info_json FROM external_analysis_cache').get() as { info_json: string })
          .info_json
      )
      expect(invalid).toEqual({ key: '1A' })

      const mixtape = JSON.parse(
        (db.prepare('SELECT info_json FROM mixtape_items').get() as { info_json: string }).info_json
      )
      expect(mixtape).toEqual({ originalBpm: 126 })
      const set = JSON.parse(
        (db.prepare('SELECT analysis_json FROM set_items').get() as { analysis_json: string })
          .analysis_json
      )
      expect(set).toEqual({ key: '8A' })
    } finally {
      db.close()
    }
  })
})
