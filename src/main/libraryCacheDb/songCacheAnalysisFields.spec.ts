import { describe, expect, it } from 'vitest'
import type { ISongInfo } from '../../types/globals'
import { normalizeSongCacheInfoForStorage, stripSongCoreAnalysisFields } from './songCache'
import { createSongBeatGridMapV2FromFixedGrid } from '../../shared/songBeatGridMapV2'

const createSongInfo = (): ISongInfo => {
  const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
    bpm: 132,
    firstBeatMs: 120,
    downbeatBeatOffset: 0,
    source: 'manual'
  })
  if (!beatGridMap) throw new Error('v2 grid fixture failed')
  return {
    filePath: 'D:/music/test.mp3',
    fileName: 'test.mp3',
    fileFormat: 'MP3',
    cover: null,
    title: 'Test',
    artist: 'Artist',
    album: 'Album',
    duration: '06:00',
    genre: 'Techno',
    label: 'Label',
    bitrate: 320000,
    container: 'MPEG',
    key: '8A',
    keyAnalysisAlgorithmVersion: 3,
    bpm: 132,
    firstBeatMs: 120,
    beatGridSource: 'manual',
    beatGridMap,
    beatGridAlgorithmVersion: 9,
    timeBasisOffsetMs: 25,
    energyScore: 74,
    energyAlgorithmVersion: 2,
    songStructure: {
      formatVersion: 1,
      algorithmVersion: 17,
      source: 'algorithmic',
      durationSec: 360,
      bpm: 132,
      firstBeatMs: 120,
      barBeatOffset: 4,
      beatGridSignature: 'manual-grid',
      phraseBars: 4,
      sections: []
    },
    playlistTrackNumber: 7,
    hotCues: [{ slot: 1, sec: 32 }],
    memoryCues: [{ sec: 64, order: 1 }],
    mixOrder: 5
  }
}

describe('stripSongCoreAnalysisFields', () => {
  it('只清核心五项并保留用户数据与元数据', () => {
    const source = createSongInfo()
    const result = stripSongCoreAnalysisFields(source)

    expect(result).not.toHaveProperty('key')
    expect(result).not.toHaveProperty('bpm')
    expect(result).not.toHaveProperty('downbeatBeatOffset')
    expect(result).not.toHaveProperty('beatGridMap')
    expect(result).not.toHaveProperty('energyScore')
    expect(result).not.toHaveProperty('songStructure')

    expect(result).toMatchObject({
      filePath: source.filePath,
      title: 'Test',
      artist: 'Artist',
      album: 'Album',
      genre: 'Techno',
      label: 'Label',
      playlistTrackNumber: 7,
      hotCues: [{ slot: 1, sec: 32 }],
      memoryCues: [{ sec: 64, order: 1 }],
      mixOrder: 5
    })
    expect(source.beatGridMap).toBeDefined()
  })
})

describe('normalizeSongCacheInfoForStorage', () => {
  it('does not let runtime projections recreate root grid fields beside a v2 map', () => {
    const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
      bpm: 132,
      firstBeatMs: 120,
      downbeatBeatOffset: 0,
      source: 'manual'
    })
    const legacyProjection: ISongInfo & { barBeatOffset: number } = {
      ...createSongInfo(),
      bpm: 132,
      firstBeatMs: 120,
      downbeatBeatOffset: 0,
      barBeatOffset: 4,
      beatGridSource: 'manual',
      beatGridMap: beatGridMap ?? undefined
    }
    const result = normalizeSongCacheInfoForStorage(legacyProjection, 'D:/music/test.mp3')

    expect(result.beatGridMap).toEqual(beatGridMap)
    expect(result).not.toHaveProperty('bpm')
    expect(result).not.toHaveProperty('firstBeatMs')
    expect(result).not.toHaveProperty('downbeatBeatOffset')
    expect(result).not.toHaveProperty('barBeatOffset')
    expect(result).not.toHaveProperty('beatGridSource')
  })
})
