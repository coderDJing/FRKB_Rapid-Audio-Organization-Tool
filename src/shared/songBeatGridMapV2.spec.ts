import { describe, expect, it } from 'vitest'
import { normalizeSongBeatGridMap } from './songBeatGridMap'
import {
  createSongBeatGridMapV2FromClips,
  createSongBeatGridMapV2FromFixedGrid,
  createSongBeatGridRuntimeV2,
  normalizeSongBeatGridDownbeatBeatOffset,
  normalizeSongBeatGridMapV2,
  resolveSongBeatGridV2BeatJumpSec,
  resolveSongBeatGridV2BpmAtSec,
  summarizeSongBeatGridV2Bpm,
  SONG_BEAT_GRID_MAP_V2_VERSION
} from './songBeatGridMapV2'

describe('SongBeatGridMap v2', () => {
  it('uses a single clip for fixed grids and preserves the analysis source', () => {
    const map = createSongBeatGridMapV2FromFixedGrid({
      bpm: 128,
      firstBeatMs: 125,
      downbeatBeatOffset: 2,
      source: 'analysis'
    })

    expect(map).toMatchObject({
      version: SONG_BEAT_GRID_MAP_V2_VERSION,
      source: 'analysis',
      clips: [{ startSec: 0, anchorSec: 0.125, bpm: 128, downbeatBeatOffset: 2 }]
    })
  })

  it('strictly accepts only the four valid downbeat offsets', () => {
    expect(normalizeSongBeatGridDownbeatBeatOffset(0)).toBe(0)
    expect(normalizeSongBeatGridDownbeatBeatOffset(3)).toBe(3)
    expect(normalizeSongBeatGridDownbeatBeatOffset(4)).toBeNull()
    expect(normalizeSongBeatGridDownbeatBeatOffset(-1)).toBeNull()
    expect(normalizeSongBeatGridDownbeatBeatOffset(1.5)).toBeNull()
  })

  it('does not accept a v1 bar offset as a v2 map', () => {
    expect(
      normalizeSongBeatGridMapV2({
        version: 1,
        source: 'manual',
        clips: [{ startSec: 0, anchorSec: 0, bpm: 128, barBeatOffset: 0 }]
      })
    ).toBeNull()
  })

  it('provides an equivalent read-only four-beat projection to remaining v1 consumers', () => {
    const map = createSongBeatGridMapV2FromFixedGrid({
      bpm: 128,
      firstBeatMs: 0,
      downbeatBeatOffset: 3,
      source: 'analysis'
    })

    expect(normalizeSongBeatGridMap(map, { allowSingleClip: true })).toMatchObject({
      version: 2,
      source: 'analysis',
      clips: [{ barBeatOffset: 3 }]
    })
  })

  it('generates only beat and downbeat lines while keeping dynamic boundaries independent', () => {
    const map = createSongBeatGridMapV2FromClips(
      [
        { startSec: 0, anchorSec: 0, bpm: 120, downbeatBeatOffset: 0 },
        { startSec: 2, anchorSec: 2, bpm: 120, downbeatBeatOffset: 1 }
      ],
      'manual'
    )
    const runtime = createSongBeatGridRuntimeV2(map, 4)

    expect(runtime?.clipBoundaries).toEqual([2])
    expect(new Set(runtime?.lines.map((line) => line.level))).toEqual(new Set(['downbeat', 'beat']))
    expect(
      runtime?.lines.filter((line) => line.level === 'downbeat').map((line) => line.sec)
    ).toEqual([0, 2.5])
  })

  it('resolves BPM and beat jumps directly from the v2 runtime', () => {
    const map = createSongBeatGridMapV2FromClips(
      [
        { startSec: 0, anchorSec: 0, bpm: 120, downbeatBeatOffset: 0 },
        { startSec: 2, anchorSec: 2, bpm: 150, downbeatBeatOffset: 0 }
      ],
      'analysis'
    )

    expect(resolveSongBeatGridV2BpmAtSec(map, 4, 1)).toBe(120)
    expect(resolveSongBeatGridV2BpmAtSec(map, 4, 3)).toBe(150)
    expect(resolveSongBeatGridV2BeatJumpSec(map, 4, 0.5, 2)).toBe(1.5)
  })

  it('builds list display and sorting values from a v2 map', () => {
    const map = createSongBeatGridMapV2FromClips(
      [
        { startSec: 0, anchorSec: 0, bpm: 128, downbeatBeatOffset: 0 },
        { startSec: 16, anchorSec: 16, bpm: 130, downbeatBeatOffset: 0 }
      ],
      'analysis'
    )

    expect(summarizeSongBeatGridV2Bpm(map)).toMatchObject({
      displayText: '128 -> 130',
      values: [128, 130],
      minimumBpm: 128,
      isDynamic: true
    })
  })
})
