import type { SongBeatGridMapV2 } from '@shared/songBeatGridMapV2'
import {
  createUnifiedSongBeatGridRuntime,
  type UnifiedSongBeatGridRuntime,
  type UnifiedSongBeatGridRuntimeClip
} from '@shared/songBeatGridRuntime'
import {
  BPM_POINT_SEC_EPSILON,
  clampTrackTempoNumber,
  roundTrackTempoSec
} from '@renderer/composables/mixtape/trackTempoModel'
import type { TransportPlaybackSequence } from '@renderer/composables/mixtape/timelineTransportPlaybackSequence'

export type TransportDynamicTempoSegment = {
  key: string
  localStartSec: number
  localEndSec: number
  sourceStartSec: number
  sourceEndSec: number
  sourceBpm: number
  beatSec: number
  syncAnchorSec: number
}

const normalizeSegmentSec = (value: number) => roundTrackTempoSec(Math.max(0, Number(value) || 0))

const pushUniqueSec = (values: number[], value: number) => {
  const sec = normalizeSegmentSec(value)
  if (values.some((existing) => Math.abs(existing - sec) <= BPM_POINT_SEC_EPSILON)) return
  values.push(sec)
}

const resolveRuntimeClipAtSourceSec = (
  runtime: UnifiedSongBeatGridRuntime,
  sourceSecInput: number
): UnifiedSongBeatGridRuntimeClip | null => {
  const sourceSec = clampTrackTempoNumber(
    Number(sourceSecInput) || 0,
    0,
    Math.max(0, runtime.durationSec)
  )
  let left = 0
  let right = runtime.clips.length - 1
  let answer = runtime.clips[0] || null
  while (left <= right) {
    const middle = (left + right) >> 1
    const clip = runtime.clips[middle]
    if (!clip) break
    if (clip.startSec <= sourceSec + BPM_POINT_SEC_EPSILON) {
      answer = clip
      left = middle + 1
    } else {
      right = middle - 1
    }
  }
  return answer && sourceSec <= answer.endSec + BPM_POINT_SEC_EPSILON ? answer : null
}

const resolveClipAnchorSourceSec = (
  runtime: UnifiedSongBeatGridRuntime,
  clip: UnifiedSongBeatGridRuntimeClip
) => {
  const preferredLine =
    runtime.lines.find((line) => line.clipIndex === clip.index && line.level === 'downbeat') ||
    runtime.lines.find((line) => line.clipIndex === clip.index) ||
    null
  if (preferredLine) return preferredLine.sec
  return clampTrackTempoNumber(Number(clip.anchorSec) || 0, 0, runtime.durationSec)
}

const resolveDisplayLocalSec = (params: {
  sourceSec: number
  sequenceSegment: TransportPlaybackSequence['segments'][number]
  mapSourceToBaseLocal: (sourceSec: number) => number
}) => {
  const baseLocalSec = params.mapSourceToBaseLocal(params.sourceSec)
  return roundTrackTempoSec(
    params.sequenceSegment.localStartSec + (baseLocalSec - params.sequenceSegment.baseLocalStartSec)
  )
}

export const buildTransportDynamicTempoSegments = (params: {
  sourceBeatGridMap?: SongBeatGridMapV2 | null
  sourceDurationSec: number
  trackStartSec: number
  playbackSequence: TransportPlaybackSequence
  mapSourceToBaseLocal: (sourceSec: number) => number
}): TransportDynamicTempoSegment[] => {
  const sourceDurationSec = Math.max(0, Number(params.sourceDurationSec) || 0)
  const runtime = createUnifiedSongBeatGridRuntime(params.sourceBeatGridMap, sourceDurationSec)
  if (!runtime || runtime.clips.length <= 1 || !params.playbackSequence.segments.length) {
    return []
  }

  const segments: TransportDynamicTempoSegment[] = []
  for (const sequenceSegment of params.playbackSequence.segments) {
    const sourceStartSec = Math.max(0, Number(sequenceSegment.sourceStartSec) || 0)
    const sourceEndSec = Math.max(sourceStartSec, Number(sequenceSegment.sourceEndSec) || 0)
    if (sourceEndSec - sourceStartSec <= BPM_POINT_SEC_EPSILON) continue

    const boundaries = [normalizeSegmentSec(sourceStartSec), normalizeSegmentSec(sourceEndSec)]
    for (const clip of runtime.clips.slice(1)) {
      if (
        clip.startSec <= sourceStartSec + BPM_POINT_SEC_EPSILON ||
        clip.startSec >= sourceEndSec - BPM_POINT_SEC_EPSILON
      ) {
        continue
      }
      pushUniqueSec(boundaries, clip.startSec)
    }
    boundaries.sort((left, right) => left - right)

    for (let index = 1; index < boundaries.length; index += 1) {
      const segmentSourceStartSec = boundaries[index - 1]
      const segmentSourceEndSec = boundaries[index]
      if (segmentSourceEndSec - segmentSourceStartSec <= BPM_POINT_SEC_EPSILON) continue
      const clip = resolveRuntimeClipAtSourceSec(runtime, segmentSourceStartSec)
      if (!clip) continue
      const localStartSec = resolveDisplayLocalSec({
        sourceSec: segmentSourceStartSec,
        sequenceSegment,
        mapSourceToBaseLocal: params.mapSourceToBaseLocal
      })
      const localEndSec = resolveDisplayLocalSec({
        sourceSec: segmentSourceEndSec,
        sequenceSegment,
        mapSourceToBaseLocal: params.mapSourceToBaseLocal
      })
      if (localEndSec - localStartSec <= BPM_POINT_SEC_EPSILON) continue
      const anchorLocalSec = resolveDisplayLocalSec({
        sourceSec: resolveClipAnchorSourceSec(runtime, clip),
        sequenceSegment,
        mapSourceToBaseLocal: params.mapSourceToBaseLocal
      })
      segments.push({
        key: `${sequenceSegment.key}:clip-${clip.index}:${Math.round(segmentSourceStartSec * 1000)}-${Math.round(segmentSourceEndSec * 1000)}`,
        localStartSec,
        localEndSec,
        sourceStartSec: segmentSourceStartSec,
        sourceEndSec: segmentSourceEndSec,
        sourceBpm: clip.bpm,
        beatSec: clip.beatSec,
        syncAnchorSec: roundTrackTempoSec(params.trackStartSec + anchorLocalSec)
      })
    }
  }

  return segments.sort((left, right) => left.localStartSec - right.localStartSec)
}

export const hasTransportDynamicTempoSegments = (value: {
  dynamicTempoSegments?: TransportDynamicTempoSegment[]
}) => Array.isArray(value.dynamicTempoSegments) && value.dynamicTempoSegments.length > 0

export const resolveTransportDynamicTempoSegmentAtLocalSec = (
  segments: TransportDynamicTempoSegment[] | undefined,
  localSecInput: number
): TransportDynamicTempoSegment | null => {
  if (!Array.isArray(segments) || !segments.length) return null
  const localSec = Number(localSecInput)
  if (!Number.isFinite(localSec)) return null
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    const isLast = index === segments.length - 1
    if (localSec < segment.localStartSec - BPM_POINT_SEC_EPSILON) continue
    if (isLast && localSec <= segment.localEndSec + BPM_POINT_SEC_EPSILON) return segment
    if (localSec < segment.localEndSec - BPM_POINT_SEC_EPSILON) return segment
  }
  return null
}
