import { describe, expect, it } from 'vitest'
import { createSongBeatGridMapFromClips } from './songBeatGridMap'
import {
  CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION,
  CURRENT_SONG_STRUCTURE_FORMAT_VERSION,
  hasCurrentSongStructureAnalysis,
  hasUsableSongStructureAnalysis,
  normalizeSongStructureAnalysis
} from './songStructure'
import {
  resolveInitialPlaybackRangeStartSec,
  resolvePlaybackSectionRangeResolution
} from './playbackRange'

const GRID = { bpm: 128, firstBeatMs: 100, barBeatOffset: 0 }

const createLegacyStructure = () => ({
  algorithmVersion: CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION - 1,
  source: 'algorithmic',
  durationSec: 60,
  ...GRID,
  phraseBars: 8,
  sections: [
    {
      startSec: 0,
      endSec: 16,
      startBar: 1,
      endBar: 8,
      phraseIndex: 0,
      kind: 'intro',
      confidence: 0.7,
      energy: 0.4,
      low: 0.35,
      high: 0.3,
      novelty: 0.2
    },
    {
      startSec: 16,
      endSec: 48,
      startBar: 9,
      endBar: 24,
      phraseIndex: 1,
      kind: 'drop',
      confidence: 0.82,
      energy: 0.8,
      low: 0.86,
      high: 0.58,
      novelty: 0.72
    }
  ]
})

describe('song structure stale-while-revalidate policy', () => {
  it('keeps a legacy same-grid result usable while marking it non-current', () => {
    const legacyStructure = createLegacyStructure()
    const normalized = normalizeSongStructureAnalysis(legacyStructure)

    expect(normalized?.formatVersion).toBe(1)
    expect(hasUsableSongStructureAnalysis({ ...GRID, songStructure: legacyStructure })).toBe(true)
    expect(hasCurrentSongStructureAnalysis({ ...GRID, songStructure: legacyStructure })).toBe(false)
  })

  it('hard-invalidates a legacy result when the grid changes', () => {
    const legacyStructure = createLegacyStructure()

    expect(
      hasUsableSongStructureAnalysis({
        ...GRID,
        firstBeatMs: GRID.firstBeatMs + 25,
        songStructure: legacyStructure
      })
    ).toBe(false)
  })

  it('hard-invalidates an incompatible structure format', () => {
    const incompatible = {
      ...createLegacyStructure(),
      formatVersion: CURRENT_SONG_STRUCTURE_FORMAT_VERSION + 1
    }

    expect(normalizeSongStructureAnalysis(incompatible)).toBeUndefined()
    expect(hasUsableSongStructureAnalysis({ ...GRID, songStructure: incompatible })).toBe(false)
  })

  it('does not reuse a dynamic-grid result after switching grid identity', () => {
    const originalGrid = createSongBeatGridMapFromClips([
      { startSec: 0, anchorSec: 0, bpm: 128, barBeatOffset: 0 },
      { startSec: 32, anchorSec: 32, bpm: 128, barBeatOffset: 0 }
    ])
    const changedGrid = createSongBeatGridMapFromClips([
      { startSec: 0, anchorSec: 0, bpm: 128, barBeatOffset: 0 },
      { startSec: 32, anchorSec: 32.25, bpm: 128, barBeatOffset: 0 }
    ])
    expect(originalGrid).not.toBeNull()
    expect(changedGrid).not.toBeNull()
    if (!originalGrid || !changedGrid) throw new Error('dynamic grid fixture failed')
    const dynamicStructure = {
      ...createLegacyStructure(),
      beatGridSignature: originalGrid.signature
    }

    expect(
      hasUsableSongStructureAnalysis({ beatGridMap: originalGrid, songStructure: dynamicStructure })
    ).toBe(true)
    expect(
      hasUsableSongStructureAnalysis({ beatGridMap: changedGrid, songStructure: dynamicStructure })
    ).toBe(false)
    expect(hasUsableSongStructureAnalysis({ ...GRID, songStructure: dynamicStructure })).toBe(false)
  })

  it('continues resolving section playback from a stale algorithm result', () => {
    const legacyStructure = createLegacyStructure()
    const setting = {
      enablePlaybackRange: true,
      playbackRangeMode: 'section',
      playbackRangeSectionKinds: ['drop']
    }

    expect(resolvePlaybackSectionRangeResolution(setting, legacyStructure, 60)).toMatchObject({
      status: 'ready',
      ranges: [{ startSec: 16, endSec: 48, kinds: ['drop'] }]
    })
    expect(resolveInitialPlaybackRangeStartSec(setting, legacyStructure, 60)).toBe(16)
  })
})
