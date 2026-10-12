import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { readSongCacheTrackFieldRows } from './songCacheRead'

describe('readSongCacheTrackFieldRows', () => {
  it('只取出曲序和加入时间', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE song_cache (
      list_root TEXT, file_path TEXT, size INTEGER, mtime_ms INTEGER, info_json TEXT
    )`)
    db.prepare(
      'INSERT INTO song_cache (list_root, file_path, size, mtime_ms, info_json) VALUES (?, ?, ?, ?, ?)'
    ).run(
      'library/list',
      'a.mp3',
      1,
      1,
      JSON.stringify({
        playlistTrackNumber: 4,
        addedAtMs: 1234,
        title: 'not needed',
        beatGridMap: { version: 2, clips: [] }
      })
    )
    db.prepare(
      'INSERT INTO song_cache (list_root, file_path, size, mtime_ms, info_json) VALUES (?, ?, ?, ?, ?)'
    ).run('library/other', 'b.mp3', 1, 1, '{"playlistTrackNumber":1}')

    const [rows, missing] = readSongCacheTrackFieldRows(db, ['library/list', 'missing'])
    expect(missing).toEqual([])
    expect(rows).toEqual([{ file_path: 'a.mp3', track_number: 4, added_at_ms: 1234 }])
    db.close()
  })
})
