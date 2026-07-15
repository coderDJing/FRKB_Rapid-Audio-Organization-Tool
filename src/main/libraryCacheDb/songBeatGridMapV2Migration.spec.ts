import { describe, expect, it } from 'vitest'
import { createSongBeatGridMapFromClips } from '../../shared/songBeatGridMap'
import { migrateSongInfoBeatGridMapV2 } from './songBeatGridMapV2Migration'

describe('SongBeatGridMap v35 to v36 migration adapter', () => {
  it('turns a fixed analysis grid into a single v2 clip without touching songStructure', () => {
    const result = migrateSongInfoBeatGridMapV2({
      bpm: 128,
      firstBeatMs: 125,
      barBeatOffset: 6,
      beatGridSource: 'analysis',
      beatGridStatus: 'ready',
      beatGridAlgorithmVersion: 9,
      songStructure: { algorithmVersion: 1 }
    })

    expect(result.outcome).toBe('migrated')
    expect(result.info).toMatchObject({
      beatGridMap: {
        version: 2,
        source: 'analysis',
        clips: [{ startSec: 0, anchorSec: 0.125, bpm: 128, downbeatBeatOffset: 2 }]
      },
      songStructure: { algorithmVersion: 1 }
    })
    expect(result.info).not.toHaveProperty('bpm')
    expect(result.info).not.toHaveProperty('barBeatOffset')
    expect(result.info).not.toHaveProperty('beatGridSource')
  })

  it('keeps manually edited dynamic grids manual while reducing the offset to four beats', () => {
    const map = createSongBeatGridMapFromClips(
      [
        { startSec: 0, anchorSec: 0, bpm: 128, barBeatOffset: 31 },
        { startSec: 16, anchorSec: 16.1, bpm: 130, barBeatOffset: 4 }
      ],
      { allowSingleClip: true }
    )
    const result = migrateSongInfoBeatGridMapV2({ beatGridSource: 'manual', beatGridMap: map })

    expect(result.outcome).toBe('migrated')
    expect(result.map).toMatchObject({
      source: 'manual',
      clips: [{ downbeatBeatOffset: 3 }, { downbeatBeatOffset: 0 }]
    })
  })

  it('fails closed for malformed legacy grid fields but preserves unrelated song data', () => {
    const result = migrateSongInfoBeatGridMapV2({
      bpm: 128,
      firstBeatMs: 0,
      barBeatOffset: 'bad',
      key: '8A',
      hotCues: [{ time: 1 }]
    })

    expect(result).toMatchObject({
      outcome: 'invalid-grid',
      info: { key: '8A', hotCues: [{ time: 1 }] }
    })
    expect(result.info).not.toHaveProperty('bpm')
    expect(result.info).not.toHaveProperty('beatGridMap')
  })

  it('does not rewrite songs without grid data', () => {
    const result = migrateSongInfoBeatGridMapV2({ key: '1A', energyScore: 0.7 })

    expect(result).toEqual({
      outcome: 'no-grid',
      info: { key: '1A', energyScore: 0.7 }
    })
  })
})
