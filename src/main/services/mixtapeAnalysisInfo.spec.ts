import { describe, expect, it } from 'vitest'
import { stripMixtapeGridCopies } from './mixtapeAnalysisInfo'

describe('mixtape grid copy policy', () => {
  it('removes copied grid fields but preserves project-local and non-grid analysis fields', () => {
    const info: Record<string, unknown> = {
      bpm: 128,
      firstBeatMs: 125,
      downbeatBeatOffset: 3,
      barBeatOffset: 31,
      timeBasisOffsetMs: 7,
      beatGridSource: 'manual',
      beatGridMap: { version: 1 },
      key: '8A',
      originalBpm: 126,
      songStructure: { algorithmVersion: 1 }
    }

    expect(stripMixtapeGridCopies(info)).toBe(true)
    expect(info).toEqual({
      key: '8A',
      originalBpm: 126,
      songStructure: { algorithmVersion: 1 }
    })
  })
})
