import {
  normalizeSongBeatGridMapV2,
  projectSongBeatGridMapV2ToFixedGrid
} from './songBeatGridMapV2'
import type {
  HorizontalBrowseTransportBeatGridClipInput,
  HorizontalBrowseTransportBeatGridInput
} from './horizontalBrowseTransport'

type GridSource = {
  filePath?: unknown
  bpm?: unknown
  firstBeatMs?: unknown
  downbeatBeatOffset?: unknown
  timeBasisOffsetMs?: unknown
  beatGridMap?: unknown
}

export const resolveHorizontalBrowseTransportGrid = (source: GridSource) => {
  const v2Map = normalizeSongBeatGridMapV2(source.beatGridMap, { allowSingleClip: true })
  if (v2Map) {
    const projection = projectSongBeatGridMapV2ToFixedGrid(v2Map)
    return {
      bpm: projection?.bpm ?? 0,
      firstBeatMs: projection?.firstBeatMs ?? 0,
      downbeatBeatOffset: projection?.downbeatBeatOffset ?? 0,
      beatGridClips: v2Map.clips.map<HorizontalBrowseTransportBeatGridClipInput>((clip) => ({
        startSec: clip.startSec,
        anchorSec: clip.anchorSec,
        bpm: clip.bpm,
        downbeatBeatOffset: clip.downbeatBeatOffset
      }))
    }
  }

  return {
    bpm: 0,
    firstBeatMs: 0,
    downbeatBeatOffset: 0,
    beatGridClips: undefined
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
  if (grid.bpm <= 0 && !hasTimeBasisOffsetMs && !grid.beatGridClips) return null
  return {
    filePath,
    bpm: grid.bpm > 0 ? grid.bpm : undefined,
    firstBeatMs: grid.bpm > 0 ? grid.firstBeatMs : undefined,
    downbeatBeatOffset: grid.bpm > 0 ? grid.downbeatBeatOffset : undefined,
    beatGridClips: grid.beatGridClips,
    timeBasisOffsetMs: hasTimeBasisOffsetMs ? timeBasisOffsetMs : undefined
  }
}
