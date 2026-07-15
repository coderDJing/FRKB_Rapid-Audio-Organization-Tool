import { describe, expect, it } from 'vitest'
import { createSongBeatGridMapV2FromFixedGrid } from '@shared/songBeatGridMapV2'
import {
  resolveHorizontalBrowseCuePointSec,
  resolveHorizontalBrowseDefaultCuePointSec
} from './horizontalBrowseDetailMath'

describe('horizontal browse detail grid snapping', () => {
  const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
    bpm: 120,
    firstBeatMs: 100,
    downbeatBeatOffset: 2,
    source: 'analysis'
  })
  if (!beatGridMap) throw new Error('failed to create test v2 beat grid map')

  it('snaps cue points to the canonical v2 runtime line', () => {
    expect(resolveHorizontalBrowseCuePointSec({ beatGridMap }, 0.58, 10)).toBe(0.6)
  })

  it('does not rebuild a grid from projections when the v2 map is missing', () => {
    expect(resolveHorizontalBrowseCuePointSec(null, 0.58, 10)).toBe(0)
    expect(resolveHorizontalBrowseDefaultCuePointSec(null, 10)).toBe(0)
  })

  it('uses the first canonical runtime line as the default cue point', () => {
    expect(resolveHorizontalBrowseDefaultCuePointSec({ beatGridMap }, 10)).toBe(0.1)
  })
})
