import { describe, expect, it } from 'vitest'
import { createSongBeatGridMapV2FromFixedGrid } from '@shared/songBeatGridMapV2'
import { createTrackTimeMap } from './trackTimeMapFactory'

describe('mixtape grid snapping', () => {
  it('keeps snapping aligned with the currently visible grid detail', () => {
    const sourceBeatGridMap = createSongBeatGridMapV2FromFixedGrid({
      bpm: 120,
      firstBeatMs: 0,
      downbeatBeatOffset: 0,
      source: 'analysis'
    })
    if (!sourceBeatGridMap) throw new Error('failed to create v2 grid fixture')
    const timeMap = createTrackTimeMap({
      controlPoints: [
        { sec: 0, bpm: 120 },
        { sec: 8, bpm: 120 }
      ],
      durationSec: 8,
      sourceDurationSec: 8,
      originalBpm: 120,
      fallbackBpm: 120,
      firstBeatSourceSec: 0,
      beatSourceSec: 0.5,
      downbeatBeatOffset: 0,
      sourceBeatGridMap
    })

    expect(timeMap.buildVisibleGridLines(0)).toEqual([])
    expect(timeMap.buildSnapCandidates(0)).toEqual([])
    expect(timeMap.snapLocalSec(1.12, 0)).toBe(1.12)
    expect(timeMap.buildSnapCandidates(3)).not.toContain(0.5)
    expect(timeMap.snapLocalSec(1.12, 3)).toBe(2)
    expect(timeMap.resolveNearestGridLine(1.12, 3)?.level).toBe('downbeat')
    expect(timeMap.buildSnapCandidates(99)).toContain(0.5)
    expect(timeMap.snapLocalSec(1.12, 99)).toBe(1)
    expect(timeMap.resolveNearestGridLine(1.12, 99)?.level).toBe('beat')
  })
})
