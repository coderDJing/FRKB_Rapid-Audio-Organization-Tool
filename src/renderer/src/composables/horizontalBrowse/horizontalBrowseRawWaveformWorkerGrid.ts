import { normalizeSongBeatGridMapV2, type SongBeatGridMapV2 } from '@shared/songBeatGridMapV2'

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
