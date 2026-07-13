import {
  normalizeBeatOffset,
  resolveBeatSecByBpm
} from '@renderer/composables/mixtape/beatSyncModel'
import { sampleMixtapeMasterGridBpmAtSec } from '@renderer/composables/mixtape/mixtapeMasterGrid'
import {
  resolveMixtapeAudioBeatGridMap,
  resolveMixtapeAudioFirstBeatSec
} from '@renderer/composables/mixtape/mixtapeAudioGridBasis'
import {
  clampTrackTempoNumber,
  BPM_POINT_SEC_EPSILON,
  buildFlatTrackBpmEnvelope,
  normalizeTrackBpmValue,
  normalizeTrackBpmEnvelopePoints,
  resolveTrackGridSourceBpm,
  resolveTrackBpmEnvelopeClampRange,
  roundTrackTempoSec
} from '@renderer/composables/mixtape/trackTempoModel'
import { createDynamicSourceBeatMap } from '@renderer/composables/mixtape/trackTimeMapCore'
import { buildMixtapeTrackLoopSections } from '@renderer/composables/mixtape/mixtapeTrackLoop'
import type { MixtapeBpmPoint, MixtapeTrack } from '@renderer/composables/mixtape/types'

const AUTO_BPM_POINT_SOURCE = 'auto' as const

const resolveTrackStartSec = (track: MixtapeTrack) => {
  const numeric = Number(track.startSec)
  if (!Number.isFinite(numeric) || numeric < 0) return 0
  return Number(numeric.toFixed(4))
}

export const resolveDefaultGlobalBpmFromTracks = (tracks: MixtapeTrack[]) => {
  for (const track of tracks) {
    const candidates = [track.bpm, track.gridBaseBpm, track.originalBpm]
    for (const candidate of candidates) {
      const normalized = normalizeTrackBpmValue(candidate)
      if (normalized !== null) return normalized
    }
  }
  return 128
}

export const buildFlatMixtapeGlobalBpmEnvelope = (durationSec: number, bpm: number) =>
  buildFlatTrackBpmEnvelope(durationSec, normalizeTrackBpmValue(bpm) ?? 128).map((point) => ({
    sec: Number(point.sec),
    bpm: Number(point.bpm)
  }))

const markGeneratedBpmEnvelopePoints = (points: MixtapeBpmPoint[]) =>
  points.map((point) => ({
    ...point,
    source: AUTO_BPM_POINT_SOURCE
  }))

const resolveTrackLoopValue = (track: MixtapeTrack) =>
  Array.isArray(track.loopSegments) && track.loopSegments.length
    ? track.loopSegments
    : track.loopSegment

const resolveTrackVisibleSourceSections = (track: MixtapeTrack, sourceDurationSec: number) =>
  buildMixtapeTrackLoopSections(sourceDurationSec, resolveTrackLoopValue(track)).filter(
    (section) =>
      section.displayEndSec > section.displayStartSec + BPM_POINT_SEC_EPSILON &&
      section.baseEndSec > section.baseStartSec + BPM_POINT_SEC_EPSILON
  )

const resolveTrackVisibleSourceDisplayDuration = (track: MixtapeTrack, sourceDurationSec: number) =>
  Math.max(
    0,
    ...buildMixtapeTrackLoopSections(sourceDurationSec, resolveTrackLoopValue(track)).map(
      (section) => Number(section.displayEndSec) || 0
    )
  )

const resolveRuntimeClipBpmAtSourceSec = (
  clips: Array<{ startSec: number; endSec: number; bpm: number }>,
  sourceSecInput: number
) => {
  if (!clips.length) return null
  const sourceSec = Math.max(0, Number(sourceSecInput) || 0)
  let resolved = clips[0] || null
  for (const clip of clips) {
    if (sourceSec < clip.startSec - BPM_POINT_SEC_EPSILON) break
    if (sourceSec <= clip.endSec + BPM_POINT_SEC_EPSILON) {
      resolved = clip
    }
  }
  return normalizeTrackBpmValue(resolved?.bpm) ?? null
}

const pushGeneratedBpmPoint = (
  points: MixtapeBpmPoint[],
  sec: number,
  bpm: number,
  fallbackBpm: number
) => {
  points.push({
    sec: roundTrackTempoSec(sec),
    bpm: normalizeTrackBpmValue(bpm) ?? fallbackBpm,
    source: AUTO_BPM_POINT_SOURCE
  })
}

type GeneratedTrackBpmEnvelope = {
  order: number
  startSec: number
  endSec: number
  points: MixtapeBpmPoint[]
}

const resolveGeneratedTrackBpmAtSec = (envelope: GeneratedTrackBpmEnvelope, sec: number) =>
  sampleMixtapeMasterGridBpmAtSec(
    envelope.points,
    sec,
    normalizeTrackBpmValue(envelope.points[0]?.bpm) ?? 128
  )

/**
 * A master tempo lane can only describe one tempo at a time. When two tracks overlap,
 * it keeps the outgoing BPM at the incoming track's start and ramps both tracks to the
 * incoming BPM by the end of that overlap.
 */
const buildGeneratedGlobalBpmPoints = (params: {
  envelopes: GeneratedTrackBpmEnvelope[]
  durationSec: number
  fallbackBpm: number
}) => {
  const safeDurationSec = Math.max(0, Number(params.durationSec) || 0)
  const orderedEnvelopes = [...params.envelopes].sort((left, right) => {
    if (Math.abs(left.startSec - right.startSec) > BPM_POINT_SEC_EPSILON) {
      return left.startSec - right.startSec
    }
    return left.order - right.order
  })
  let points: MixtapeBpmPoint[] = []
  const pushPoint = (secInput: number, bpm: number) => {
    const sec = roundTrackTempoSec(secInput)
    const previous = points[points.length - 1]
    if (
      previous &&
      Math.abs(previous.sec - sec) <= BPM_POINT_SEC_EPSILON &&
      Math.abs(previous.bpm - bpm) <= 0.000001
    ) {
      return
    }
    points.push({ sec, bpm, source: AUTO_BPM_POINT_SOURCE })
  }

  const appendEnvelopePoints = (envelope: GeneratedTrackBpmEnvelope, fromSec: number) => {
    for (const point of envelope.points) {
      const sec = roundTrackTempoSec(Number(point.sec))
      if (sec < fromSec - BPM_POINT_SEC_EPSILON || sec > safeDurationSec) continue
      pushPoint(sec, resolveGeneratedTrackBpmAtSec(envelope, sec))
    }
  }

  for (const [index, envelope] of orderedEnvelopes.entries()) {
    if (!points.length) {
      appendEnvelopePoints(envelope, envelope.startSec)
      continue
    }
    const outgoing = orderedEnvelopes
      .slice(0, index)
      .filter((candidate) => candidate.endSec > envelope.startSec + BPM_POINT_SEC_EPSILON)
      .at(-1)
    if (!outgoing) {
      appendEnvelopePoints(envelope, envelope.startSec)
      continue
    }

    const transitionStartSec = envelope.startSec
    const transitionEndSec = Math.min(outgoing.endSec, envelope.endSec)
    const transitionStartBpm = sampleMixtapeMasterGridBpmAtSec(
      points,
      transitionStartSec,
      params.fallbackBpm
    )
    points = points.filter((point) => point.sec < transitionStartSec - BPM_POINT_SEC_EPSILON)
    pushPoint(transitionStartSec, transitionStartBpm)
    pushPoint(transitionEndSec, resolveGeneratedTrackBpmAtSec(envelope, transitionEndSec))
    appendEnvelopePoints(envelope, transitionEndSec + BPM_POINT_SEC_EPSILON)
  }

  if (!points.length) return buildFlatMixtapeGlobalBpmEnvelope(safeDurationSec, params.fallbackBpm)
  const last = points[points.length - 1]
  if (Math.abs(last.sec - safeDurationSec) > BPM_POINT_SEC_EPSILON) {
    points.push({
      sec: safeDurationSec,
      bpm: last.bpm,
      source: AUTO_BPM_POINT_SOURCE
    })
  }
  return points
}

const appendGeneratedDynamicTrackBpmPoints = (params: {
  track: MixtapeTrack
  startSec: number
  sourceDurationSec: number
  defaultBpm: number
  points: MixtapeBpmPoint[]
}) => {
  const dynamicSourceBeatMap = createDynamicSourceBeatMap(
    resolveMixtapeAudioBeatGridMap(params.track, params.sourceDurationSec),
    params.sourceDurationSec
  )
  if (!dynamicSourceBeatMap) return null
  const sections = resolveTrackVisibleSourceSections(params.track, params.sourceDurationSec)
  const firstSourceSec = sections[0]?.baseStartSec ?? 0
  const firstClipBpm = dynamicSourceBeatMap.runtime.clips[0]?.bpm ?? params.defaultBpm
  const sourceAnchorBpm =
    resolveRuntimeClipBpmAtSourceSec(dynamicSourceBeatMap.runtime.clips, firstSourceSec) ??
    normalizeTrackBpmValue(firstClipBpm) ??
    params.defaultBpm
  const targetAnchorBpm =
    normalizeTrackBpmValue(params.track.gridBaseBpm) ??
    normalizeTrackBpmValue(params.track.originalBpm) ??
    normalizeTrackBpmValue(params.track.bpm) ??
    sourceAnchorBpm
  const scale = clampTrackTempoNumber(
    targetAnchorBpm / Math.max(BPM_POINT_SEC_EPSILON, sourceAnchorBpm),
    0.25,
    4
  )
  const scaleDivisor = Math.max(BPM_POINT_SEC_EPSILON, scale)
  let trackEndSec = params.startSec
  let appended = false

  for (const section of sections) {
    const sectionTimelineStartSec = roundTrackTempoSec(
      params.startSec + section.displayStartSec / scaleDivisor
    )
    const sectionTimelineEndSec = roundTrackTempoSec(
      params.startSec + section.displayEndSec / scaleDivisor
    )
    if (sectionTimelineEndSec <= sectionTimelineStartSec + BPM_POINT_SEC_EPSILON) continue
    const sectionStartBpm =
      resolveRuntimeClipBpmAtSourceSec(dynamicSourceBeatMap.runtime.clips, section.baseStartSec) ??
      sourceAnchorBpm
    pushGeneratedBpmPoint(
      params.points,
      sectionTimelineStartSec,
      sectionStartBpm * scale,
      params.defaultBpm
    )

    for (const clip of dynamicSourceBeatMap.runtime.clips.slice(1)) {
      const boundarySourceSec = Number(clip.startSec)
      if (boundarySourceSec <= section.baseStartSec + BPM_POINT_SEC_EPSILON) continue
      if (boundarySourceSec >= section.baseEndSec - BPM_POINT_SEC_EPSILON) continue
      const boundaryTimelineSec = roundTrackTempoSec(
        sectionTimelineStartSec + (boundarySourceSec - section.baseStartSec) / scaleDivisor
      )
      const previousBpm =
        resolveRuntimeClipBpmAtSourceSec(
          dynamicSourceBeatMap.runtime.clips,
          boundarySourceSec - BPM_POINT_SEC_EPSILON * 2
        ) ?? sectionStartBpm
      const nextBpm =
        resolveRuntimeClipBpmAtSourceSec(dynamicSourceBeatMap.runtime.clips, boundarySourceSec) ??
        previousBpm
      pushGeneratedBpmPoint(
        params.points,
        boundaryTimelineSec,
        previousBpm * scale,
        params.defaultBpm
      )
      pushGeneratedBpmPoint(params.points, boundaryTimelineSec, nextBpm * scale, params.defaultBpm)
    }

    const sectionEndBpm =
      resolveRuntimeClipBpmAtSourceSec(
        dynamicSourceBeatMap.runtime.clips,
        section.baseEndSec - BPM_POINT_SEC_EPSILON * 2
      ) ?? sectionStartBpm
    pushGeneratedBpmPoint(
      params.points,
      sectionTimelineEndSec,
      sectionEndBpm * scale,
      params.defaultBpm
    )
    trackEndSec = Math.max(trackEndSec, sectionTimelineEndSec)
    appended = true
  }

  return appended ? trackEndSec : null
}

const resolveTrackVisibleAnchorLocalSec = (params: {
  track: MixtapeTrack
  resolveTrackSourceDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackFirstBeatSeconds: (track: MixtapeTrack) => number
}) => {
  const track = params.track
  const gridSourceBpm = resolveTrackGridSourceBpm(track)
  const beatSourceSec = Math.max(BPM_POINT_SEC_EPSILON, resolveBeatSecByBpm(gridSourceBpm))
  if (!Number.isFinite(beatSourceSec) || beatSourceSec <= BPM_POINT_SEC_EPSILON) return null
  const sourceDurationSec = Math.max(
    0,
    Number(params.resolveTrackSourceDurationSeconds(track)) || 0
  )
  const sourceDurationBeats = sourceDurationSec / beatSourceSec
  const firstBeatSourceSec = resolveMixtapeAudioFirstBeatSec(track)
  const firstBeatSourceBeats = firstBeatSourceSec / beatSourceSec
  const normalizedBarBeatOffset = normalizeBeatOffset(track.barBeatOffset, 32)
  const firstBarLineSourceBeats = firstBeatSourceBeats + normalizedBarBeatOffset
  const hasVisibleBarLine = firstBarLineSourceBeats <= sourceDurationBeats + BPM_POINT_SEC_EPSILON
  const currentBeatSec = Math.max(
    BPM_POINT_SEC_EPSILON,
    resolveBeatSecByBpm(Number(track.bpm) || gridSourceBpm)
  )
  const firstBeatLocalSec = Math.max(0, Number(params.resolveTrackFirstBeatSeconds(track)) || 0)
  return roundTrackTempoSec(
    hasVisibleBarLine
      ? firstBeatLocalSec + normalizedBarBeatOffset * currentBeatSec
      : firstBeatLocalSec
  )
}

export const resolveDefaultMixtapeGlobalGridPhaseOffsetSec = (params: {
  tracks: MixtapeTrack[]
  resolveTrackSourceDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackFirstBeatSeconds: (track: MixtapeTrack) => number
}) => {
  const orderedTracks = [...params.tracks].sort((left, right) => {
    const leftStartSec = Number(left.startSec)
    const rightStartSec = Number(right.startSec)
    const leftHasExplicitStartSec = Number.isFinite(leftStartSec)
    const rightHasExplicitStartSec = Number.isFinite(rightStartSec)
    if (leftHasExplicitStartSec && rightHasExplicitStartSec) {
      if (Math.abs(leftStartSec - rightStartSec) > BPM_POINT_SEC_EPSILON) {
        return leftStartSec - rightStartSec
      }
    } else if (leftHasExplicitStartSec !== rightHasExplicitStartSec) {
      return leftHasExplicitStartSec ? -1 : 1
    }
    return (Number(left.mixOrder) || 0) - (Number(right.mixOrder) || 0)
  })
  for (const track of orderedTracks) {
    const localAnchorSec = resolveTrackVisibleAnchorLocalSec({
      track,
      resolveTrackSourceDurationSeconds: params.resolveTrackSourceDurationSeconds,
      resolveTrackFirstBeatSeconds: params.resolveTrackFirstBeatSeconds
    })
    if (localAnchorSec === null) continue
    return roundTrackTempoSec(resolveTrackStartSec(track) + localAnchorSec)
  }
  return 0
}

export const buildDefaultMixtapeGlobalBpmEnvelopeSnapshot = (params: {
  tracks: MixtapeTrack[]
  resolveTrackDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackSourceDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackFirstBeatSeconds: (track: MixtapeTrack) => number
}) => {
  const defaultBpm = resolveDefaultGlobalBpmFromTracks(params.tracks)
  const tracksHaveMaterializedStarts = params.tracks.every((track) => {
    const startSec = Number(track.startSec)
    return Number.isFinite(startSec) && startSec >= 0
  })
  const generatedEnvelopes: GeneratedTrackBpmEnvelope[] = []
  let durationSec = 0
  if (tracksHaveMaterializedStarts) {
    for (const [order, track] of params.tracks.entries()) {
      const startSec = resolveTrackStartSec(track)
      const sourceDurationSec = Math.max(
        0,
        Number(params.resolveTrackSourceDurationSeconds(track)) || 0
      )
      const fallbackDurationSec = Math.max(
        0,
        Number(params.resolveTrackDurationSeconds(track)) || 0
      )
      const trackPoints: MixtapeBpmPoint[] = []
      const dynamicTrackEndSec = appendGeneratedDynamicTrackBpmPoints({
        track,
        startSec,
        sourceDurationSec,
        defaultBpm,
        points: trackPoints
      })
      if (dynamicTrackEndSec !== null) {
        durationSec = Math.max(durationSec, dynamicTrackEndSec)
        generatedEnvelopes.push({
          order,
          startSec,
          endSec: dynamicTrackEndSec,
          points: trackPoints
        })
        continue
      }
      const trackSourceBpm = resolveTrackGridSourceBpm(track)
      const trackBpm =
        normalizeTrackBpmValue(track.gridBaseBpm) ??
        normalizeTrackBpmValue(track.originalBpm) ??
        normalizeTrackBpmValue(track.bpm) ??
        defaultBpm
      const trackScale = clampTrackTempoNumber(
        trackBpm / Math.max(BPM_POINT_SEC_EPSILON, trackSourceBpm),
        0.25,
        4
      )
      const visibleSourceDurationSec = resolveTrackVisibleSourceDisplayDuration(
        track,
        sourceDurationSec
      )
      const trackDurationSec =
        visibleSourceDurationSec > 0
          ? roundTrackTempoSec(
              visibleSourceDurationSec / Math.max(BPM_POINT_SEC_EPSILON, trackScale)
            )
          : fallbackDurationSec || sourceDurationSec
      const endSec = roundTrackTempoSec(startSec + trackDurationSec)
      trackPoints.push(
        { sec: startSec, bpm: trackBpm, source: AUTO_BPM_POINT_SOURCE },
        {
          sec: endSec,
          bpm: trackBpm,
          source: AUTO_BPM_POINT_SOURCE
        }
      )
      generatedEnvelopes.push({ order, startSec, endSec, points: trackPoints })
      durationSec = Math.max(durationSec, endSec)
    }
  } else {
    durationSec = Math.max(
      0,
      ...params.tracks.map((track) => {
        const startSec = Number(track.startSec)
        const safeStartSec = Number.isFinite(startSec) && startSec >= 0 ? startSec : 0
        const trackDurationSec = Math.max(0, Number(params.resolveTrackDurationSeconds(track)) || 0)
        return safeStartSec + trackDurationSec
      })
    )
  }
  const normalizedGeneratedPoints =
    durationSec > 0 && generatedEnvelopes.length > 0
      ? markGeneratedBpmEnvelopePoints(
          normalizeMixtapeGlobalBpmEnvelopePoints(
            buildGeneratedGlobalBpmPoints({
              envelopes: generatedEnvelopes,
              durationSec,
              fallbackBpm: defaultBpm
            }),
            durationSec,
            defaultBpm
          )
        )
      : markGeneratedBpmEnvelopePoints(buildFlatMixtapeGlobalBpmEnvelope(durationSec, defaultBpm))
  return {
    bpmEnvelope: normalizedGeneratedPoints,
    bpmEnvelopeDurationSec: durationSec,
    gridPhaseOffsetSec: resolveDefaultMixtapeGlobalGridPhaseOffsetSec({
      tracks: params.tracks,
      resolveTrackSourceDurationSeconds: params.resolveTrackSourceDurationSeconds,
      resolveTrackFirstBeatSeconds: params.resolveTrackFirstBeatSeconds
    })
  }
}

export const buildMixtapeGlobalBpmEnvelopeSnapshotSignature = (snapshot: {
  bpmEnvelope: MixtapeBpmPoint[]
  bpmEnvelopeDurationSec: number
  gridPhaseOffsetSec?: number
}) =>
  [
    Math.round((Number(snapshot.bpmEnvelopeDurationSec) || 0) * 10000),
    Math.round((Number(snapshot.gridPhaseOffsetSec) || 0) * 10000),
    ...(Array.isArray(snapshot.bpmEnvelope) ? snapshot.bpmEnvelope : []).map((point) =>
      [
        Math.round((Number(point.sec) || 0) * 10000),
        Math.round((Number(point.bpm) || 0) * 1000000),
        point.source === 'auto' ? 'a' : point.source === 'manual' ? 'm' : ''
      ].join(':')
    )
  ].join('|')

export const normalizeMixtapeGlobalBpmEnvelopePoints = (
  value: unknown,
  durationSec: number,
  defaultBpm: number
) => {
  const normalizedDefaultBpm = normalizeTrackBpmValue(defaultBpm) ?? 128
  const normalizedPoints = normalizeTrackBpmEnvelopePoints(
    value,
    durationSec,
    normalizedDefaultBpm
  ).map((point) => ({
    sec: Number(point.sec),
    bpm: Number(point.bpm),
    source: point.source === 'auto' || point.source === 'manual' ? point.source : undefined
  }))

  if (
    normalizedPoints.length >= 2 &&
    normalizedPoints.every((point) => point.bpm === normalizedPoints[0]?.bpm)
  ) {
    return buildFlatMixtapeGlobalBpmEnvelope(
      durationSec,
      normalizedPoints[0]?.bpm ?? normalizedDefaultBpm
    )
  }

  return normalizedPoints
}

export const sampleMixtapeGlobalBpmAtSec = (
  points: MixtapeBpmPoint[],
  sec: number,
  fallbackBpm: number
) => sampleMixtapeMasterGridBpmAtSec(points, sec, fallbackBpm)

export const applyMixtapeGlobalTempoTargetsToTracks = (
  tracks: MixtapeTrack[],
  globalPoints: MixtapeBpmPoint[]
) =>
  tracks.map((track) => {
    const fallbackBpm =
      normalizeTrackBpmValue(track.gridBaseBpm) ??
      normalizeTrackBpmValue(track.originalBpm) ??
      normalizeTrackBpmValue(track.bpm) ??
      128
    const clampRange = resolveTrackBpmEnvelopeClampRange(fallbackBpm)
    return {
      ...track,
      bpm: clampTrackTempoNumber(
        sampleMixtapeGlobalBpmAtSec(globalPoints, resolveTrackStartSec(track), fallbackBpm),
        clampRange.minBpm,
        clampRange.maxBpm
      )
    }
  })

export const resolveMixtapeGlobalBpmVisualRange = (params: {
  tracks: MixtapeTrack[]
  points: MixtapeBpmPoint[]
}) => {
  const baseBpm = resolveDefaultGlobalBpmFromTracks(params.tracks)
  const clampRange = resolveTrackBpmEnvelopeClampRange(baseBpm)
  return {
    baseBpm,
    minBpm: clampRange.minBpm,
    maxBpm: clampRange.maxBpm
  }
}
