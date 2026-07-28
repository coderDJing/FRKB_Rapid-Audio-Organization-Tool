import {
  normalizeSongBeatGridMapV2,
  type RekordboxBeatGridEntry,
  type SongBeatGridMapV2
} from '@shared/songBeatGridMapV2'

export const cloneSongBeatGridMapForHorizontalBrowseWorker = (
  value: unknown
): SongBeatGridMapV2 | null => {
  const map = normalizeSongBeatGridMapV2(value, { allowSingleClip: true })
  if (!map) return null
  return {
    version: map.version,
    source: map.source,
    signature: map.signature,
    clips: map.clips.map((clip) => ({
      startSec: clip.startSec,
      anchorSec: clip.anchorSec,
      bpm: clip.bpm,
      downbeatBeatOffset: clip.downbeatBeatOffset
    }))
  }
}

export const cloneRekordboxBeatGridEntriesForHorizontalBrowseWorker = (
  value: unknown
): RekordboxBeatGridEntry[] | undefined => {
  if (!Array.isArray(value) || value.length < 2) return undefined
  const entries = value
    .map((entry) => {
      const record = entry && typeof entry === 'object' ? entry : {}
      return {
        timeMs: Number((record as { timeMs?: unknown }).timeMs),
        bpm: Number((record as { bpm?: unknown }).bpm),
        beatNumber: Number((record as { beatNumber?: unknown }).beatNumber)
      }
    })
    .filter(
      (entry) =>
        Number.isFinite(entry.timeMs) &&
        entry.timeMs >= 0 &&
        Number.isFinite(entry.bpm) &&
        entry.bpm > 0 &&
        Number.isInteger(entry.beatNumber) &&
        entry.beatNumber >= 1 &&
        entry.beatNumber <= 4
    )
    .sort((left, right) => left.timeMs - right.timeMs)
  if (
    entries.length < 2 ||
    entries.some((entry, index) => index > 0 && entry.timeMs <= entries[index - 1].timeMs)
  ) {
    return undefined
  }
  return entries
}
