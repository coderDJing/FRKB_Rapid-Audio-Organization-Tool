import { describe, expect, it } from 'vitest'
import {
  CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION,
  CURRENT_SONG_STRUCTURE_FORMAT_VERSION,
  type SongStructureAnalysis
} from '../../shared/songStructure'
import {
  discardIncompatibleSongStructure,
  preserveBestAvailableSongStructure
} from './songStructureCachePolicy'

const GRID = { bpm: 128, firstBeatMs: 100, barBeatOffset: 0 }

const createStructure = (algorithmVersion: number, includeFormatVersion = true) => ({
  ...(includeFormatVersion ? { formatVersion: CURRENT_SONG_STRUCTURE_FORMAT_VERSION } : {}),
  algorithmVersion,
  source: 'algorithmic',
  durationSec: 60,
  ...GRID,
  phraseBars: 8,
  sections: [
    {
      startSec: 0,
      endSec: 60,
      startBar: 1,
      endBar: 32,
      phraseIndex: 0,
      kind: 'groove',
      confidence: 0.6,
      energy: 0.6,
      low: 0.6,
      high: 0.4,
      novelty: 0.2
    }
  ]
})

describe('songStructureCachePolicy', () => {
  it('keeps a same-grid stale algorithm result', () => {
    const info = {
      ...GRID,
      songStructure: createStructure(
        CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION - 1,
        false
      ) as unknown as SongStructureAnalysis
    }

    discardIncompatibleSongStructure(info)

    expect(info.songStructure).toBeDefined()
  })

  it('preserves a historical result after the grid changes', () => {
    const info = {
      ...GRID,
      firstBeatMs: GRID.firstBeatMs + 25,
      songStructure: createStructure(
        CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION - 1,
        false
      ) as unknown as SongStructureAnalysis
    }

    discardIncompatibleSongStructure(info)

    expect(info.songStructure).toBeDefined()
  })

  it('restores a usable stale result when the scanned target has none', () => {
    const target = { ...GRID, songStructure: undefined as SongStructureAnalysis | undefined }
    const cached = {
      ...GRID,
      songStructure: createStructure(
        CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION - 1,
        false
      ) as unknown as SongStructureAnalysis
    }

    preserveBestAvailableSongStructure(target, cached)

    expect(target.songStructure).toMatchObject({
      formatVersion: 1,
      algorithmVersion: CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION - 1
    })
  })

  it('does not replace an existing historical target result', () => {
    const target = {
      ...GRID,
      songStructure: createStructure(
        CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION - 1,
        false
      ) as unknown as SongStructureAnalysis
    }
    const cached = {
      ...GRID,
      songStructure: createStructure(
        CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION
      ) as unknown as SongStructureAnalysis
    }

    preserveBestAvailableSongStructure(target, cached)

    expect(target.songStructure.algorithmVersion).toBe(CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION - 1)
  })
})
