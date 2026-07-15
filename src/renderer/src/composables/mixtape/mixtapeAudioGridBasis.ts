import type { MixtapeTrack } from '@renderer/composables/mixtape/types'
import {
  normalizeSongBeatGridMapV2,
  projectSongBeatGridMapV2ToFixedGrid,
  type SongBeatGridMapV2
} from '@shared/songBeatGridMapV2'

export const resolveMixtapeTimeBasisOffsetSec = (track: MixtapeTrack) => {
  const offsetMs = Number(track.timeBasisOffsetMs)
  if (!Number.isFinite(offsetMs) || offsetMs <= 0) return 0
  return offsetMs / 1000
}

export const resolveMixtapeAudioFirstBeatSec = (track: MixtapeTrack) => {
  const map = resolveMixtapeAudioBeatGridMap(track)
  const firstBeatMs = projectSongBeatGridMapV2ToFixedGrid(map)?.firstBeatMs
  if (!Number.isFinite(firstBeatMs)) return 0
  return Math.max(0, Number(firstBeatMs) / 1000)
}

export const resolveMixtapeAudioBeatGridMap = (
  track: MixtapeTrack,
  sourceDurationSec?: number
): SongBeatGridMapV2 | null => {
  const map = track.beatGridMap
  if (!map) return null
  const mapV2 = normalizeSongBeatGridMapV2(map, { allowSingleClip: true })
  const offsetSec = resolveMixtapeTimeBasisOffsetSec(track)
  if (mapV2) {
    if (offsetSec <= 0) return mapV2
    return normalizeSongBeatGridMapV2(
      {
        ...mapV2,
        clips: mapV2.clips.map((clip, index) => ({
          ...clip,
          startSec: index === 0 ? 0 : Math.max(0, clip.startSec - offsetSec),
          anchorSec: clip.anchorSec - offsetSec
        }))
      },
      {
        durationSec: sourceDurationSec,
        allowSingleClip: true,
        mergeContinuousClips: false
      }
    )
  }
  return null
}
