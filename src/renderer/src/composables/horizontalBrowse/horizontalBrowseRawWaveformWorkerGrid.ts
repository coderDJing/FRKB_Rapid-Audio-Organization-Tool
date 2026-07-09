import { normalizeSongBeatGridMap, type SongBeatGridMap } from '@shared/songBeatGridMap'

export const cloneSongBeatGridMapForHorizontalBrowseWorker = (
  value: unknown
): SongBeatGridMap | null => {
  const map = normalizeSongBeatGridMap(value)
  if (!map) return null
  return {
    version: map.version,
    source: map.source,
    signature: map.signature,
    clips: map.clips.map((clip) => ({
      startSec: clip.startSec,
      anchorSec: clip.anchorSec,
      bpm: clip.bpm,
      barBeatOffset: clip.barBeatOffset
    }))
  }
}
