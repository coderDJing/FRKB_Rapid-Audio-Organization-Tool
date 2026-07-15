import { describe, expect, it } from 'vitest'
import {
  resolveMixtapeAudioBeatGridMap,
  resolveMixtapeAudioFirstBeatSec
} from './mixtapeAudioGridBasis'
import type { MixtapeTrack } from './types'
import {
  createSongBeatGridMapV2FromClips,
  createSongBeatGridMapV2FromFixedGrid
} from '@shared/songBeatGridMapV2'

const createTrack = (overrides: Partial<MixtapeTrack> = {}): MixtapeTrack => ({
  id: 'track',
  mixOrder: 1,
  title: 'Track',
  artist: 'Artist',
  duration: '04:00',
  filePath: '/track.mp3',
  originPath: '',
  ...overrides
})

describe('mixtape audio grid basis', () => {
  it('converts the external timeline first beat to the actual audio coordinate', () => {
    const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
      bpm: 128,
      firstBeatMs: 99.114,
      downbeatBeatOffset: 0,
      source: 'analysis'
    })
    expect(beatGridMap).not.toBeNull()
    const track = createTrack({
      beatGridMap: beatGridMap ?? undefined,
      timeBasisOffsetMs: 50.114
    })

    expect(resolveMixtapeAudioFirstBeatSec(track)).toBeCloseTo(0.049, 8)
  })

  it('converts dynamic grid clip coordinates to the audio coordinate', () => {
    const beatGridMap = createSongBeatGridMapV2FromClips(
      [
        { startSec: 0, anchorSec: 0.1, bpm: 128, downbeatBeatOffset: 0 },
        { startSec: 10, anchorSec: 10.1, bpm: 129, downbeatBeatOffset: 0 }
      ],
      'manual',
      { allowSingleClip: true }
    )
    expect(beatGridMap).not.toBeNull()
    const track = createTrack({
      timeBasisOffsetMs: 50,
      beatGridMap: beatGridMap ?? undefined
    })

    const result = resolveMixtapeAudioBeatGridMap(track, 120)

    expect(result?.clips[0]?.anchorSec).toBeCloseTo(0.05, 8)
    expect(result?.clips[1]?.startSec).toBeCloseTo(9.95, 8)
    expect(result?.clips[1]?.anchorSec).toBeCloseTo(10.05, 8)
  })
})
