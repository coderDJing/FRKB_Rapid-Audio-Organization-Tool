import {
  AUDIO_EDIT_SECONDS_DECIMALS,
  AUDIO_EDIT_EPSILON_SEC,
  isIdentityAudioEditClips,
  roundAudioEditSec,
  type AudioEditClip
} from './audioEditTimeline'
import {
  createSongBeatGridMapV2FromClips,
  createSongBeatGridMapV2FromFixedGrid,
  normalizeSongBeatGridMapV2,
  type SongBeatGridClipV2,
  type SongBeatGridMapV2
} from './songBeatGridMapV2'
import { resolveNearestUnifiedSongBeatGridLine } from './songBeatGridRuntime'

const clipLengthSec = (clip: AudioEditClip) =>
  roundAudioEditSec(Math.max(0, clip.sourceEndSec - clip.sourceStartSec))

const roundSignedAudioEditGridSec = (value: number) =>
  Number((Number.isFinite(value) ? value : 0).toFixed(AUDIO_EDIT_SECONDS_DECIMALS))

const snapToClipBeat = (sec: number, anchorSec: number, bpm: number) => {
  const beatSec = 60 / bpm
  if (!(beatSec > 0) || !Number.isFinite(beatSec)) return roundAudioEditSec(sec)
  const beatIndex = Math.round((sec - anchorSec) / beatSec)
  return roundAudioEditSec(anchorSec + beatIndex * beatSec)
}

export const snapAudioEditSecToBeatGrid = (params: {
  planSec: number
  durationSec: number
  beatGridMap?: unknown
  bpm?: unknown
  firstBeatMs?: unknown
}) => {
  const durationSec = Math.max(0, Number(params.durationSec) || 0)
  const clamped = Math.max(0, Math.min(durationSec, Number(params.planSec) || 0))
  const line = resolveNearestUnifiedSongBeatGridLine(params.beatGridMap, durationSec, clamped)
  if (line) return roundAudioEditSec(Math.max(0, Math.min(durationSec, line.sec)))
  const bpm = Number(params.bpm)
  if (!(bpm > 0)) return roundAudioEditSec(clamped)
  const firstBeatSec = Math.max(0, Number(params.firstBeatMs) || 0) / 1000
  return roundAudioEditSec(
    Math.max(0, Math.min(durationSec, snapToClipBeat(clamped, firstBeatSec, bpm)))
  )
}

export const projectAudioEditBeatGridMap = (
  map: SongBeatGridMapV2 | null | undefined,
  clips: readonly AudioEditClip[],
  sourceDurationSec: number
): SongBeatGridMapV2 | null => {
  const normalized = normalizeSongBeatGridMapV2(map, { allowSingleClip: true })
  if (!normalized) return null
  const safeSourceDurationSec = Math.max(0, Number(sourceDurationSec) || 0)
  if (
    !clips.length ||
    !(safeSourceDurationSec > AUDIO_EDIT_EPSILON_SEC) ||
    isIdentityAudioEditClips(clips, safeSourceDurationSec)
  ) {
    return normalized
  }

  const sourceClips = normalized.clips
  const projected: SongBeatGridClipV2[] = []
  let planCursorSec = 0
  for (const audioClip of clips) {
    const audioLengthSec = clipLengthSec(audioClip)
    if (audioLengthSec <= AUDIO_EDIT_EPSILON_SEC) continue
    const shiftSec = planCursorSec - audioClip.sourceStartSec
    for (let index = 0; index < sourceClips.length; index += 1) {
      const gridClip = sourceClips[index]
      const gridEndSec =
        index + 1 < sourceClips.length ? sourceClips[index + 1].startSec : safeSourceDurationSec
      const overlapStartSec = Math.max(gridClip.startSec, audioClip.sourceStartSec)
      const overlapEndSec = Math.min(gridEndSec, audioClip.sourceEndSec)
      if (overlapEndSec - overlapStartSec <= AUDIO_EDIT_EPSILON_SEC) continue
      projected.push({
        startSec: roundAudioEditSec(overlapStartSec + shiftSec),
        // Grid anchors may legitimately fall before the edited plan start. Keeping that
        // negative phase is what makes a cut on a whole number of beats stay aligned.
        anchorSec: roundSignedAudioEditGridSec(gridClip.anchorSec + shiftSec),
        bpm: gridClip.bpm,
        downbeatBeatOffset: gridClip.downbeatBeatOffset
      })
    }
    planCursorSec = roundAudioEditSec(planCursorSec + audioLengthSec)
  }
  if (!projected.length) return null
  projected[0] = { ...projected[0], startSec: 0 }
  return createSongBeatGridMapV2FromClips(projected, normalized.source, { allowSingleClip: true })
}

export const resolveAudioEditDisplayBeatGridMap = (params: {
  sourceMap: SongBeatGridMapV2 | null | undefined
  clips: readonly AudioEditClip[] | null | undefined
  sourceDurationSec: number
  fallback?: {
    bpm?: unknown
    firstBeatMs?: unknown
    downbeatBeatOffset?: unknown
  }
}): SongBeatGridMapV2 | null => {
  const sourceMap = normalizeSongBeatGridMapV2(params.sourceMap, { allowSingleClip: true }) ?? null
  const clips = params.clips
  const sourceDurationSec = Math.max(0, Number(params.sourceDurationSec) || 0)
  if (
    !clips?.length ||
    !(sourceDurationSec > AUDIO_EDIT_EPSILON_SEC) ||
    isIdentityAudioEditClips(clips, sourceDurationSec)
  ) {
    return sourceMap
  }
  const mapToProject =
    sourceMap ??
    createSongBeatGridMapV2FromFixedGrid({
      bpm: params.fallback?.bpm,
      firstBeatMs: params.fallback?.firstBeatMs,
      downbeatBeatOffset: params.fallback?.downbeatBeatOffset
    })
  return projectAudioEditBeatGridMap(mapToProject, clips, sourceDurationSec)
}
