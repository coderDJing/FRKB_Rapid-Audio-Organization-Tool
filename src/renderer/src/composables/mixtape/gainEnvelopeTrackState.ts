import { buildTrackRuntimeTempoSnapshot } from '@renderer/composables/mixtape/trackRuntimeTempoSnapshot'
import {
  MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM,
  normalizeMixEnvelopePoints,
  sampleMixEnvelopeAtSec
} from '@renderer/composables/mixtape/gainEnvelope'
import { snapSecToVisibleGrid as snapSecToVisibleGridByUtils } from '@renderer/composables/mixtape/gainEnvelopeEditorGrid'
import {
  STEM_SEGMENT_ACTIVE_GAIN,
  STEM_SEGMENT_MUTE_THRESHOLD
} from '@renderer/composables/mixtape/gainEnvelopeStemSegments'
import { normalizeVolumeMuteSegments } from '@renderer/composables/mixtape/volumeMuteSegments'
import type {
  MixtapeEnvelopeParamId,
  MixtapeGainPoint,
  MixtapeMuteSegment,
  MixtapeTrack
} from '@renderer/composables/mixtape/types'

const VOLUME_MUTE_SEGMENT_EPSILON = 0.0001
const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export const createGainEnvelopeTrackStateModule = (params: {
  tracks: { value: MixtapeTrack[] }
  resolveRenderZoom: () => number
  resolveTrackDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackSourceDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackFirstBeatSeconds: (track: MixtapeTrack) => number
  isStemSegmentParam: (param: MixtapeEnvelopeParamId) => boolean
}) => {
  const resolveDynamicVisibleGridLines = (track: MixtapeTrack, durationSec: number) => {
    const sourceDurationSec = Math.max(
      0,
      Number(params.resolveTrackSourceDurationSeconds(track)) || 0
    )
    return buildTrackRuntimeTempoSnapshot({
      track,
      sourceDurationSec,
      durationSec,
      zoom: params.resolveRenderZoom()
    }).visibleGridLines
  }

  const resolveVisibleGridSegments = (track: MixtapeTrack, durationSec: number) => {
    const safeDurationSec = Math.max(0, Number(durationSec) || 0)
    if (!safeDurationSec) return [] as MixtapeMuteSegment[]
    const boundaries = Array.from(
      new Set(
        [
          0,
          ...resolveDynamicVisibleGridLines(track, safeDurationSec).map((line) => line.sec),
          safeDurationSec
        ]
          .map((sec) => Number(sec.toFixed(4)))
          .filter((sec) => Number.isFinite(sec) && sec >= 0 && sec <= safeDurationSec)
      )
    ).sort((a, b) => a - b)
    const segments: MixtapeMuteSegment[] = []
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const startSec = boundaries[index]
      const endSec = boundaries[index + 1]
      if (endSec - startSec <= VOLUME_MUTE_SEGMENT_EPSILON) continue
      segments.push({
        startSec: Number(startSec.toFixed(4)),
        endSec: Number(endSec.toFixed(4))
      })
    }
    return segments
  }

  const resolveVolumeMuteGrid = (track: MixtapeTrack, durationSec: number) => {
    const segments = resolveVisibleGridSegments(track, durationSec)
    if (!segments.length) return null
    return {
      durationSec: Math.max(0, Number(durationSec) || 0),
      segments
    }
  }

  const resolveGridAlignedVolumeMuteSegments = (
    track: MixtapeTrack,
    durationSec: number,
    value: unknown
  ) => {
    const normalized = normalizeVolumeMuteSegments(value, durationSec)
    if (!normalized.length) return [] as MixtapeMuteSegment[]
    const segments = resolveVisibleGridSegments(track, durationSec)
    if (!segments.length) return normalized
    return segments.filter((segment: MixtapeMuteSegment) =>
      normalized.some(
        (item: MixtapeMuteSegment) =>
          Math.min(segment.endSec, item.endSec) - Math.max(segment.startSec, item.startSec) >
          VOLUME_MUTE_SEGMENT_EPSILON
      )
    )
  }

  const resolveVolumeMuteSegmentBySec = (payload: {
    track: MixtapeTrack
    durationSec: number
    sec: number
  }) => {
    const segments = resolveVisibleGridSegments(payload.track, payload.durationSec)
    if (!segments.length) return null
    const maxSelectableSec = Math.max(0, payload.durationSec - VOLUME_MUTE_SEGMENT_EPSILON)
    const safeSec = clampNumber(Number(payload.sec) || 0, 0, maxSelectableSec)
    for (const segment of segments) {
      const isLast =
        Math.abs(segment.endSec - Number(payload.durationSec)) <= VOLUME_MUTE_SEGMENT_EPSILON
      if (safeSec < segment.startSec - VOLUME_MUTE_SEGMENT_EPSILON) continue
      if (safeSec < segment.endSec - VOLUME_MUTE_SEGMENT_EPSILON || isLast) {
        return segment
      }
    }
    return segments[segments.length - 1] || null
  }

  const snapSecToVisibleGrid = (payload: {
    track: MixtapeTrack
    sec: number
    durationSec: number
    minSec?: number
    maxSec?: number
  }) => {
    const sourceDurationSec = Math.max(
      0,
      Number(params.resolveTrackSourceDurationSeconds(payload.track)) || 0
    )
    const snapshot = buildTrackRuntimeTempoSnapshot({
      track: payload.track,
      sourceDurationSec,
      durationSec: payload.durationSec,
      zoom: params.resolveRenderZoom()
    })
    const nearest = snapshot.timeMap.resolveNearestGridLine(
      payload.sec,
      params.resolveRenderZoom(),
      {
        minLocalSec: payload.minSec,
        maxLocalSec: payload.maxSec
      }
    )
    if (nearest) return nearest.sec
    return snapSecToVisibleGridByUtils({
      ...payload,
      zoom: params.resolveRenderZoom(),
      firstBeatSec: Math.max(0, Number(params.resolveTrackFirstBeatSeconds(payload.track)) || 0)
    })
  }

  const resolveTrackEnvelopeState = (trackId: string, param: MixtapeEnvelopeParamId) => {
    const safeTrackId = String(trackId || '').trim()
    const track = params.tracks.value.find((item) => item.id === safeTrackId) || null
    if (!track) {
      return {
        track: null,
        durationSec: 0,
        points: [] as MixtapeGainPoint[]
      }
    }
    const rawDurationSec = params.resolveTrackDurationSeconds(track)
    const durationSec =
      Number.isFinite(rawDurationSec) && rawDurationSec > 0 ? Math.max(0, rawDurationSec) : 0
    const envelopeField = MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param]
    const points = normalizeMixEnvelopePoints(param, (track as any)?.[envelopeField], durationSec)
    return {
      track,
      durationSec,
      points
    }
  }

  const resolveTrackVolumeMuteState = (trackId: string) => {
    const safeTrackId = String(trackId || '').trim()
    const track = params.tracks.value.find((item) => item.id === safeTrackId) || null
    if (!track) {
      return {
        track: null,
        durationSec: 0,
        segments: [] as MixtapeMuteSegment[]
      }
    }
    const rawDurationSec = params.resolveTrackDurationSeconds(track)
    const durationSec =
      Number.isFinite(rawDurationSec) && rawDurationSec > 0 ? Math.max(0, rawDurationSec) : 0
    const segments = resolveGridAlignedVolumeMuteSegments(
      track,
      durationSec,
      track.volumeMuteSegments
    )
    return {
      track,
      durationSec,
      segments
    }
  }

  const resolveTrackStemSegmentState = (trackId: string, param: MixtapeEnvelopeParamId) => {
    const envelopeState = resolveTrackEnvelopeState(trackId, param)
    const { track, durationSec, points } = envelopeState
    if (!track || !durationSec) {
      return {
        track: null,
        durationSec: 0,
        segments: [] as MixtapeMuteSegment[]
      }
    }
    if (!params.isStemSegmentParam(param)) {
      return {
        track,
        durationSec,
        segments: [] as MixtapeMuteSegment[]
      }
    }
    const grid = resolveVolumeMuteGrid(track, durationSec)
    if (!grid) {
      return {
        track,
        durationSec,
        segments: [] as MixtapeMuteSegment[]
      }
    }
    const epsilon = 0.0001
    const maxSelectableSec = Math.max(0, durationSec - epsilon)
    const mutedSegments: MixtapeMuteSegment[] = []
    for (const gridSegment of grid.segments) {
      const centerSec = Number(((gridSegment.startSec + gridSegment.endSec) / 2).toFixed(4))
      if (centerSec > maxSelectableSec + epsilon) continue
      const segment = resolveVolumeMuteSegmentBySec({
        track,
        durationSec,
        sec: centerSec
      })
      if (!segment) continue
      const sampleSec = Number(((segment.startSec + segment.endSec) / 2).toFixed(4))
      const gain = sampleMixEnvelopeAtSec(param, points, sampleSec, STEM_SEGMENT_ACTIVE_GAIN)
      if (gain > STEM_SEGMENT_MUTE_THRESHOLD) continue
      mutedSegments.push(segment)
    }
    const segments = resolveGridAlignedVolumeMuteSegments(track, durationSec, mutedSegments)
    return {
      track,
      durationSec,
      segments
    }
  }

  return {
    resolveDynamicVisibleGridLines,
    resolveVisibleGridSegments,
    resolveVolumeMuteGrid,
    resolveGridAlignedVolumeMuteSegments,
    resolveVolumeMuteSegmentBySec,
    snapSecToVisibleGrid,
    resolveTrackEnvelopeState,
    resolveTrackVolumeMuteState,
    resolveTrackStemSegmentState
  }
}
