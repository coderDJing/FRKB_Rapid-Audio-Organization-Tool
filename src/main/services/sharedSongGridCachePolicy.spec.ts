import { describe, expect, it } from 'vitest'
import { createSongBeatGridMapFromClips } from '../../shared/songBeatGridMap'
import { CURRENT_BEAT_GRID_ALGORITHM_VERSION } from './beatGridAlgorithmVersion'
import { shouldAcceptSharedSongGridCache } from './sharedSongGridCachePolicy'

const createDynamicGrid = () => {
  const grid = createSongBeatGridMapFromClips([
    { startSec: 0, anchorSec: 0.125, bpm: 128, barBeatOffset: 0 },
    { startSec: 32, anchorSec: 32.25, bpm: 130, barBeatOffset: 0 }
  ])
  if (!grid) throw new Error('dynamic grid fixture failed')
  return grid
}

describe('shared song grid cache policy', () => {
  it('accepts a valid dynamic grid without an analysis algorithm version', () => {
    expect(shouldAcceptSharedSongGridCache({ beatGridMap: createDynamicGrid() })).toBe(true)
  })

  it('accepts a valid dynamic grid with a stale analysis algorithm version', () => {
    expect(
      shouldAcceptSharedSongGridCache({
        beatGridMap: createDynamicGrid(),
        beatGridAlgorithmVersion: CURRENT_BEAT_GRID_ALGORITHM_VERSION - 1
      })
    ).toBe(true)
  })

  it('rejects an incomplete fixed grid regardless of its version', () => {
    expect(shouldAcceptSharedSongGridCache({})).toBe(false)
    expect(
      shouldAcceptSharedSongGridCache({
        beatGridAlgorithmVersion: CURRENT_BEAT_GRID_ALGORITHM_VERSION - 1
      })
    ).toBe(false)
  })

  it('accepts a complete fixed grid regardless of its algorithm version', () => {
    expect(
      shouldAcceptSharedSongGridCache({
        bpm: 128,
        firstBeatMs: 125,
        barBeatOffset: 0,
        beatGridAlgorithmVersion: CURRENT_BEAT_GRID_ALGORITHM_VERSION - 1
      })
    ).toBe(true)
  })
})
