import { describe, expect, it } from 'vitest'
import {
  shiftAudioEditBoundRangeAfterInsertion,
  shiftAudioEditCuePointSec,
  shiftAudioEditMarkerSecAfterInsertion,
  shiftAudioEditMarkerSecAfterRemoval,
  shiftAudioEditPlaybackRange,
  shiftAudioEditSongStructure,
  shiftAudioEditTimedMarkers
} from './audioEditMarkers'

describe('audio edit marker timeline follow', () => {
  it('deletes markers on the cut start and keeps markers on the cut end', () => {
    expect(shiftAudioEditMarkerSecAfterRemoval(2, { startSec: 2, endSec: 5 })).toBeNull()
    expect(shiftAudioEditMarkerSecAfterRemoval(5, { startSec: 2, endSec: 5 })).toBe(2)
    expect(shiftAudioEditMarkerSecAfterRemoval(1, { startSec: 2, endSec: 5 })).toBe(1)
    expect(shiftAudioEditMarkerSecAfterRemoval(8, { startSec: 2, endSec: 5 })).toBe(5)
  })

  it('moves markers at the insert point with the original audio', () => {
    expect(shiftAudioEditMarkerSecAfterInsertion(4, 4, 2)).toBe(6)
    expect(shiftAudioEditMarkerSecAfterInsertion(3.9, 4, 2)).toBe(3.9)
    expect(shiftAudioEditMarkerSecAfterInsertion(8, 4, 2)).toBe(10)
  })

  it('does not copy loop markers into the inserted region', () => {
    const next = shiftAudioEditTimedMarkers([{ sec: 2, isLoop: true, loopEndSec: 4 }], {
      kind: 'insert',
      insertSec: 4,
      durationSec: 2
    })
    expect(next).toEqual([{ sec: 2, isLoop: true, loopEndSec: 6 }])
  })

  it('closes a playback range fully inside the cut and clips a partial overlap', () => {
    expect(
      shiftAudioEditPlaybackRange(
        { startSec: 3, endSec: 5 },
        { kind: 'remove', range: { startSec: 2, endSec: 6 } }
      )
    ).toBeNull()
    expect(
      shiftAudioEditPlaybackRange(
        { startSec: 1, endSec: 5 },
        { kind: 'remove', range: { startSec: 3, endSec: 8 } }
      )
    ).toEqual({ startSec: 1, endSec: 3 })
  })

  it('stretches a spanning playback range when audio is inserted inside it', () => {
    expect(shiftAudioEditBoundRangeAfterInsertion({ startSec: 10, endSec: 20 }, 15, 4)).toEqual({
      startSec: 10,
      endSec: 24
    })
  })

  it('shifts structure sections and drops ones fully removed', () => {
    const next = shiftAudioEditSongStructure(
      {
        formatVersion: 1,
        algorithmVersion: 1,
        durationSec: 20,
        bpm: 120,
        firstBeatMs: 0,
        barBeatOffset: 0,
        phraseBars: 8,
        sections: [
          {
            startSec: 0,
            endSec: 4,
            startBar: 1,
            endBar: 8,
            phraseIndex: 0,
            kind: 'intro',
            confidence: 1,
            energy: 0.5,
            low: 0.5,
            high: 0.5,
            novelty: 0.5
          },
          {
            startSec: 8,
            endSec: 12,
            startBar: 17,
            endBar: 24,
            phraseIndex: 1,
            kind: 'drop',
            confidence: 1,
            energy: 0.8,
            low: 0.8,
            high: 0.8,
            novelty: 0.5
          }
        ]
      },
      { kind: 'remove', range: { startSec: 0, endSec: 4 } },
      16
    )
    expect(next?.durationSec).toBe(16)
    expect(next?.sections).toEqual([
      expect.objectContaining({ kind: 'drop', startSec: 4, endSec: 8 })
    ])
  })

  it('moves a cue point sitting on the insert', () => {
    expect(shiftAudioEditCuePointSec(4, { kind: 'insert', insertSec: 4, durationSec: 2 })).toBe(6)
    expect(
      shiftAudioEditCuePointSec(4, { kind: 'remove', range: { startSec: 4, endSec: 6 } })
    ).toBeNull()
  })
})
