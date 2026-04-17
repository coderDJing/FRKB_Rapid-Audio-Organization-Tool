import { buildMixtapeTrackLoopSections } from '@renderer/composables/mixtape/mixtapeTrackLoop'
import type { MixtapeTrackLoopSegment } from '@renderer/composables/mixtape/types'

const PLAYBACK_SEQUENCE_EPSILON_SEC = 1e-6

export type TransportPlaybackSequenceSegment = {
  key: string
  localStartSec: number
  localEndSec: number
  baseLocalStartSec: number
  baseLocalEndSec: number
  sourceStartSec: number
  sourceEndSec: number
  planStartSec: number
  planEndSec: number
}

export type TransportPlaybackSequence = {
  segments: TransportPlaybackSequenceSegment[]
  totalPlanSec: number
}

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export const buildTransportPlaybackSequence = (params: {
  baseDurationSec: number
  loopSegments?: MixtapeTrackLoopSegment[]
  loopSegment?: MixtapeTrackLoopSegment
  mapBaseLocalToSource: (localSec: number) => number
}): TransportPlaybackSequence => {
  const sections = buildMixtapeTrackLoopSections(
    params.baseDurationSec,
    Array.isArray(params.loopSegments) && params.loopSegments.length
      ? params.loopSegments
      : params.loopSegment
  )
  const segments: TransportPlaybackSequenceSegment[] = []
  let planCursorSec = 0
  for (const section of sections) {
    const localStartSec = Math.max(0, Number(section.displayStartSec) || 0)
    const localEndSec = Math.max(localStartSec, Number(section.displayEndSec) || 0)
    const baseLocalStartSec = Math.max(0, Number(section.baseStartSec) || 0)
    const baseLocalEndSec = Math.max(baseLocalStartSec, Number(section.baseEndSec) || 0)
    if (localEndSec - localStartSec <= PLAYBACK_SEQUENCE_EPSILON_SEC) continue
    const sourceStartSec = Math.max(0, Number(params.mapBaseLocalToSource(baseLocalStartSec)) || 0)
    const sourceEndSec = Math.max(
      sourceStartSec,
      Number(params.mapBaseLocalToSource(baseLocalEndSec)) || 0
    )
    const sourceDurationSec = Math.max(0, sourceEndSec - sourceStartSec)
    if (sourceDurationSec <= PLAYBACK_SEQUENCE_EPSILON_SEC) continue
    const planStartSec = planCursorSec
    planCursorSec += sourceDurationSec
    segments.push({
      key: section.key,
      localStartSec,
      localEndSec,
      baseLocalStartSec,
      baseLocalEndSec,
      sourceStartSec,
      sourceEndSec,
      planStartSec,
      planEndSec: planCursorSec
    })
  }
  return {
    segments,
    totalPlanSec: planCursorSec
  }
}

export const hasInternalPlaybackSequence = (
  sequence: TransportPlaybackSequence | null | undefined
) => {
  return Array.isArray(sequence?.segments) && sequence.segments.length > 1
}

export const mapPlaybackSequenceLocalToPlanSec = (params: {
  localSec: number
  sequence: TransportPlaybackSequence | null | undefined
  mapBaseLocalToSource: (localSec: number) => number
}) => {
  const sequence = params.sequence
  if (!sequence?.segments?.length) return 0
  const totalLocalSec = Math.max(
    0,
    Number(sequence.segments[sequence.segments.length - 1]?.localEndSec || 0)
  )
  const safeLocalSec = clampNumber(Number(params.localSec) || 0, 0, totalLocalSec)
  const matchedSegment =
    sequence.segments.find((segment, index) => {
      const isLast = index === sequence.segments.length - 1
      if (safeLocalSec < segment.localStartSec - PLAYBACK_SEQUENCE_EPSILON_SEC) return false
      if (isLast) {
        return safeLocalSec <= segment.localEndSec + PLAYBACK_SEQUENCE_EPSILON_SEC
      }
      return safeLocalSec < segment.localEndSec - PLAYBACK_SEQUENCE_EPSILON_SEC
    }) || sequence.segments[sequence.segments.length - 1]
  if (!matchedSegment) return 0
  const baseLocalSec = clampNumber(
    matchedSegment.baseLocalStartSec + (safeLocalSec - matchedSegment.localStartSec),
    matchedSegment.baseLocalStartSec,
    matchedSegment.baseLocalEndSec
  )
  const sourceSec = clampNumber(
    Number(params.mapBaseLocalToSource(baseLocalSec)) || matchedSegment.sourceStartSec,
    matchedSegment.sourceStartSec,
    matchedSegment.sourceEndSec
  )
  return clampNumber(
    matchedSegment.planStartSec + (sourceSec - matchedSegment.sourceStartSec),
    matchedSegment.planStartSec,
    matchedSegment.planEndSec
  )
}

export const mapPlaybackSequencePlanToLocalSec = (params: {
  planSec: number
  sequence: TransportPlaybackSequence | null | undefined
  mapSourceToBaseLocal: (sourceSec: number) => number
}) => {
  const sequence = params.sequence
  if (!sequence?.segments?.length) return 0
  const safePlanSec = clampNumber(
    Number(params.planSec) || 0,
    0,
    Math.max(0, Number(sequence.totalPlanSec) || 0)
  )
  const matchedSegment =
    sequence.segments.find((segment, index) => {
      const isLast = index === sequence.segments.length - 1
      if (safePlanSec < segment.planStartSec - PLAYBACK_SEQUENCE_EPSILON_SEC) return false
      if (isLast) {
        return safePlanSec <= segment.planEndSec + PLAYBACK_SEQUENCE_EPSILON_SEC
      }
      return safePlanSec < segment.planEndSec - PLAYBACK_SEQUENCE_EPSILON_SEC
    }) || sequence.segments[sequence.segments.length - 1]
  if (!matchedSegment) return 0
  const sourceSec = clampNumber(
    matchedSegment.sourceStartSec + (safePlanSec - matchedSegment.planStartSec),
    matchedSegment.sourceStartSec,
    matchedSegment.sourceEndSec
  )
  const baseLocalSec = clampNumber(
    Number(params.mapSourceToBaseLocal(sourceSec)) || matchedSegment.baseLocalStartSec,
    matchedSegment.baseLocalStartSec,
    matchedSegment.baseLocalEndSec
  )
  return clampNumber(
    matchedSegment.localStartSec + (baseLocalSec - matchedSegment.baseLocalStartSec),
    matchedSegment.localStartSec,
    matchedSegment.localEndSec
  )
}
