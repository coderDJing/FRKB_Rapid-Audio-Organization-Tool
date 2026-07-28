import {
  normalizeSongBeatGridMapV2,
  projectSongBeatGridMapV2ToFixedGrid
} from './songBeatGridMapV2'
import type {
  HorizontalBrowseTransportBeatGridClipInput,
  HorizontalBrowseTransportBeatGridInput,
  HorizontalBrowseTransportRekordboxBeatGridEntryInput
} from './horizontalBrowseTransport'

type GridSource = {
  filePath?: unknown
  bpm?: unknown
  firstBeatMs?: unknown
  downbeatBeatOffset?: unknown
  timeBasisOffsetMs?: unknown
  beatGridMap?: unknown
  rekordboxGridEntries?: unknown
}

const normalizeRekordboxBeatGridEntries = (
  value: unknown
): HorizontalBrowseTransportRekordboxBeatGridEntryInput[] | undefined => {
  if (!Array.isArray(value) || value.length === 0) return undefined
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

export const resolveHorizontalBrowseTransportGrid = (source: GridSource) => {
  const v2Map = normalizeSongBeatGridMapV2(source.beatGridMap, { allowSingleClip: true })
  if (v2Map) {
    const projection = projectSongBeatGridMapV2ToFixedGrid(v2Map)
    const rekordboxBeatGridEntries =
      v2Map.source === 'rekordbox'
        ? normalizeRekordboxBeatGridEntries(source.rekordboxGridEntries)
        : undefined
    return {
      bpm: projection?.bpm ?? 0,
      firstBeatMs: projection?.firstBeatMs ?? 0,
      downbeatBeatOffset: projection?.downbeatBeatOffset ?? 0,
      beatGridClips: rekordboxBeatGridEntries
        ? undefined
        : v2Map.clips.map<HorizontalBrowseTransportBeatGridClipInput>((clip) => ({
            startSec: clip.startSec,
            anchorSec: clip.anchorSec,
            bpm: clip.bpm,
            downbeatBeatOffset: clip.downbeatBeatOffset
          })),
      rekordboxBeatGridEntries
    }
  }

  return {
    bpm: 0,
    firstBeatMs: 0,
    downbeatBeatOffset: 0,
    beatGridClips: undefined,
    rekordboxBeatGridEntries: undefined
  }
}

export const buildHorizontalBrowseTransportGridPayload = (
  source: GridSource
): HorizontalBrowseTransportBeatGridInput | null => {
  const filePath = String(source.filePath || '').trim()
  if (!filePath) return null
  const grid = resolveHorizontalBrowseTransportGrid(source)
  const timeBasisOffsetMs = Number(source.timeBasisOffsetMs)
  const hasTimeBasisOffsetMs = Number.isFinite(timeBasisOffsetMs) && timeBasisOffsetMs >= 0
  if (
    grid.bpm <= 0 &&
    !hasTimeBasisOffsetMs &&
    !grid.beatGridClips &&
    !grid.rekordboxBeatGridEntries
  )
    return null
  return {
    filePath,
    bpm: grid.bpm > 0 ? grid.bpm : undefined,
    firstBeatMs: grid.bpm > 0 ? grid.firstBeatMs : undefined,
    downbeatBeatOffset: grid.bpm > 0 ? grid.downbeatBeatOffset : undefined,
    beatGridClips: grid.beatGridClips,
    rekordboxBeatGridEntries: grid.rekordboxBeatGridEntries,
    timeBasisOffsetMs: hasTimeBasisOffsetMs ? timeBasisOffsetMs : undefined
  }
}
