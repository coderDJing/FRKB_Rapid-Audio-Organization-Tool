import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import { useHorizontalBrowseAudioEditSession } from './useHorizontalBrowseAudioEditSession'

const createSession = (overrides?: Partial<ISongInfo>) => {
  const song = ref({
    filePath: 'D:\\music\\track.wav',
    bpm: 60,
    firstBeatMs: 0,
    hotCues: [{ slot: 0, sec: 3 }],
    memoryCues: [{ sec: 8 }],
    ...overrides
  } as unknown as ISongInfo)
  const sourceDurationSec = ref(10)
  const playheadSec = ref(0)
  const isPlaying = ref(false)
  const quantizeEnabled = ref(true)
  return {
    playheadSec,
    isPlaying,
    quantizeEnabled,
    session: useHorizontalBrowseAudioEditSession({
      song,
      sourceDurationSec,
      playheadSec,
      isPlaying,
      quantizeEnabled
    })
  }
}

describe('useHorizontalBrowseAudioEditSession', () => {
  it('keeps snapped bounds in the repeated clip occurrence under the playhead', () => {
    const { playheadSec, session } = createSession()
    playheadSec.value = 1
    session.setPendingBound('start')
    playheadSec.value = 3
    session.setPendingBound('end')
    expect(session.copySelection()).toBe(true)

    playheadSec.value = 10
    expect(session.pasteClipboard()).toBe(true)
    session.clearSelection()
    playheadSec.value = 11.2
    session.setPendingBound('start')

    expect(session.pendingStartSec.value).toBe(11)
  })

  it('sorts reversed bounds and reports two bounds on the same beat', () => {
    const { playheadSec, session } = createSession()
    playheadSec.value = 8
    session.setPendingBound('start')
    playheadSec.value = 4
    session.setPendingBound('end')
    expect(session.completeSelection.value).toEqual({ startSec: 4, endSec: 8 })
    expect(session.pendingStartSec.value).toBe(4)
    expect(session.pendingEndSec.value).toBe(8)

    playheadSec.value = 4
    session.setPendingBound('end')
    expect(session.completeSelection.value).toBeNull()
    expect(session.errorMessage.value).toBe('same-bound')
  })

  it('keeps the internal clipboard when undoing a cut', () => {
    const { playheadSec, session } = createSession()
    playheadSec.value = 2
    session.setPendingBound('start')
    playheadSec.value = 4
    session.setPendingBound('end')

    expect(session.cutSelection(true)).toBe(true)
    expect(session.clipboard.value).toHaveLength(1)
    expect(session.undo()).toBe(true)
    expect(session.clipboard.value).toHaveLength(1)
    expect(session.planDurationSec.value).toBe(10)
  })

  it('keeps the playhead position when cutting unless the shorter timeline clamps it', () => {
    const { playheadSec, session } = createSession()
    playheadSec.value = 2
    session.setPendingBound('start')
    playheadSec.value = 4
    session.setPendingBound('end')

    expect(session.cutSelection(true)).toBe(true)
    expect(playheadSec.value).toBe(4)

    session.undo()
    playheadSec.value = 9
    expect(session.cutSelection(true)).toBe(true)
    expect(playheadSec.value).toBe(8)
  })

  it('sets and removes edit-session hot and memory cues at the edit playhead', () => {
    const { playheadSec, session } = createSession({ hotCues: [], memoryCues: [] })
    playheadSec.value = 3

    expect(session.setHotCue(2)).toBe(true)
    expect(session.hotCues.value).toEqual([{ slot: 2, sec: 3 }])
    expect(session.setMemoryCue()).toBe(true)
    expect(session.memoryCues.value).toEqual([{ sec: 3 }])
    expect(session.deleteHotCue(2)).toBe(true)
    expect(session.deleteMemoryCue(3)).toBe(true)
    expect(session.hotCues.value).toEqual([])
    expect(session.memoryCues.value).toEqual([])
  })

  it('allows cue markers to be changed while audio is playing', () => {
    const { playheadSec, isPlaying, session } = createSession({ hotCues: [], memoryCues: [] })
    playheadSec.value = 4.2
    isPlaying.value = true

    expect(session.setHotCue(1)).toBe(true)
    expect(session.setMemoryCue()).toBe(true)
    expect(session.hotCues.value).toEqual([{ slot: 1, sec: 4 }])
    expect(session.memoryCues.value).toEqual([{ sec: 4 }])
  })

  it('keeps a zero-count repeat group so plus can restore it', () => {
    const { playheadSec, session } = createSession()
    playheadSec.value = 2
    session.setPendingBound('start')
    playheadSec.value = 4
    session.setPendingBound('end')
    playheadSec.value = 6

    expect(session.applyLoop()).toBe(true)
    expect(session.adjustLoopCount(-1)).toBe(true)
    expect(session.loopGroup.value?.count).toBe(0)
    expect(session.planDurationSec.value).toBe(10)
    expect(session.adjustLoopCount(1)).toBe(true)
    expect(session.loopGroup.value?.count).toBe(1)
    expect(session.planDurationSec.value).toBe(12)
  })

  it('moves cues with a cut using half-open bounds and does not copy them on paste', () => {
    const { playheadSec, session } = createSession()
    expect(session.hotCues.value.map((cue) => cue.sec)).toEqual([3])
    playheadSec.value = 2
    session.setPendingBound('start')
    playheadSec.value = 4
    session.setPendingBound('end')
    expect(session.cutSelection(true)).toBe(true)
    expect(session.hotCues.value).toEqual([])
    expect(session.memoryCues.value.map((cue) => cue.sec)).toEqual([6])

    playheadSec.value = 8
    expect(session.pasteClipboard()).toBe(true)
    expect(session.hotCues.value).toEqual([])
    expect(session.memoryCues.value.map((cue) => cue.sec)).toEqual([6])
  })

  it('highlights only the inserted copy after paste or loop', () => {
    const { playheadSec, session } = createSession()
    playheadSec.value = 2
    session.setPendingBound('start')
    playheadSec.value = 4
    session.setPendingBound('end')
    expect(session.copySelection()).toBe(true)

    playheadSec.value = 8
    expect(session.pasteClipboard()).toBe(true)
    expect(session.insertedRanges.value).toEqual([{ startSec: 8, endSec: 10 }])

    playheadSec.value = 4
    expect(session.applyLoop()).toBe(true)
    expect(session.insertedRanges.value).toEqual([
      { startSec: 4, endSec: 6 },
      { startSec: 10, endSec: 12 }
    ])
    expect(session.adjustLoopCount(1)).toBe(true)
    expect(session.insertedRanges.value).toEqual([
      { startSec: 4, endSec: 8 },
      { startSec: 12, endSec: 14 }
    ])
  })

  it('highlights the looped copy instead of the merged remainder', () => {
    const { playheadSec, session } = createSession()
    playheadSec.value = 2
    session.setPendingBound('start')
    playheadSec.value = 4
    session.setPendingBound('end')
    playheadSec.value = 4
    expect(session.applyLoop()).toBe(true)
    expect(session.planDurationSec.value).toBe(12)
    expect(session.insertedRanges.value).toEqual([{ startSec: 4, endSec: 6 }])
  })

  it('pastes at the playhead even when it sits inside the selection', () => {
    const { playheadSec, session } = createSession()
    playheadSec.value = 2
    session.setPendingBound('start')
    playheadSec.value = 6
    session.setPendingBound('end')
    expect(session.copySelection()).toBe(true)
    playheadSec.value = 4
    expect(session.pasteClipboard()).toBe(true)
    expect(session.planDurationSec.value).toBe(14)
    expect(session.insertedRanges.value).toEqual([{ startSec: 4, endSec: 8 }])
    expect(playheadSec.value).toBe(4)
  })

  it('appends a repeat after the selection and ignores the playhead', () => {
    const { playheadSec, session } = createSession()
    playheadSec.value = 2
    session.setPendingBound('start')
    playheadSec.value = 4
    session.setPendingBound('end')
    playheadSec.value = 8
    expect(session.applyLoop()).toBe(true)
    expect(session.planDurationSec.value).toBe(12)
    expect(session.insertedRanges.value).toEqual([{ startSec: 4, endSec: 6 }])
    expect(playheadSec.value).toBe(4)
  })

  it('clears insert boxes when pasted audio restores the original song', () => {
    const { playheadSec, session } = createSession()
    playheadSec.value = 2
    session.setPendingBound('start')
    playheadSec.value = 4
    session.setPendingBound('end')
    expect(session.cutSelection(true)).toBe(true)
    expect(session.insertedRanges.value).toEqual([])

    playheadSec.value = 2
    expect(session.pasteClipboard()).toBe(true)
    expect(session.hasEdits.value).toBe(false)
    expect(session.insertedRanges.value).toEqual([])
  })

  it('restores insert boxes on undo', () => {
    const { playheadSec, session } = createSession()
    playheadSec.value = 2
    session.setPendingBound('start')
    playheadSec.value = 4
    session.setPendingBound('end')
    expect(session.copySelection()).toBe(true)
    playheadSec.value = 8
    expect(session.pasteClipboard()).toBe(true)
    expect(session.undo()).toBe(true)
    expect(session.insertedRanges.value).toEqual([])
  })

  it('snaps selection bounds to the exact beat-grid second', () => {
    const bpm = 128
    const beatSec = 60 / bpm
    const { playheadSec, session } = createSession({
      bpm,
      firstBeatMs: 0
    })
    playheadSec.value = beatSec + 0.001
    session.setPendingBound('start')
    expect(session.pendingStartSec.value).toBe(beatSec)
  })

  it('follows playback range through a cut and closes it when fully removed', () => {
    const sourceDurationSec = ref(10)
    const playheadSec = ref(0)
    const isPlaying = ref(false)
    const song = ref({
      filePath: 'D:\\music\\track.wav',
      bpm: 60,
      firstBeatMs: 0
    } as unknown as ISongInfo)
    const session = useHorizontalBrowseAudioEditSession({
      song,
      sourceDurationSec,
      playheadSec,
      isPlaying,
      resolvePlaybackRangeSec: () => ({ startSec: 2, endSec: 8 })
    })
    playheadSec.value = 1
    session.setPendingBound('start')
    playheadSec.value = 3
    session.setPendingBound('end')
    expect(session.cutSelection(false)).toBe(true)
    expect(session.playbackRange.value).toEqual({ startSec: 1, endSec: 6 })

    playheadSec.value = 1
    session.setPendingBound('start')
    playheadSec.value = 7
    session.setPendingBound('end')
    expect(session.cutSelection(false)).toBe(true)
    expect(session.playbackRange.value).toBeNull()
  })
})
