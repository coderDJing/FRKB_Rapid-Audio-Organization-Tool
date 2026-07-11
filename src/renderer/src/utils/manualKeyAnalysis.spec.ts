import { describe, expect, it } from 'vitest'
import { createSongBeatGridMapFromClips } from '../../../shared/songBeatGridMap'
import { CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION } from '../../../shared/songStructure'
import {
  collectMissingAnalysisFilesFromSongs,
  resolveMissingAnalysisReasons
} from './manualKeyAnalysisCompleteness'

const FIXED_GRID = { bpm: 128, firstBeatMs: 125, barBeatOffset: 0 }

const createStructure = (algorithmVersion: number) => ({
  formatVersion: 1,
  algorithmVersion,
  source: 'algorithmic',
  durationSec: 60,
  ...FIXED_GRID,
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

describe('manual key analysis completeness', () => {
  it('does not treat compatible old algorithm results as missing', () => {
    const filePath = 'D:\\music\\stale-techno.wav'
    expect(
      resolveMissingAnalysisReasons(
        {
          filePath,
          key: '8A',
          keyAnalysisAlgorithmVersion: 1,
          energyScore: 72,
          energyAlgorithmVersion: 1,
          beatGridAlgorithmVersion: 1,
          ...FIXED_GRID,
          songStructure: createStructure(CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION - 1)
        },
        true,
        { includeSongStructure: true, missingWaveformFilePaths: [] }
      )
    ).toEqual([])
  })

  it('reports waveform as the fifth independently missing result', () => {
    const filePath = 'D:\\music\\missing-waveform.wav'
    const song = { filePath, key: '8A', energyScore: 72, ...FIXED_GRID }
    expect(
      resolveMissingAnalysisReasons(song, true, {
        missingWaveformFilePaths: [filePath]
      })
    ).toEqual(['missing-waveform'])
    expect(
      collectMissingAnalysisFilesFromSongs([song], true, new Set(), {
        missingWaveformFilePaths: [filePath]
      })
    ).toEqual([filePath])
  })

  it('accepts a dynamic manual grid without an analysis algorithm version', () => {
    const beatGridMap = createSongBeatGridMapFromClips([
      { startSec: 0, anchorSec: 0.125, bpm: 128, barBeatOffset: 0 },
      { startSec: 32, anchorSec: 32.25, bpm: 130, barBeatOffset: 0 }
    ])
    expect(beatGridMap).not.toBeNull()
    expect(
      resolveMissingAnalysisReasons(
        {
          filePath: 'D:\\music\\dynamic.wav',
          key: '8A',
          energyScore: 68,
          beatGridMap
        },
        true
      )
    ).toEqual([])
  })

  it('treats no-bpm as complete without requiring a structure result', () => {
    expect(
      resolveMissingAnalysisReasons(
        {
          filePath: 'D:\\music\\ambient.wav',
          key: '2A',
          energyScore: 20,
          beatGridStatus: 'no-bpm'
        },
        true,
        { includeSongStructure: true }
      )
    ).toEqual([])
  })

  it('keeps a missing Beat Grid incomplete even when the runtime is unavailable', () => {
    expect(
      resolveMissingAnalysisReasons(
        {
          filePath: 'D:\\music\\runtime-missing.wav',
          key: '2A',
          energyScore: 20
        },
        false,
        { includeSongStructure: true }
      )
    ).toEqual(['missing-bpm', 'missing-first-beat', 'missing-bar-beat-offset'])
  })
})
