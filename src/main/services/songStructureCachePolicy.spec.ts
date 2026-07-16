import { describe, expect, it } from 'vitest'
import {
  CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION,
  type SongStructureAnalysis
} from '../../shared/songStructure'
import { createSongBeatGridMapV2FromFixedGrid } from '../../shared/songBeatGridMapV2'
import {
  discardIncompatibleSongStructure,
  preserveBestAvailableSongStructure
} from './songStructureCachePolicy'

const GRID = createSongBeatGridMapV2FromFixedGrid({
  bpm: 128,
  firstBeatMs: 100,
  downbeatBeatOffset: 0,
  source: 'analysis'
})!

const createStructure = (beatGridSignature = GRID.signature): SongStructureAnalysis => ({
  formatVersion: 2,
  algorithmVersion: CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION,
  source: 'algorithmic',
  durationSec: 60,
  beatGridSignature,
  sections: [
    {
      startSec: 0,
      endSec: 60,
      startDownbeatOrdinal: 0,
      endDownbeatOrdinal: 32,
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
  it('keeps a structure result bound to the current v2 grid', () => {
    const info = { beatGridMap: GRID, songStructure: createStructure() }

    discardIncompatibleSongStructure(info)

    expect(info.songStructure).toBeDefined()
  })

  it('drops a result when the current grid signature changes', () => {
    const changedGrid = createSongBeatGridMapV2FromFixedGrid({
      bpm: 128,
      firstBeatMs: 125,
      downbeatBeatOffset: 0,
      source: 'analysis'
    })!
    const info = { beatGridMap: changedGrid, songStructure: createStructure() }

    discardIncompatibleSongStructure(info)

    expect(info.songStructure).toBeUndefined()
  })

  it('restores a cached v23 result when the scanned target has the same grid', () => {
    const target = {
      beatGridMap: GRID,
      songStructure: undefined as SongStructureAnalysis | undefined
    }
    const cached = { beatGridMap: GRID, songStructure: createStructure() }

    preserveBestAvailableSongStructure(target, cached)

    expect(target.songStructure).toEqual(cached.songStructure)
  })

  it('does not restore a cached result onto a different grid', () => {
    const changedGrid = createSongBeatGridMapV2FromFixedGrid({
      bpm: 128,
      firstBeatMs: 125,
      downbeatBeatOffset: 0,
      source: 'analysis'
    })!
    const target = {
      beatGridMap: changedGrid,
      songStructure: undefined as SongStructureAnalysis | undefined
    }
    const cached = { beatGridMap: GRID, songStructure: createStructure() }

    preserveBestAvailableSongStructure(target, cached)

    expect(target.songStructure).toBeUndefined()
  })
})
