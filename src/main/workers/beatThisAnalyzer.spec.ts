import { describe, expect, it } from 'vitest'
import { normalizeBeatThisAnalyzeResult } from './beatThisAnalyzer'

describe('Beat This analyzer bridge boundary', () => {
  it('reduces a legacy 32-beat offset to the four-beat phase without exposing it', () => {
    const result = normalizeBeatThisAnalyzeResult({
      bpm: 128,
      firstBeatMs: 125,
      barBeatOffset: 31,
      beatCount: 64,
      downbeatCount: 16,
      durationSec: 30,
      beatIntervalSec: 60 / 128,
      beatCoverageScore: 0.9,
      beatStabilityScore: 0.9,
      downbeatCoverageScore: 0.9,
      downbeatStabilityScore: 0.9,
      qualityScore: 0.9
    })

    expect(result).toMatchObject({ downbeatBeatOffset: 3 })
    expect(result).not.toHaveProperty('barBeatOffset')
  })
})
