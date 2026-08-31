import type { ISongHotCue, ISongMemoryCue } from '../types/globals'
import {
  AUDIO_EDIT_EPSILON_SEC,
  normalizeAudioEditRange,
  roundAudioEditSec,
  shiftAudioEditRangeAfterRemoval,
  type AudioEditRange
} from './audioEditTimeline'
import { toFixedNumber } from './songStructureCommon'
import type { SongStructureAnalysis } from './songStructure'
import {
  SONG_STRUCTURE_V23_FORMAT_VERSION,
  type SongStructureAnalysisV23
} from './songStructureV23Common'

export type AudioEditTimedMarker = {
  sec: number
  isLoop?: boolean
  loopEndSec?: number
}

export type AudioEditLoopRange = {
  startSec: number
  endSec: number
}

export type AudioEditTimelineMutation =
  | { kind: 'insert'; insertSec: number; durationSec: number }
  | { kind: 'remove'; range: AudioEditRange }

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export const shiftAudioEditMarkerSecAfterRemoval = (
  sec: number,
  removedRange: AudioEditRange
): number | null => {
  const removed = normalizeAudioEditRange(removedRange.startSec, removedRange.endSec)
  if (!removed) return roundAudioEditSec(sec)
  const pointSec = roundAudioEditSec(sec)
  if (
    pointSec + AUDIO_EDIT_EPSILON_SEC >= removed.startSec &&
    pointSec < removed.endSec - AUDIO_EDIT_EPSILON_SEC
  ) {
    return null
  }
  if (pointSec >= removed.endSec - AUDIO_EDIT_EPSILON_SEC) {
    return roundAudioEditSec(pointSec - (removed.endSec - removed.startSec))
  }
  return pointSec
}

export const shiftAudioEditMarkerSecAfterInsertion = (
  sec: number,
  insertSec: number,
  insertedDurationSec: number
): number => {
  const durationSec = roundAudioEditSec(insertedDurationSec)
  const pointSec = roundAudioEditSec(sec)
  if (durationSec <= AUDIO_EDIT_EPSILON_SEC) return pointSec
  const pointInsertSec = roundAudioEditSec(insertSec)
  if (pointSec + AUDIO_EDIT_EPSILON_SEC >= pointInsertSec) {
    return roundAudioEditSec(pointSec + durationSec)
  }
  return pointSec
}

export const shiftAudioEditTimedMarkerAfterRemoval = <T extends AudioEditTimedMarker>(
  marker: T,
  removedRange: AudioEditRange
): T | null => {
  const nextSec = shiftAudioEditMarkerSecAfterRemoval(marker.sec, removedRange)
  if (nextSec === null) return null
  if (!marker.isLoop || marker.loopEndSec == null) {
    return { ...marker, sec: nextSec }
  }
  const shiftedEnd = shiftAudioEditMarkerSecAfterRemoval(marker.loopEndSec, removedRange)
  const nextEndSec = shiftedEnd === null ? removedRange.startSec : shiftedEnd
  if (nextEndSec <= nextSec + AUDIO_EDIT_EPSILON_SEC) {
    return { ...marker, sec: nextSec, isLoop: false, loopEndSec: undefined }
  }
  return { ...marker, sec: nextSec, loopEndSec: nextEndSec }
}

export const shiftAudioEditTimedMarkerAfterInsertion = <T extends AudioEditTimedMarker>(
  marker: T,
  insertSec: number,
  insertedDurationSec: number
): T => {
  const nextSec = shiftAudioEditMarkerSecAfterInsertion(marker.sec, insertSec, insertedDurationSec)
  if (!marker.isLoop || marker.loopEndSec == null) {
    return { ...marker, sec: nextSec }
  }
  return {
    ...marker,
    sec: nextSec,
    loopEndSec: shiftAudioEditMarkerSecAfterInsertion(
      marker.loopEndSec,
      insertSec,
      insertedDurationSec
    )
  }
}

export const shiftAudioEditTimedMarkers = <T extends AudioEditTimedMarker>(
  markers: readonly T[],
  mutation: AudioEditTimelineMutation
): T[] => {
  const result: T[] = []
  for (const marker of markers) {
    const next =
      mutation.kind === 'remove'
        ? shiftAudioEditTimedMarkerAfterRemoval(marker, mutation.range)
        : shiftAudioEditTimedMarkerAfterInsertion(marker, mutation.insertSec, mutation.durationSec)
    if (next) result.push(next)
  }
  return result
}

export const shiftAudioEditBoundRangeAfterInsertion = (
  range: AudioEditRange | AudioEditLoopRange | null,
  insertSec: number,
  insertedDurationSec: number
): AudioEditRange | null => {
  if (!range) return null
  return normalizeAudioEditRange(
    shiftAudioEditMarkerSecAfterInsertion(range.startSec, insertSec, insertedDurationSec),
    shiftAudioEditMarkerSecAfterInsertion(range.endSec, insertSec, insertedDurationSec)
  )
}

export const shiftAudioEditLoopRange = (
  range: AudioEditLoopRange | null,
  mutation: AudioEditTimelineMutation
): AudioEditLoopRange | null => {
  const shifted =
    mutation.kind === 'remove'
      ? shiftAudioEditRangeAfterRemoval(range, mutation.range)
      : shiftAudioEditBoundRangeAfterInsertion(range, mutation.insertSec, mutation.durationSec)
  if (!shifted) return null
  return { startSec: shifted.startSec, endSec: shifted.endSec }
}

export const shiftAudioEditPlaybackRange = (
  range: AudioEditRange | null,
  mutation: AudioEditTimelineMutation
): AudioEditRange | null =>
  mutation.kind === 'remove'
    ? shiftAudioEditRangeAfterRemoval(range, mutation.range)
    : shiftAudioEditBoundRangeAfterInsertion(range, mutation.insertSec, mutation.durationSec)

export const shiftAudioEditCuePointSec = (
  cuePointSec: number | null,
  mutation: AudioEditTimelineMutation
): number | null => {
  if (cuePointSec === null) return null
  if (mutation.kind === 'remove') {
    return shiftAudioEditMarkerSecAfterRemoval(cuePointSec, mutation.range)
  }
  return shiftAudioEditMarkerSecAfterInsertion(
    cuePointSec,
    mutation.insertSec,
    mutation.durationSec
  )
}

export const cloneAudioEditHotCues = (cues: readonly ISongHotCue[] | null | undefined) =>
  (cues || []).map((cue) => ({ ...cue }))

export const cloneAudioEditMemoryCues = (cues: readonly ISongMemoryCue[] | null | undefined) =>
  (cues || []).map((cue) => ({ ...cue }))

export const cloneAudioEditSongStructure = (
  structure: SongStructureAnalysis | null | undefined
): SongStructureAnalysis | null => {
  if (!structure) return null
  return cloneJson(structure)
}

const shiftTimedSections = <T extends { startSec: number; endSec: number }>(
  sections: readonly T[],
  mutation: AudioEditTimelineMutation
): T[] => {
  const kept: T[] = []
  for (const section of sections) {
    const shifted =
      mutation.kind === 'remove'
        ? shiftAudioEditRangeAfterRemoval(
            { startSec: section.startSec, endSec: section.endSec },
            mutation.range
          )
        : shiftAudioEditBoundRangeAfterInsertion(
            { startSec: section.startSec, endSec: section.endSec },
            mutation.insertSec,
            mutation.durationSec
          )
    if (!shifted) continue
    kept.push({
      ...section,
      startSec: toFixedNumber(shifted.startSec, 3),
      endSec: toFixedNumber(shifted.endSec, 3)
    })
  }
  return kept
}

const isV23SongStructure = (
  structure: SongStructureAnalysis
): structure is SongStructureAnalysisV23 =>
  structure.formatVersion === SONG_STRUCTURE_V23_FORMAT_VERSION

export const shiftAudioEditSongStructure = (
  structure: SongStructureAnalysis | null,
  mutation: AudioEditTimelineMutation,
  nextDurationSec: number
): SongStructureAnalysis | null => {
  if (!structure) return null
  const durationSec = toFixedNumber(Math.max(0, nextDurationSec), 3)
  if (isV23SongStructure(structure)) {
    return {
      ...cloneJson(structure),
      durationSec,
      sections: shiftTimedSections(structure.sections, mutation)
    }
  }
  return {
    ...cloneJson(structure),
    durationSec,
    sections: shiftTimedSections(structure.sections, mutation)
  }
}
