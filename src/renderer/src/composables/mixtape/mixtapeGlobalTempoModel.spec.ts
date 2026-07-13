import { describe, expect, it } from 'vitest'
import {
  applyMixtapeGlobalTempoTargetsToTracks,
  buildDefaultMixtapeGlobalBpmEnvelopeSnapshot
} from './mixtapeGlobalTempoModel'
import type { MixtapeTrack } from './types'

const createTrack = (params: {
  id: string
  bpm: number
  sourceBpm?: number
  startSec: number
}): MixtapeTrack => ({
  id: params.id,
  mixOrder: params.startSec,
  title: params.id,
  artist: '',
  duration: '100',
  filePath: `/${params.id}.wav`,
  originPath: `/${params.id}.wav`,
  bpm: params.bpm,
  gridBaseBpm: params.sourceBpm ?? params.bpm,
  originalBpm: params.sourceBpm ?? params.bpm,
  startSec: params.startSec
})

describe('generated mixtape global BPM envelope', () => {
  it('ramps both tracks to the incoming BPM across their overlap', () => {
    const tracks = [
      createTrack({ id: 'first', bpm: 128, startSec: 0 }),
      createTrack({ id: 'second', bpm: 128, sourceBpm: 129, startSec: 50 })
    ]
    const snapshot = buildDefaultMixtapeGlobalBpmEnvelopeSnapshot({
      tracks,
      resolveTrackDurationSeconds: () => 100,
      resolveTrackSourceDurationSeconds: () => 100,
      resolveTrackFirstBeatSeconds: () => 0
    })

    expect(snapshot.bpmEnvelope).toEqual([
      { sec: 0, bpm: 128, source: 'auto' },
      { sec: 50, bpm: 128, source: 'auto' },
      { sec: 100, bpm: 129, source: 'auto' },
      { sec: 150, bpm: 129, source: 'auto' }
    ])
    expect(
      applyMixtapeGlobalTempoTargetsToTracks(tracks, snapshot.bpmEnvelope).map((track) => track.bpm)
    ).toEqual([128, 128])
  })
})
