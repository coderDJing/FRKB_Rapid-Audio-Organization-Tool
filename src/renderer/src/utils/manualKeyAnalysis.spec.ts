import { describe, expect, it } from 'vitest'
import { createSongBeatGridMapV2FromFixedGrid } from '../../../shared/songBeatGridMapV2'
import {
  collectMissingAnalysisFilesFromSongs,
  resolveMissingAnalysisReasons
} from './manualKeyAnalysisCompleteness'

const FIXED_GRID_V2 = createSongBeatGridMapV2FromFixedGrid({
  bpm: 128,
  firstBeatMs: 125,
  downbeatBeatOffset: 0,
  source: 'analysis'
})

describe('manual key analysis completeness', () => {
  it('does not treat a missing frozen segment result as pending analysis', () => {
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
          beatGridMap: FIXED_GRID_V2 ?? undefined
        },
        true,
        { includeSongStructure: true, missingWaveformFilePaths: [] }
      )
    ).toEqual([])
  })

  it('reports waveform as the fifth independently missing result', () => {
    const filePath = 'D:\\music\\missing-waveform.wav'
    const song = {
      filePath,
      key: '8A',
      energyScore: 72,
      beatGridMap: FIXED_GRID_V2 ?? undefined
    }
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

  it('accepts a canonical v2 manual grid without an analysis algorithm version', () => {
    const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
      bpm: 128,
      firstBeatMs: 125,
      downbeatBeatOffset: 0,
      source: 'manual'
    })
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
    ).toEqual(['missing-bpm', 'missing-first-beat', 'missing-downbeat-beat-offset'])
  })
})
