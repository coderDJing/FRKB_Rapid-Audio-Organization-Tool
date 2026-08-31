import { describe, expect, it } from 'vitest'
import { projectAudioEditBeatGridMap, snapAudioEditSecToBeatGrid } from './audioEditBeatGrid'
import { createSongBeatGridMapV2FromFixedGrid } from './songBeatGridMapV2'
import { createUnifiedSongBeatGridRuntime } from './songBeatGridRuntime'
import { insertAudioEditClipsAt, type AudioEditClip } from './audioEditTimeline'

const clip = (id: string, start: number, end: number): AudioEditClip => ({
  id,
  sourceStartSec: start,
  sourceEndSec: end
})

describe('projectAudioEditBeatGridMap', () => {
  it('shifts remaining beats onto the edited plan timeline after a cut', () => {
    const sourceMap = createSongBeatGridMapV2FromFixedGrid({
      bpm: 120,
      firstBeatMs: 0,
      downbeatBeatOffset: 0
    })
    const projected = projectAudioEditBeatGridMap(sourceMap, [clip('a', 0, 2), clip('b', 4, 8)], 8)
    const runtime = createUnifiedSongBeatGridRuntime(projected, 6)

    expect(projected?.clips.map((item) => item.startSec)).toEqual([0, 2])
    expect(runtime?.lines.some((line) => Math.abs(line.sec - 0.5) < 0.0001)).toBe(true)
    expect(runtime?.lines.some((line) => Math.abs(line.sec - 2) < 0.0001)).toBe(true)
    expect(runtime?.lines.some((line) => Math.abs(line.sec - 3) < 0.0001)).toBe(true)
  })

  it('preserves a negative grid anchor after cutting a complete four-beat phrase', () => {
    const sourceMap = createSongBeatGridMapV2FromFixedGrid({
      bpm: 120,
      firstBeatMs: 86.057,
      downbeatBeatOffset: 0
    })
    const projected = projectAudioEditBeatGridMap(
      sourceMap,
      [clip('a', 0, 4.086057), clip('b', 6.086057, 10)],
      10
    )
    const runtime = createUnifiedSongBeatGridRuntime(projected, 8)

    expect(projected?.clips[1]?.anchorSec).toBe(-1.913943)
    expect(runtime?.lines.some((line) => Math.abs(line.sec - 4.086057) < 0.000001)).toBe(true)
    expect(runtime?.lines.some((line) => Math.abs(line.sec - 4) < 0.000001)).toBe(false)
  })

  it('keeps paste seams on the same beat times the grid draws', () => {
    const bpm = 128
    const beatSec = 60 / bpm
    const sourceDurationSec = beatSec * 32
    const sourceMap = createSongBeatGridMapV2FromFixedGrid({
      bpm,
      firstBeatMs: 0,
      downbeatBeatOffset: 0
    })
    const selStart = beatSec * 4
    const selEnd = beatSec * 8
    const insertSec = snapAudioEditSecToBeatGrid({
      planSec: beatSec * 8,
      durationSec: sourceDurationSec,
      beatGridMap: sourceMap,
      bpm
    })
    const next = insertAudioEditClipsAt(
      [clip('a', 0, sourceDurationSec)],
      insertSec,
      [clip('b', selStart, selEnd)],
      () => 'x'
    )
    const projected = projectAudioEditBeatGridMap(sourceMap, next, sourceDurationSec)
    const runtime = createUnifiedSongBeatGridRuntime(
      projected,
      sourceDurationSec + (selEnd - selStart)
    )
    expect(runtime?.clipBoundaries.length).toBeGreaterThan(0)
    for (const boundary of runtime?.clipBoundaries || []) {
      expect(runtime?.lines.some((line) => Math.abs(line.sec - boundary) < 0.0000005)).toBe(true)
    }
  })
})

describe('snapAudioEditSecToBeatGrid', () => {
  it('keeps the exact beat-grid second instead of rounding to milliseconds', () => {
    const bpm = 128
    const beatSec = 60 / bpm
    const map = createSongBeatGridMapV2FromFixedGrid({
      bpm,
      firstBeatMs: 0,
      downbeatBeatOffset: 0
    })
    expect(
      snapAudioEditSecToBeatGrid({
        planSec: beatSec + 0.001,
        durationSec: 16,
        beatGridMap: map,
        bpm
      })
    ).toBe(beatSec)
  })
})
