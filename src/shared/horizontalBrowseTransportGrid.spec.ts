import { describe, expect, it } from 'vitest'
import { createSongBeatGridMapV2FromClips } from './songBeatGridMapV2'
import {
  buildHorizontalBrowseTransportGridPayload,
  resolveHorizontalBrowseTransportGrid
} from './horizontalBrowseTransportGrid'

describe('horizontal browse transport grid input', () => {
  it('sends v2 clips with a four-beat phase only', () => {
    const map = createSongBeatGridMapV2FromClips(
      [{ startSec: 0, anchorSec: 0.125, bpm: 128, downbeatBeatOffset: 3 }],
      'analysis',
      { allowSingleClip: true }
    )

    expect(resolveHorizontalBrowseTransportGrid({ beatGridMap: map })).toEqual({
      bpm: 128,
      firstBeatMs: 125,
      downbeatBeatOffset: 3,
      beatGridClips: [{ startSec: 0, anchorSec: 0.125, bpm: 128, downbeatBeatOffset: 3 }]
    })
  })

  it('rejects a missing v2 map instead of rebuilding transport grid from root fields', () => {
    expect(
      buildHorizontalBrowseTransportGridPayload({
        filePath: 'D:/music/a.mp3',
        bpm: 120,
        firstBeatMs: 0,
        downbeatBeatOffset: 2
      })
    ).toBeNull()
  })
})
