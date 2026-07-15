import { describe, expect, it } from 'vitest'
import { createSongBeatGridMapV2FromFixedGrid } from '../../shared/songBeatGridMapV2'
import { shouldAcceptSharedSongGridCache } from './sharedSongGridCachePolicy'

describe('shared song grid cache policy', () => {
  it('accepts a valid v2 single-clip grid without root projections', () => {
    const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
      bpm: 128,
      firstBeatMs: 125,
      downbeatBeatOffset: 3,
      source: 'analysis'
    })
    expect(shouldAcceptSharedSongGridCache({ beatGridMap })).toBe(true)
  })

  it('rejects an incomplete cache entry', () => {
    expect(shouldAcceptSharedSongGridCache({})).toBe(false)
  })

  it('rejects root-field-only grids', () => {
    expect(
      shouldAcceptSharedSongGridCache({
        bpm: 128,
        firstBeatMs: 125,
        barBeatOffset: 0
      })
    ).toBe(false)
  })
})
