import { describe, expect, it } from 'vitest'
import {
  ANALYSIS_BPM_RANGE_PRESETS,
  LEGACY_ANALYSIS_BPM_RANGE,
  isOctaveSafeAnalysisBpmRange,
  normalizeAnalysisBpmRangeId,
  resolveAnalysisBpmRange
} from './analysisBpmRange'

describe('analysis BPM range', () => {
  it('keeps supported preset ids and normalizes unknown values', () => {
    expect(normalizeAnalysisBpmRangeId('88-175')).toBe('88-175')
    expect(normalizeAnalysisBpmRangeId('bad-value')).toBe('70-180')
    expect(resolveAnalysisBpmRange('98-195')).toEqual({
      id: '98-195',
      minBpm: 98,
      maxBpm: 195
    })
  })

  it('marks the narrow Rekordbox presets as octave safe', () => {
    for (const preset of ANALYSIS_BPM_RANGE_PRESETS) {
      if (preset.id === '70-180') continue
      expect(isOctaveSafeAnalysisBpmRange({ ...preset })).toBe(true)
    }
    expect(isOctaveSafeAnalysisBpmRange({ ...ANALYSIS_BPM_RANGE_PRESETS[0] })).toBe(false)
    expect(isOctaveSafeAnalysisBpmRange({ ...LEGACY_ANALYSIS_BPM_RANGE })).toBe(false)
  })
})
