import { describe, expect, it } from 'vitest'
import {
  buildTrackVisibleGridLinesOnMasterGrid,
  createMixtapeMasterGrid
} from './mixtapeMasterGrid'

describe('mixtape master grid', () => {
  it('only creates downbeat and beat lines', () => {
    const grid = createMixtapeMasterGrid({
      points: [
        { sec: 0, bpm: 120 },
        { sec: 16, bpm: 120 }
      ],
      fallbackBpm: 120
    })

    expect(grid.buildVisibleGridLines(99).map((line) => line.level)).toEqual([
      'downbeat',
      'beat',
      'beat',
      'beat',
      'downbeat',
      'beat',
      'beat',
      'beat',
      'downbeat',
      'beat',
      'beat',
      'beat',
      'downbeat',
      'beat',
      'beat',
      'beat',
      'downbeat',
      'beat',
      'beat',
      'beat',
      'downbeat',
      'beat',
      'beat',
      'beat',
      'downbeat',
      'beat',
      'beat',
      'beat',
      'downbeat',
      'beat',
      'beat',
      'beat',
      'downbeat'
    ])
  })

  it('uses the four-beat downbeat offset for track lines', () => {
    const grid = createMixtapeMasterGrid({
      points: [
        { sec: 0, bpm: 120 },
        { sec: 16, bpm: 120 }
      ],
      fallbackBpm: 120
    })

    const levels = buildTrackVisibleGridLinesOnMasterGrid({
      grid,
      trackStartSec: 0,
      durationSec: 4,
      sourceDurationSec: 4,
      firstBeatSourceSec: 0,
      beatSourceSec: 0.5,
      downbeatBeatOffset: 2,
      zoom: 99
    }).map((line) => line.level)

    expect(levels.slice(0, 7)).toEqual([
      'beat',
      'beat',
      'downbeat',
      'beat',
      'beat',
      'beat',
      'downbeat'
    ])
  })
})
