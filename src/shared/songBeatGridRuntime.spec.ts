import { describe, expect, it } from 'vitest'
import { createSongBeatGridMapV2FromClips } from './songBeatGridMapV2'
import {
  createUnifiedSongBeatGridRuntime,
  resolveUnifiedSongBeatGridSecAtBeatOrdinal
} from './songBeatGridRuntime'

describe('unified SongBeatGrid runtime', () => {
  it('rejects legacy maps instead of rebuilding a runtime from old semantics', () => {
    const runtime = createUnifiedSongBeatGridRuntime(
      {
        version: 1,
        source: 'analysis',
        clips: [{ startSec: 0, anchorSec: 0, bpm: 120, barBeatOffset: 0 }]
      },
      3
    )

    expect(runtime).toBeNull()
  })

  it('uses v2 maps directly', () => {
    const map = createSongBeatGridMapV2FromClips(
      [{ startSec: 0, anchorSec: 0, bpm: 120, downbeatBeatOffset: 1 }],
      'analysis',
      { allowSingleClip: true }
    )
    const runtime = createUnifiedSongBeatGridRuntime(map, 3)

    expect(
      runtime?.lines.filter((line) => line.level === 'downbeat').map((line) => line.sec)
    ).toEqual([0.5, 2.5])
    expect(resolveUnifiedSongBeatGridSecAtBeatOrdinal(map, 3, 3.5)).toBe(1.75)
  })
})
