import { describe, expect, it } from 'vitest'
import {
  applyAudioEditInsertedRangesMutation,
  extractAudioEditRange,
  insertAudioEditClipsAt,
  isIdentityAudioEditClips,
  resolveAudioEditPlanDuration,
  shiftAudioEditRangeAfterInsertion,
  shiftAudioEditRangeAfterRemoval,
  type AudioEditClip
} from './audioEditTimeline'

const clip = (id: string, start: number, end: number): AudioEditClip => ({
  id,
  sourceStartSec: start,
  sourceEndSec: end
})

describe('audio edit timeline', () => {
  it('treats an empty timeline as identity when the source has no duration', () => {
    expect(isIdentityAudioEditClips([], 0)).toBe(true)
    expect(isIdentityAudioEditClips([clip('a', 0, 10)], 0)).toBe(false)
  })

  it('extracts only plan clips across a cut, not the deleted source gap', () => {
    const clips = [clip('a', 0, 10), clip('b', 20, 30)]
    const extracted = extractAudioEditRange(clips, { startSec: 5, endSec: 15 }, () => 'x').extracted
    expect(extracted.map((item) => [item.sourceStartSec, item.sourceEndSec])).toEqual([
      [5, 10],
      [20, 25]
    ])
    expect(resolveAudioEditPlanDuration(extracted)).toBe(10)
  })

  it('inserts extracted clips without restoring the deleted gap', () => {
    const clips = [clip('a', 0, 10), clip('b', 20, 30)]
    const extracted = extractAudioEditRange(clips, { startSec: 5, endSec: 15 }, () => 'x').extracted
    const next = insertAudioEditClipsAt(clips, 15, extracted, () => 'y')
    expect(next.map((item) => [item.sourceStartSec, item.sourceEndSec])).toEqual([
      [0, 10],
      [20, 25],
      [5, 10],
      [20, 30]
    ])
    expect(resolveAudioEditPlanDuration(next)).toBe(30)
  })

  it('keeps the source selection on the original audio after inserting before it', () => {
    expect(shiftAudioEditRangeAfterInsertion({ startSec: 10, endSec: 20 }, 5, 4)).toEqual({
      startSec: 14,
      endSec: 24
    })
    expect(shiftAudioEditRangeAfterInsertion({ startSec: 10, endSec: 20 }, 20, 4)).toEqual({
      startSec: 10,
      endSec: 20
    })
  })

  it('moves or clips a source selection after removing earlier audio', () => {
    expect(
      shiftAudioEditRangeAfterRemoval({ startSec: 10, endSec: 20 }, { startSec: 2, endSec: 5 })
    ).toEqual({ startSec: 7, endSec: 17 })
    expect(
      shiftAudioEditRangeAfterRemoval({ startSec: 10, endSec: 20 }, { startSec: 15, endSec: 25 })
    ).toEqual({ startSec: 10, endSec: 15 })
  })

  it('tracks pasted plan ranges and merges adjacent loop copies', () => {
    const pasted = applyAudioEditInsertedRangesMutation([], {
      kind: 'insert',
      insertSec: 8,
      durationSec: 2
    })
    expect(pasted).toEqual([{ startSec: 8, endSec: 10 }])
    expect(
      applyAudioEditInsertedRangesMutation(pasted, {
        kind: 'insert',
        insertSec: 10,
        durationSec: 2
      })
    ).toEqual([{ startSec: 8, endSec: 12 }])
  })

  it('shifts later insert boxes when audio is inserted before them', () => {
    expect(
      applyAudioEditInsertedRangesMutation([{ startSec: 8, endSec: 10 }], {
        kind: 'insert',
        insertSec: 0,
        durationSec: 2
      })
    ).toEqual([
      { startSec: 0, endSec: 2 },
      { startSec: 10, endSec: 12 }
    ])
  })

  it('clips insert boxes when the overlapping audio is removed', () => {
    expect(
      applyAudioEditInsertedRangesMutation([{ startSec: 4, endSec: 8 }], {
        kind: 'remove',
        range: { startSec: 5, endSec: 7 }
      })
    ).toEqual([{ startSec: 4, endSec: 6 }])
  })
})
