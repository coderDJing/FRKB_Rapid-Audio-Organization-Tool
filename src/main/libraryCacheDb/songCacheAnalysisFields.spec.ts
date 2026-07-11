import { describe, expect, it } from 'vitest'
import type { ISongInfo } from '../../types/globals'
import { stripSongCoreAnalysisFields } from './songCache'

const createSongInfo = (): ISongInfo => ({
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
  barBeatOffset: 4,
  beatGridSource: 'manual',
  beatGridMap: {
    version: 1,
    source: 'manual',
    clips: [{ startSec: 0, anchorSec: 0.12, bpm: 132, barBeatOffset: 4 }],
    signature: 'manual-grid'
  },
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
})

describe('stripSongCoreAnalysisFields', () => {
  it('只清核心五项并保留用户数据与元数据', () => {
    const source = createSongInfo()
    const result = stripSongCoreAnalysisFields(source)

    expect(result).not.toHaveProperty('key')
    expect(result).not.toHaveProperty('bpm')
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
