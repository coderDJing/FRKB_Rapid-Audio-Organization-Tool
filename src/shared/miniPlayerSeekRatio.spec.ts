import { describe, expect, it } from 'vitest'
import { normalizeMiniPlayerSeekRatio } from './miniPlayerWindow'

describe('normalizeMiniPlayerSeekRatio', () => {
  it('keeps 0-1 waveform click ratios', () => {
    expect(normalizeMiniPlayerSeekRatio(0)).toBe(0)
    expect(normalizeMiniPlayerSeekRatio(0.5)).toBe(0.5)
    expect(normalizeMiniPlayerSeekRatio(1)).toBe(1)
  })

  it('converts 0-100 percentages greater than 1', () => {
    expect(normalizeMiniPlayerSeekRatio(50)).toBe(0.5)
    expect(normalizeMiniPlayerSeekRatio(100)).toBe(1)
  })

  it('clamps invalid values to 0', () => {
    expect(normalizeMiniPlayerSeekRatio(Number.NaN)).toBe(0)
    expect(normalizeMiniPlayerSeekRatio(-2)).toBe(0)
  })
})
