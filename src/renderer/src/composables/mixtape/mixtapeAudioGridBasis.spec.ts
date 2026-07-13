import { describe, expect, it } from 'vitest'
import {
  resolveMixtapeAudioBeatGridMap,
  resolveMixtapeAudioFirstBeatSec
} from './mixtapeAudioGridBasis'
import type { MixtapeTrack } from './types'
import { normalizeSongBeatGridMap } from '@shared/songBeatGridMap'

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
    const track = createTrack({
      firstBeatMs: 99.114,
      timeBasisOffsetMs: 50.114
    })

    expect(resolveMixtapeAudioFirstBeatSec(track)).toBeCloseTo(0.049, 8)
  })

  it('converts dynamic grid clip coordinates to the audio coordinate', () => {
    const beatGridMap = normalizeSongBeatGridMap({
      version: 1,
      source: 'manual',
      clips: [
        { startSec: 0, anchorSec: 0.1, bpm: 128, barBeatOffset: 0 },
        { startSec: 10, anchorSec: 10.1, bpm: 129, barBeatOffset: 0 }
      ]
    })
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
