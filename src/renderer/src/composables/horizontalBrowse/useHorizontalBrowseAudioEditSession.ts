import { computed, ref, watch, type Ref } from 'vue'
import type { ISongHotCue, ISongInfo, ISongMemoryCue } from 'src/types/globals'
import { snapAudioEditSecToBeatGrid } from '@shared/audioEditBeatGrid'
import {
  cloneAudioEditHotCues,
  cloneAudioEditMemoryCues,
  cloneAudioEditSongStructure,
  shiftAudioEditCuePointSec,
  shiftAudioEditLoopRange,
  shiftAudioEditPlaybackRange,
  shiftAudioEditSongStructure,
  shiftAudioEditTimedMarkers,
  type AudioEditLoopRange,
  type AudioEditTimelineMutation
} from '@shared/audioEditMarkers'
import {
  AUDIO_EDIT_EPSILON_SEC,
  AUDIO_EDIT_MAX_DURATION_SEC,
  cloneAudioEditClips,
  cloneAudioEditLoopGroup,
  createIdentityAudioEditClips,
  estimateAudioEditBeats,
  extractAudioEditRange,
  formatAudioEditClock,
  applyAudioEditInsertedRangesMutation,
  cloneAudioEditRanges,
  insertAudioEditClipsAt,
  isAudioEditRangeComplete,
  isIdentityAudioEditClips,
  normalizeAudioEditRange,
  resolveAudioEditPlanDuration,
  resolveLoopGroupEndPlanSec,
  shiftAudioEditRangeAfterInsertion,
  shiftAudioEditRangeAfterRemoval,
  wouldExceedAudioEditDuration,
  type AudioEditClip,
  type AudioEditLoopGroup,
  type AudioEditRange
} from '@shared/audioEditTimeline'
import {
  resolveNearestUnifiedSongBeatGridLine,
  resolveUnifiedSongBeatGridSecAtBeatOrdinal
} from '@shared/songBeatGridRuntime'
import type { SongBeatGridMapV2 } from '@shared/songBeatGridMapV2'
import type { SongStructureAnalysis } from '@shared/songStructure'

type AudioEditSnapshot = {
  clips: AudioEditClip[]
  insertedRanges: AudioEditRange[]
  selection: AudioEditRange | null
  pendingStartSec: number | null
  pendingEndSec: number | null
  loopGroup: AudioEditLoopGroup | null
  playheadSec: number
  hotCues: ISongHotCue[]
  memoryCues: ISongMemoryCue[]
  songStructure: SongStructureAnalysis | null
  playbackRange: AudioEditRange | null
  loopRange: AudioEditLoopRange | null
  cuePointSec: number | null
  startBeatOrdinal: number | null
  endBeatOrdinal: number | null
}

type UseHorizontalBrowseAudioEditSessionParams = {
  song: Ref<ISongInfo | null>
  sourceDurationSec: { readonly value: number }
  playheadSec: Ref<number>
  isPlaying: Ref<boolean>
  quantizeEnabled?: { readonly value: boolean }
  resolveDisplayBeatGridMap?: () => SongBeatGridMapV2 | null
  displayBeatGridSignature?: Ref<string>
  resolveCuePointSec?: () => number | null
  resolveLoopRange?: () => AudioEditLoopRange | null
  resolvePlaybackRangeSec?: () => AudioEditRange | null
  onTimelineStructureChanged?: () => void
}

const clonePlaybackRange = (range: AudioEditRange | null) => (range ? { ...range } : null)
const cloneLoopRange = (range: AudioEditLoopRange | null) => (range ? { ...range } : null)

export const useHorizontalBrowseAudioEditSession = (
  params: UseHorizontalBrowseAudioEditSessionParams
) => {
  let clipSeq = 0
  const createId = () => {
    clipSeq += 1
    return `clip-${clipSeq}`
  }

  const clips = ref<AudioEditClip[]>([])
  const insertedRanges = ref<AudioEditRange[]>([])
  const checkpointInsertedRanges = ref<AudioEditRange[]>([])
  const selection = ref<AudioEditRange | null>(null)
  const pendingStartSec = ref<number | null>(null)
  const pendingEndSec = ref<number | null>(null)
  const clipboard = ref<AudioEditClip[]>([])
  const loopGroup = ref<AudioEditLoopGroup | null>(null)
  const checkpointClips = ref<AudioEditClip[]>([])
  const undoStack = ref<AudioEditSnapshot[]>([])
  const redoStack = ref<AudioEditSnapshot[]>([])
  const errorMessage = ref('')
  const lockedSourceDurationSec = ref(0)
  const hotCues = ref<ISongHotCue[]>([])
  const memoryCues = ref<ISongMemoryCue[]>([])
  const songStructure = ref<SongStructureAnalysis | null>(null)
  const playbackRange = ref<AudioEditRange | null>(null)
  const loopRange = ref<AudioEditLoopRange | null>(null)
  const cuePointSec = ref<number | null>(null)
  const startBeatOrdinal = ref<number | null>(null)
  const endBeatOrdinal = ref<number | null>(null)
  const checkpointHotCues = ref<ISongHotCue[]>([])
  const checkpointMemoryCues = ref<ISongMemoryCue[]>([])
  const checkpointSongStructure = ref<SongStructureAnalysis | null>(null)
  const checkpointPlaybackRange = ref<AudioEditRange | null>(null)
  const checkpointLoopRange = ref<AudioEditLoopRange | null>(null)
  const checkpointCuePointSec = ref<number | null>(null)
  let applyingSnapshot = false

  const incomingSourceDurationSec = computed(() =>
    Math.max(0, Number(params.sourceDurationSec.value) || 0)
  )
  const sourceDurationSec = computed(() =>
    lockedSourceDurationSec.value > AUDIO_EDIT_EPSILON_SEC
      ? lockedSourceDurationSec.value
      : incomingSourceDurationSec.value
  )
  const planDurationSec = computed(() => resolveAudioEditPlanDuration(clips.value))
  const hasEdits = computed(() => !isIdentityAudioEditClips(clips.value, sourceDurationSec.value))
  const isDirty = computed(() => {
    const current = JSON.stringify({
      clips: clips.value.map((clip) => [clip.sourceStartSec, clip.sourceEndSec]),
      hotCues: hotCues.value,
      memoryCues: memoryCues.value
    })
    const saved = JSON.stringify({
      clips: checkpointClips.value.map((clip) => [clip.sourceStartSec, clip.sourceEndSec]),
      hotCues: checkpointHotCues.value,
      memoryCues: checkpointMemoryCues.value
    })
    return current !== saved
  })
  const completeSelection = computed(() =>
    isAudioEditRangeComplete(selection.value) ? selection.value : null
  )
  const selectionSummary = computed(() => {
    const range = completeSelection.value
    if (!range) return ''
    const durationSec = range.endSec - range.startSec
    const beats = estimateAudioEditBeats(durationSec, Number(params.song.value?.bpm) || 0)
    return `${beats} beats / ${formatAudioEditClock(durationSec)}`
  })

  const resolveDisplayGrid = () => params.resolveDisplayBeatGridMap?.() ?? null

  const captureSnapshot = (): AudioEditSnapshot => ({
    clips: cloneAudioEditClips(clips.value),
    insertedRanges: cloneAudioEditRanges(insertedRanges.value),
    selection: selection.value ? { ...selection.value } : null,
    pendingStartSec: pendingStartSec.value,
    pendingEndSec: pendingEndSec.value,
    loopGroup: cloneAudioEditLoopGroup(loopGroup.value),
    playheadSec: params.playheadSec.value,
    hotCues: cloneAudioEditHotCues(hotCues.value),
    memoryCues: cloneAudioEditMemoryCues(memoryCues.value),
    songStructure: cloneAudioEditSongStructure(songStructure.value),
    playbackRange: clonePlaybackRange(playbackRange.value),
    loopRange: cloneLoopRange(loopRange.value),
    cuePointSec: cuePointSec.value,
    startBeatOrdinal: startBeatOrdinal.value,
    endBeatOrdinal: endBeatOrdinal.value
  })

  const applySnapshot = (snapshot: AudioEditSnapshot) => {
    applyingSnapshot = true
    clips.value = cloneAudioEditClips(snapshot.clips)
    insertedRanges.value = cloneAudioEditRanges(snapshot.insertedRanges)
    selection.value = snapshot.selection ? { ...snapshot.selection } : null
    pendingStartSec.value = snapshot.pendingStartSec
    pendingEndSec.value = snapshot.pendingEndSec
    loopGroup.value = cloneAudioEditLoopGroup(snapshot.loopGroup)
    params.playheadSec.value = snapshot.playheadSec
    hotCues.value = cloneAudioEditHotCues(snapshot.hotCues)
    memoryCues.value = cloneAudioEditMemoryCues(snapshot.memoryCues)
    songStructure.value = cloneAudioEditSongStructure(snapshot.songStructure)
    playbackRange.value = clonePlaybackRange(snapshot.playbackRange)
    loopRange.value = cloneLoopRange(snapshot.loopRange)
    cuePointSec.value = snapshot.cuePointSec
    startBeatOrdinal.value = snapshot.startBeatOrdinal
    endBeatOrdinal.value = snapshot.endBeatOrdinal
    applyingSnapshot = false
    params.onTimelineStructureChanged?.()
  }

  const pushUndo = () => {
    undoStack.value = [...undoStack.value, captureSnapshot()]
    redoStack.value = []
  }

  const syncSelectionState = (range: AudioEditRange | null) => {
    selection.value = range ? { ...range } : null
    pendingStartSec.value = range?.startSec ?? null
    pendingEndSec.value = range?.endSec ?? null
  }

  const resolveBoundBeatOrdinal = (planSec: number | null) => {
    if (planSec === null) return null
    const durationSec = planDurationSec.value
    const grid = resolveDisplayGrid()
    const line = resolveNearestUnifiedSongBeatGridLine(grid, durationSec, planSec)
    if (line) return line.beatOrdinal
    const bpm = Number(params.song.value?.bpm) || 0
    if (!(bpm > 0)) return null
    const beatSec = 60 / bpm
    const firstBeatSec = Math.max(0, Number(params.song.value?.firstBeatMs) || 0) / 1000
    return Math.round((planSec - firstBeatSec) / beatSec)
  }

  const bindSelectionBeats = () => {
    startBeatOrdinal.value = resolveBoundBeatOrdinal(pendingStartSec.value)
    endBeatOrdinal.value = resolveBoundBeatOrdinal(pendingEndSec.value)
  }

  const canFollowIncomingDuration = () =>
    !isDirty.value &&
    undoStack.value.length === 0 &&
    redoStack.value.length === 0 &&
    (clips.value.length === 0 || isIdentityAudioEditClips(clips.value, sourceDurationSec.value))

  const captureFollowersFromSong = () => {
    const song = params.song.value
    hotCues.value = cloneAudioEditHotCues(song?.hotCues)
    memoryCues.value = cloneAudioEditMemoryCues(song?.memoryCues)
    songStructure.value = cloneAudioEditSongStructure(song?.songStructure)
    playbackRange.value = clonePlaybackRange(params.resolvePlaybackRangeSec?.() ?? null)
    loopRange.value = cloneLoopRange(params.resolveLoopRange?.() ?? null)
    const cueSec = params.resolveCuePointSec?.()
    cuePointSec.value =
      typeof cueSec === 'number' && Number.isFinite(cueSec) ? Math.max(0, cueSec) : null
  }

  const storeCheckpointFollowers = () => {
    checkpointHotCues.value = cloneAudioEditHotCues(hotCues.value)
    checkpointMemoryCues.value = cloneAudioEditMemoryCues(memoryCues.value)
    checkpointSongStructure.value = cloneAudioEditSongStructure(songStructure.value)
    checkpointPlaybackRange.value = clonePlaybackRange(playbackRange.value)
    checkpointLoopRange.value = cloneLoopRange(loopRange.value)
    checkpointCuePointSec.value = cuePointSec.value
  }

  const restoreCheckpointFollowers = () => {
    hotCues.value = cloneAudioEditHotCues(checkpointHotCues.value)
    memoryCues.value = cloneAudioEditMemoryCues(checkpointMemoryCues.value)
    songStructure.value = cloneAudioEditSongStructure(checkpointSongStructure.value)
    playbackRange.value = clonePlaybackRange(checkpointPlaybackRange.value)
    loopRange.value = cloneLoopRange(checkpointLoopRange.value)
    cuePointSec.value = checkpointCuePointSec.value
  }

  const resetForSong = () => {
    lockedSourceDurationSec.value = params.song.value?.filePath
      ? incomingSourceDurationSec.value
      : 0
    const identity = createIdentityAudioEditClips(sourceDurationSec.value, createId)
    clips.value = identity
    checkpointClips.value = cloneAudioEditClips(identity)
    insertedRanges.value = []
    checkpointInsertedRanges.value = []
    selection.value = null
    pendingStartSec.value = null
    pendingEndSec.value = null
    startBeatOrdinal.value = null
    endBeatOrdinal.value = null
    clipboard.value = []
    loopGroup.value = null
    undoStack.value = []
    redoStack.value = []
    errorMessage.value = ''
    captureFollowersFromSong()
    storeCheckpointFollowers()
  }

  const markCheckpoint = () => {
    checkpointClips.value = cloneAudioEditClips(clips.value)
    checkpointInsertedRanges.value = cloneAudioEditRanges(insertedRanges.value)
    storeCheckpointFollowers()
  }

  const discardToCheckpoint = () => {
    clips.value = cloneAudioEditClips(checkpointClips.value)
    insertedRanges.value = cloneAudioEditRanges(checkpointInsertedRanges.value)
    selection.value = null
    pendingStartSec.value = null
    pendingEndSec.value = null
    startBeatOrdinal.value = null
    endBeatOrdinal.value = null
    loopGroup.value = null
    undoStack.value = []
    redoStack.value = []
    errorMessage.value = ''
    restoreCheckpointFollowers()
  }

  const snapPlanSec = (planSec: number) => {
    const durationSec = planDurationSec.value
    const clamped = Math.max(0, Math.min(durationSec, planSec))
    const song = params.song.value
    return snapAudioEditSecToBeatGrid({
      planSec: clamped,
      durationSec,
      beatGridMap: resolveDisplayGrid() ?? song?.beatGridMap,
      bpm: song?.bpm,
      firstBeatMs: song?.firstBeatMs
    })
  }

  const resolveSecFromBeatOrdinal = (ordinal: number | null) => {
    if (ordinal === null) return null
    const durationSec = planDurationSec.value
    const grid = resolveDisplayGrid()
    const fromGrid = resolveUnifiedSongBeatGridSecAtBeatOrdinal(grid, durationSec, ordinal)
    if (fromGrid !== null) return snapPlanSec(fromGrid)
    const bpm = Number(params.song.value?.bpm) || 0
    if (!(bpm > 0)) return null
    const beatSec = 60 / bpm
    const firstBeatSec = Math.max(0, Number(params.song.value?.firstBeatMs) || 0) / 1000
    return snapPlanSec(firstBeatSec + ordinal * beatSec)
  }

  const remapSelectionFromBeats = () => {
    const nextStart =
      pendingStartSec.value === null ? null : resolveSecFromBeatOrdinal(startBeatOrdinal.value)
    const nextEnd =
      pendingEndSec.value === null ? null : resolveSecFromBeatOrdinal(endBeatOrdinal.value)
    if (pendingStartSec.value !== null && nextStart === null) return
    if (pendingEndSec.value !== null && nextEnd === null) return
    if (nextStart !== null) pendingStartSec.value = nextStart
    if (nextEnd !== null) pendingEndSec.value = nextEnd
    if (nextStart === null || nextEnd === null) {
      selection.value = null
      errorMessage.value = ''
      return
    }
    const normalized = normalizeAudioEditRange(nextStart, nextEnd)
    if (!normalized) {
      selection.value = null
      errorMessage.value = 'same-bound'
      return
    }
    syncSelectionState(normalized)
    errorMessage.value = ''
  }

  const setPendingBound = (kind: 'start' | 'end') => {
    const snapped = snapPlanSec(params.playheadSec.value)
    if (kind === 'start') {
      pendingStartSec.value = snapped
      startBeatOrdinal.value = resolveBoundBeatOrdinal(snapped)
    } else {
      pendingEndSec.value = snapped
      endBeatOrdinal.value = resolveBoundBeatOrdinal(snapped)
    }
    if (pendingStartSec.value === null || pendingEndSec.value === null) {
      selection.value = null
      errorMessage.value = ''
      loopGroup.value = null
      return
    }
    const normalized = normalizeAudioEditRange(pendingStartSec.value, pendingEndSec.value)
    if (!normalized) {
      selection.value = null
      errorMessage.value = 'same-bound'
      loopGroup.value = null
      return
    }
    syncSelectionState(normalized)
    bindSelectionBeats()
    errorMessage.value = ''
    loopGroup.value = null
  }

  const clearSelection = () => {
    syncSelectionState(null)
    startBeatOrdinal.value = null
    endBeatOrdinal.value = null
    loopGroup.value = null
    errorMessage.value = ''
  }

  const setHotCue = (slot: number, sec = params.playheadSec.value) => {
    const safeSlot = Math.max(0, Math.floor(Number(slot)))
    const rawSec = Math.max(0, Math.min(planDurationSec.value, Number(sec) || 0))
    const safeSec = params.quantizeEnabled?.value ? snapPlanSec(rawSec) : rawSec
    pushUndo()
    hotCues.value = [
      ...hotCues.value.filter((cue) => cue.slot !== safeSlot),
      { slot: safeSlot, sec: safeSec }
    ].sort((left, right) => left.slot - right.slot)
    errorMessage.value = ''
    return true
  }

  const deleteHotCue = (slot: number) => {
    if (!hotCues.value.some((cue) => cue.slot === slot)) return false
    pushUndo()
    hotCues.value = hotCues.value.filter((cue) => cue.slot !== slot)
    errorMessage.value = ''
    return true
  }

  const setMemoryCue = (sec = params.playheadSec.value) => {
    const rawSec = Math.max(0, Math.min(planDurationSec.value, Number(sec) || 0))
    const safeSec = params.quantizeEnabled?.value ? snapPlanSec(rawSec) : rawSec
    pushUndo()
    memoryCues.value = [
      ...memoryCues.value.filter((cue) => Math.abs(Number(cue.sec) - safeSec) > 0.0001),
      { sec: safeSec }
    ].sort((left, right) => left.sec - right.sec)
    errorMessage.value = ''
    return true
  }

  const deleteMemoryCue = (sec: number) => {
    if (!memoryCues.value.some((cue) => Math.abs(Number(cue.sec) - sec) <= 0.0001)) return false
    pushUndo()
    memoryCues.value = memoryCues.value.filter((cue) => Math.abs(Number(cue.sec) - sec) > 0.0001)
    errorMessage.value = ''
    return true
  }

  const fail = (message: string) => {
    errorMessage.value = message
    return false
  }

  const applyTimelineFollowers = (mutation: AudioEditTimelineMutation, nextDurationSec: number) => {
    hotCues.value = shiftAudioEditTimedMarkers(hotCues.value, mutation)
    memoryCues.value = shiftAudioEditTimedMarkers(memoryCues.value, mutation)
    songStructure.value = shiftAudioEditSongStructure(
      songStructure.value,
      mutation,
      nextDurationSec
    )
    playbackRange.value = shiftAudioEditPlaybackRange(playbackRange.value, mutation)
    loopRange.value = shiftAudioEditLoopRange(loopRange.value, mutation)
    cuePointSec.value = shiftAudioEditCuePointSec(cuePointSec.value, mutation)
  }

  const mutateTimeline = (
    nextClips: AudioEditClip[],
    playheadSec: number,
    nextSelection: AudioEditRange | null,
    mutation?: AudioEditTimelineMutation
  ) => {
    if (!nextClips.length) return fail('empty')
    const nextDurationSec = resolveAudioEditPlanDuration(nextClips)
    if (nextDurationSec > AUDIO_EDIT_MAX_DURATION_SEC) return fail('duration')
    clips.value = nextClips
    if (mutation) {
      applyTimelineFollowers(mutation, nextDurationSec)
      insertedRanges.value = applyAudioEditInsertedRangesMutation(insertedRanges.value, mutation)
    }
    if (isIdentityAudioEditClips(nextClips, sourceDurationSec.value)) {
      insertedRanges.value = []
    }
    syncSelectionState(nextSelection)
    bindSelectionBeats()
    params.playheadSec.value = Math.max(0, Math.min(nextDurationSec, playheadSec))
    errorMessage.value = ''
    params.onTimelineStructureChanged?.()
    return true
  }

  const copySelection = () => {
    const range = completeSelection.value
    if (!range) return false
    const extracted = extractAudioEditRange(clips.value, range, createId).extracted
    if (!extracted.length) return false
    clipboard.value = extracted
    errorMessage.value = ''
    return true
  }

  const cutSelection = (updateClipboard: boolean) => {
    if (params.isPlaying.value) return fail('playing')
    const range = completeSelection.value
    if (!range) return false
    const playheadSec = params.playheadSec.value
    const extracted = extractAudioEditRange(clips.value, range, createId)
    if (!extracted.extracted.length) return false
    if (!extracted.remaining.length) return fail('empty')
    pushUndo()
    if (updateClipboard) clipboard.value = extracted.extracted
    loopGroup.value = null
    return mutateTimeline(extracted.remaining, playheadSec, null, {
      kind: 'remove',
      range
    })
  }

  const pasteClipboard = () => {
    if (params.isPlaying.value) return fail('playing')
    if (!clipboard.value.length) return false
    const extra = resolveAudioEditPlanDuration(clipboard.value)
    if (wouldExceedAudioEditDuration(planDurationSec.value, extra)) return fail('duration')
    pushUndo()
    const insertSec = snapPlanSec(params.playheadSec.value)
    const next = insertAudioEditClipsAt(clips.value, insertSec, clipboard.value, createId)
    const nextSelection = shiftAudioEditRangeAfterInsertion(
      completeSelection.value,
      insertSec,
      extra
    )
    loopGroup.value = null
    return mutateTimeline(next, insertSec, nextSelection, {
      kind: 'insert',
      insertSec,
      durationSec: extra
    })
  }

  const applyLoop = () => {
    if (params.isPlaying.value) return fail('playing')
    const range = completeSelection.value
    if (!range) return false
    const extracted = extractAudioEditRange(clips.value, range, createId).extracted
    if (!extracted.length) return false
    const extra = resolveAudioEditPlanDuration(extracted)
    if (wouldExceedAudioEditDuration(planDurationSec.value, extra)) return fail('duration')
    pushUndo()
    const insertSec = snapPlanSec(range.endSec)
    const next = insertAudioEditClipsAt(clips.value, insertSec, extracted, createId)
    const nextSelection = shiftAudioEditRangeAfterInsertion(range, insertSec, extra)
    loopGroup.value = {
      clips: cloneAudioEditClips(extracted),
      count: 1,
      insertPlanSec: insertSec
    }
    return mutateTimeline(next, insertSec, nextSelection, {
      kind: 'insert',
      insertSec,
      durationSec: extra
    })
  }

  const adjustLoopCount = (delta: -1 | 1) => {
    if (params.isPlaying.value) return fail('playing')
    const group = loopGroup.value
    if (!group) return false
    const nextCount = group.count + delta
    if (nextCount < 0) return false
    const piece = cloneAudioEditClips(group.clips)
    if (delta > 0) {
      const extra = resolveAudioEditPlanDuration(piece)
      if (wouldExceedAudioEditDuration(planDurationSec.value, extra)) return fail('duration')
      pushUndo()
      const insertSec = snapPlanSec(resolveLoopGroupEndPlanSec(group))
      const next = insertAudioEditClipsAt(clips.value, insertSec, piece, createId)
      const nextSelection = shiftAudioEditRangeAfterInsertion(
        completeSelection.value,
        insertSec,
        extra
      )
      loopGroup.value = { ...group, count: nextCount }
      return mutateTimeline(next, insertSec, nextSelection, {
        kind: 'insert',
        insertSec,
        durationSec: extra
      })
    }
    const removeStart = resolveLoopGroupEndPlanSec({
      ...group,
      count: Math.max(0, group.count - 1)
    })
    const removeEnd = resolveLoopGroupEndPlanSec(group)
    const range = normalizeAudioEditRange(removeStart, removeEnd)
    if (!range && nextCount === 0 && group.count === 1) {
      const fallback = normalizeAudioEditRange(
        group.insertPlanSec,
        resolveLoopGroupEndPlanSec(group)
      )
      if (!fallback) return false
      pushUndo()
      const extracted = extractAudioEditRange(clips.value, fallback, createId)
      const nextSelection = shiftAudioEditRangeAfterRemoval(completeSelection.value, fallback)
      loopGroup.value = { ...group, count: 0 }
      return mutateTimeline(extracted.remaining, fallback.startSec, nextSelection, {
        kind: 'remove',
        range: fallback
      })
    }
    if (!range) return false
    pushUndo()
    const extracted = extractAudioEditRange(clips.value, range, createId)
    const nextSelection = shiftAudioEditRangeAfterRemoval(completeSelection.value, range)
    loopGroup.value = { ...group, count: nextCount }
    return mutateTimeline(extracted.remaining, range.startSec, nextSelection, {
      kind: 'remove',
      range
    })
  }

  const undo = () => {
    if (params.isPlaying.value) return fail('playing')
    const snapshot = undoStack.value[undoStack.value.length - 1]
    if (!snapshot) return false
    const current = captureSnapshot()
    undoStack.value = undoStack.value.slice(0, -1)
    redoStack.value = [...redoStack.value, current]
    applySnapshot(snapshot)
    errorMessage.value = ''
    return true
  }

  const redo = () => {
    if (params.isPlaying.value) return fail('playing')
    const snapshot = redoStack.value[redoStack.value.length - 1]
    if (!snapshot) return false
    const current = captureSnapshot()
    redoStack.value = redoStack.value.slice(0, -1)
    undoStack.value = [...undoStack.value, current]
    applySnapshot(snapshot)
    errorMessage.value = ''
    return true
  }

  const setPlaybackRange = (range: AudioEditRange | null) => {
    playbackRange.value = clonePlaybackRange(range)
  }

  watch(
    () => String(params.song.value?.filePath || ''),
    () => {
      clipSeq = 0
      resetForSong()
    },
    { immediate: true }
  )

  watch(incomingSourceDurationSec, (durationSec, previousSec) => {
    if (!canFollowIncomingDuration()) return
    if (
      typeof previousSec === 'number' &&
      Math.abs(durationSec - previousSec) <= 0.05 &&
      clips.value.length > 0
    ) {
      return
    }
    resetForSong()
  })

  watch(
    () =>
      [
        params.displayBeatGridSignature?.value || '',
        clips.value.map((clip) => `${clip.sourceStartSec}:${clip.sourceEndSec}`).join('|')
      ] as const,
    ([gridSignature, clipsSignature], previous) => {
      if (applyingSnapshot) return
      if (!previous) {
        bindSelectionBeats()
        return
      }
      const previousClipsSignature = previous[1]
      if (clipsSignature !== previousClipsSignature) {
        bindSelectionBeats()
        return
      }
      if (gridSignature && gridSignature !== previous[0]) {
        remapSelectionFromBeats()
      }
    }
  )

  return {
    clips,
    insertedRanges,
    selection,
    pendingStartSec,
    pendingEndSec,
    clipboard,
    loopGroup,
    planDurationSec,
    hasEdits,
    isDirty,
    completeSelection,
    selectionSummary,
    hotCues,
    memoryCues,
    songStructure,
    playbackRange,
    loopRange,
    cuePointSec,
    canUndo: computed(() => undoStack.value.length > 0),
    canRedo: computed(() => redoStack.value.length > 0),
    errorMessage,
    snapPlanSec,
    setPendingBound,
    clearSelection,
    setHotCue,
    deleteHotCue,
    setMemoryCue,
    deleteMemoryCue,
    copySelection,
    cutSelection,
    pasteClipboard,
    applyLoop,
    adjustLoopCount,
    undo,
    redo,
    markCheckpoint,
    discardToCheckpoint,
    resetForSong,
    setPlaybackRange
  }
}
