import { describe, expect, it } from 'vitest'
import { createSongBeatGridMapFromClips } from './songBeatGridMap'
import { CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION } from './songStructure'
import {
  hasRequiredSongStructureAnalysis,
  hasUsableCoreSongAnalysis,
  hasUsableKeyAnalysis,
  resolveUsableSongBeatGrid
} from './songAnalysisCompleteness'

const GRID = { bpm: 128, firstBeatMs: 125, barBeatOffset: 0 }

const createStructure = (algorithmVersion: number) => ({
  formatVersion: 1,
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

describe('song analysis completeness', () => {
  it('treats a valid key and energy score as usable without algorithm versions', () => {
    expect(hasUsableKeyAnalysis({ key: '8A' })).toBe(true)
    expect(
      hasUsableCoreSongAnalysis(
        {
          key: '8A',
          energyScore: 72,
          ...GRID
        },
        { waveformAvailable: true }
      )
    ).toBe(true)
  })

  it('accepts a valid dynamic grid without a Beat Grid algorithm version', () => {
    const beatGridMap = createSongBeatGridMapFromClips([
      { startSec: 0, anchorSec: 0.125, bpm: 128, barBeatOffset: 0 },
      { startSec: 32, anchorSec: 32.25, bpm: 130, barBeatOffset: 0 }
    ])
    expect(beatGridMap).not.toBeNull()
    expect(resolveUsableSongBeatGrid({ beatGridMap })).toMatchObject({
      kind: 'dynamic',
      bpm: 128,
      firstBeatMs: 125,
      barBeatOffset: 0
    })
  })

  it('prefers a usable grid over a stray no-bpm marker', () => {
    expect(resolveUsableSongBeatGrid({ ...GRID, beatGridStatus: 'no-bpm' }).kind).toBe('fixed')
  })

  it('treats no-bpm as a completed grid and does not require structure', () => {
    const info = { key: '8A', energyScore: 50, beatGridStatus: 'no-bpm' }
    expect(resolveUsableSongBeatGrid(info).kind).toBe('no-bpm')
    expect(hasRequiredSongStructureAnalysis(info)).toBe(true)
    expect(
      hasUsableCoreSongAnalysis(info, { includeStructure: true, waveformAvailable: true })
    ).toBe(true)
  })

  it('keeps a same-grid structure usable regardless of its algorithm version', () => {
    const info = {
      key: '8A',
      energyScore: 72,
      ...GRID,
      songStructure: createStructure(CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION - 1)
    }
    expect(hasRequiredSongStructureAnalysis(info)).toBe(true)
    expect(
      hasUsableCoreSongAnalysis(info, { includeStructure: true, waveformAvailable: true })
    ).toBe(true)
  })

  it('requires structure replacement when its grid dependency no longer matches', () => {
    const info = {
      key: '8A',
      energyScore: 72,
      ...GRID,
      firstBeatMs: GRID.firstBeatMs + 250,
      songStructure: createStructure(CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION - 1)
    }
    expect(hasRequiredSongStructureAnalysis(info)).toBe(false)
    expect(
      hasUsableCoreSongAnalysis(info, { includeStructure: true, waveformAvailable: true })
    ).toBe(false)
  })

  it('matches dynamic-grid structure by signature instead of algorithm version', () => {
    const beatGridMap = createSongBeatGridMapFromClips([
      { startSec: 0, anchorSec: 0.125, bpm: 128, barBeatOffset: 0 },
      { startSec: 32, anchorSec: 32.25, bpm: 130, barBeatOffset: 0 }
    ])
    expect(beatGridMap).not.toBeNull()
    const structure = {
      ...createStructure(CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION - 1),
      beatGridSignature: beatGridMap!.signature
    }
    expect(hasRequiredSongStructureAnalysis({ beatGridMap, songStructure: structure })).toBe(true)
    expect(
      hasRequiredSongStructureAnalysis({
        beatGridMap,
        songStructure: { ...structure, beatGridSignature: 'sbgm_changed' }
      })
    ).toBe(false)
  })

  it('still reports a genuinely missing result as incomplete', () => {
    expect(
      hasUsableCoreSongAnalysis(
        {
          key: '8A',
          ...GRID
        },
        { waveformAvailable: true }
      )
    ).toBe(false)
    expect(
      hasUsableCoreSongAnalysis(
        {
          key: '8A',
          energyScore: 72,
          ...GRID
        },
        { waveformAvailable: false }
      )
    ).toBe(false)
  })
})
