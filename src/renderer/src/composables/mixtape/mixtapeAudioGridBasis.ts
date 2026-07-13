import type { MixtapeTrack } from '@renderer/composables/mixtape/types'
import { normalizeSongBeatGridMap, type SongBeatGridMap } from '@shared/songBeatGridMap'

export const resolveMixtapeTimeBasisOffsetSec = (track: MixtapeTrack) => {
  const offsetMs = Number(track.timeBasisOffsetMs)
  if (!Number.isFinite(offsetMs) || offsetMs <= 0) return 0
  return offsetMs / 1000
}

export const resolveMixtapeAudioFirstBeatSec = (track: MixtapeTrack) => {
  const firstBeatMs = Number(track.firstBeatMs)
  if (!Number.isFinite(firstBeatMs)) return 0
  return Math.max(0, firstBeatMs / 1000 - resolveMixtapeTimeBasisOffsetSec(track))
}

export const resolveMixtapeAudioBeatGridMap = (
  track: MixtapeTrack,
  sourceDurationSec?: number
): SongBeatGridMap | null => {
  const map = track.beatGridMap
  if (!map) return null
  const offsetSec = resolveMixtapeTimeBasisOffsetSec(track)
  if (offsetSec <= 0) return map
  return normalizeSongBeatGridMap(
    {
      ...map,
      clips: map.clips.map((clip, index) => ({
        ...clip,
        startSec: index === 0 ? 0 : Math.max(0, clip.startSec - offsetSec),
        anchorSec: clip.anchorSec - offsetSec
      }))
    },
    {
      durationSec: sourceDurationSec,
      allowSingleClip: false,
      mergeContinuousClips: false
    }
  )
}
