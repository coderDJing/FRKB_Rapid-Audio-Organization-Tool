import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createSongBeatGridMapV2FromClips } from '../../shared/songBeatGridMapV2'
import { readSongSearchPage } from './songSearchPageRead'
import { collectSongSearchTerms } from './songSearchProjection'

describe('collectSongSearchTerms', () => {
  it('把文件路径放进候选全文，目录名也能被搜到', () => {
    const terms = collectSongSearchTerms({
      title: 'Obia',
      artist: 'Ken Ishii',
      album: '',
      genre: '',
      label: '',
      fileName: 'Obia.mp3',
      fileFormat: 'MP3',
      container: 'MP3',
      duration: '',
      bitrate: '',
      keyText: '',
      bpm: null,
      libraryName: 'CuratedLibrary',
      songListUUID: 'list',
      songListName: 'techno',
      songListPath: 'techno',
      filePath: 'E:/FRKB_database/library/CuratedLibrary/techno严肃/Obia.mp3',
      extendedText: ''
    })
    expect(terms).toContain('E:/FRKB_database/library/CuratedLibrary/techno严肃/Obia.mp3')
  })
})

describe('readSongSearchPage', () => {
  it('分页读取搜索字段，并从节拍网格取出 BPM', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE song_cache (
      list_root TEXT, file_path TEXT, size INTEGER, mtime_ms INTEGER, info_json TEXT
    )`)
    const beatGridMap = createSongBeatGridMapV2FromClips(
      [
        { startSec: 0, anchorSec: 0.125, bpm: 128, downbeatBeatOffset: 0 },
        { startSec: 32, anchorSec: 32.25, bpm: 130, downbeatBeatOffset: 0 }
      ],
      'analysis'
    )
    const insert = db.prepare(
      'INSERT INTO song_cache (list_root, file_path, size, mtime_ms, info_json) VALUES (?, ?, ?, ?, ?)'
    )
    insert.run(
      'library/list',
      'track.mp3',
      1,
      1,
      JSON.stringify({
        title: 'Obia',
        artist: 'Ken Ishii',
        key: 'Am',
        comment: 'night drive',
        beatGridMap,
        bpm: 99
      })
    )
    insert.run('library/list', 'second.mp3', 1, 1, '{"title":"Next"}')
    insert.run('library/list', 'third.mp3', 1, 1, '{"title":"Later"}')

    const firstPage = readSongSearchPage(db, 0, 2)
    expect(firstPage).toHaveLength(2)
    expect(firstPage[0]).toMatchObject({
      listRoot: 'library/list',
      filePathColumn: 'track.mp3',
      title: 'Obia',
      artist: 'Ken Ishii',
      keyText: 'Am',
      bpm: 128,
      extendedText: 'night drive'
    })
    expect(firstPage[0].bpm).not.toBe(99)

    const secondPage = readSongSearchPage(db, firstPage[1].rowId, 2)
    expect(secondPage.map((row) => row.title)).toEqual(['Later'])
    db.close()
  })

  it('损坏的 JSON 仍推进 rowid，并保留文件名', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE song_cache (
      list_root TEXT, file_path TEXT, size INTEGER, mtime_ms INTEGER, info_json TEXT
    )`)
    db.prepare(
      'INSERT INTO song_cache (list_root, file_path, size, mtime_ms, info_json) VALUES (?, ?, ?, ?, ?)'
    ).run('library/list', 'broken.mp3', 1, 1, '{')
    const page = readSongSearchPage(db, 0, 10)
    expect(page).toHaveLength(1)
    expect(page[0].fileName).toBe('broken.mp3')
    expect(page[0].title).toBe('broken.mp3')
    expect(page[0].bpm).toBeNull()
    expect(page[0].rowId).toBeGreaterThan(0)
    db.close()
  })
})
