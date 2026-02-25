import { GRID_BEAT4_LINE_ZOOM, GRID_BEAT_LINE_ZOOM } from '@renderer/composables/mixtape/constants'
import {
  normalizeBeatOffset as normalizeBeatOffsetByMixxx,
  resolveBeatSecByBpm
} from '@renderer/composables/mixtape/mixxxSyncModel'
import { normalizeVolumeMuteSegments } from '@renderer/composables/mixtape/volumeMuteSegments'
import { VOLUME_MUTE_SEGMENT_EPSILON } from '@renderer/composables/mixtape/gainEnvelopeEditorConstants'
import type { VolumeMuteSegmentMask } from '@renderer/composables/mixtape/gainEnvelopeEditorTypes'
import type { MixtapeMuteSegment, MixtapeTrack } from '@renderer/composables/mixtape/types'

type ResolveVolumeMuteGridPayload = {
  track: MixtapeTrack
  durationSec: number
  zoom: number
  firstBeatSec: number
}

type ResolveVolumeMuteSegmentBySecPayload = ResolveVolumeMuteGridPayload & {
  sec: number
}

type ResolveGridAlignedVolumeMuteSegmentsPayload = ResolveVolumeMuteGridPayload & {
  value: unknown
}

type SnapSecToVisibleGridPayload = ResolveVolumeMuteGridPayload & {
  sec: number
  minSec?: number
  maxSec?: number
}

export const clampNumber = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value))

export const resolveVolumeMuteSegmentKey = (segment: MixtapeMuteSegment) =>
  `${Number(segment.startSec).toFixed(4)}:${Number(segment.endSec).toFixed(4)}`

export const resolveVolumeMuteStepBeats = (zoom: number) => {
  if (zoom >= GRID_BEAT_LINE_ZOOM) return 1
  if (zoom >= GRID_BEAT4_LINE_ZOOM) return 4
  return 32
}

export const resolveVolumeMuteGrid = ({
  track,
  durationSec,
  zoom,
  firstBeatSec
}: ResolveVolumeMuteGridPayload) => {
  const beatSec = resolveBeatSecByBpm(Number(track.bpm))
  if (!beatSec) return null
  const stepBeats = resolveVolumeMuteStepBeats(zoom)
  const barOffset = normalizeBeatOffsetByMixxx(track.barBeatOffset, 32)
  const baseSec = stepBeats === 1 ? firstBeatSec : firstBeatSec + barOffset * beatSec
  const stepSec = beatSec * stepBeats
  if (!Number.isFinite(stepSec) || stepSec <= 0) return null
  return {
    durationSec: Math.max(0, Number(durationSec) || 0),
    baseSec,
    stepSec
  }
}

export const resolveGridAlignedVolumeMuteSegments = ({
  track,
  durationSec,
  value,
  zoom,
  firstBeatSec
}: ResolveGridAlignedVolumeMuteSegmentsPayload) => {
  const normalized = normalizeVolumeMuteSegments(value, durationSec)
  if (!normalized.length) return [] as MixtapeMuteSegment[]
  const grid = resolveVolumeMuteGrid({
    track,
    durationSec,
    zoom,
    firstBeatSec
  })
  if (!grid) return normalized
  const segmentMap = new Map<string, MixtapeMuteSegment>()
  for (const segment of normalized) {
    const safeStart = clampNumber(Number(segment.startSec) || 0, 0, grid.durationSec)
    const safeEnd = clampNumber(Number(segment.endSec) || 0, 0, grid.durationSec)
    if (safeEnd - safeStart <= VOLUME_MUTE_SEGMENT_EPSILON) continue
    const startIndex = Math.floor((safeStart - grid.baseSec) / grid.stepSec)
    const endIndex = Math.floor(
      (Math.max(safeStart, safeEnd - VOLUME_MUTE_SEGMENT_EPSILON) - grid.baseSec) / grid.stepSec
    )
    for (let index = startIndex; index <= endIndex; index += 1) {
      const rawStartSec = grid.baseSec + index * grid.stepSec
      const rawEndSec = rawStartSec + grid.stepSec
      const segmentStartSec = clampNumber(rawStartSec, 0, grid.durationSec)
      const segmentEndSec = clampNumber(rawEndSec, 0, grid.durationSec)
      if (segmentEndSec - segmentStartSec <= VOLUME_MUTE_SEGMENT_EPSILON) continue
      const alignedSegment: MixtapeMuteSegment = {
        startSec: Number(segmentStartSec.toFixed(4)),
        endSec: Number(segmentEndSec.toFixed(4))
      }
      segmentMap.set(resolveVolumeMuteSegmentKey(alignedSegment), alignedSegment)
    }
  }
  return normalizeVolumeMuteSegments(Array.from(segmentMap.values()), durationSec)
}

export const resolveVolumeMutePointerSec = (
  stageEl: HTMLElement,
  event: MouseEvent,
  durationSec: number
) => {
  const rect = stageEl.getBoundingClientRect()
  if (!rect.width || !durationSec) return null
  const xRatio = clampNumber((event.clientX - rect.left) / rect.width, 0, 1)
  return Number((xRatio * durationSec).toFixed(4))
}

export const resolveVolumeMuteSegmentBySec = ({
  track,
  durationSec,
  sec,
  zoom,
  firstBeatSec
}: ResolveVolumeMuteSegmentBySecPayload) => {
  const grid = resolveVolumeMuteGrid({
    track,
    durationSec,
    zoom,
    firstBeatSec
  })
  if (!grid) return null
  const maxSelectableSec = Math.max(0, grid.durationSec - VOLUME_MUTE_SEGMENT_EPSILON)
  const safeSec = clampNumber(Number(sec) || 0, 0, maxSelectableSec)
  const index = Math.floor((safeSec - grid.baseSec) / grid.stepSec)
  const startSec = grid.baseSec + index * grid.stepSec
  const endSec = startSec + grid.stepSec
  const safeStartSec = clampNumber(startSec, 0, grid.durationSec)
  const safeEndSec = clampNumber(endSec, 0, grid.durationSec)
  if (safeEndSec - safeStartSec <= VOLUME_MUTE_SEGMENT_EPSILON) return null
  return {
    startSec: Number(safeStartSec.toFixed(4)),
    endSec: Number(safeEndSec.toFixed(4))
  }
}

const resolveGridSnapModes = (zoom: number) => {
  const snapBeat = zoom >= GRID_BEAT_LINE_ZOOM
  const snapBeat4 = zoom >= GRID_BEAT4_LINE_ZOOM
  return {
    snapBar: true,
    snapBeat4,
    snapBeat
  }
}

const resolveNearestGridSec = (payload: {
  targetSec: number
  minSec: number
  maxSec: number
  baseSec: number
  stepSec: number
}) => {
  const targetSec = Number(payload.targetSec)
  const minSec = Number(payload.minSec)
  const maxSec = Number(payload.maxSec)
  const baseSec = Number(payload.baseSec)
  const stepSec = Number(payload.stepSec)
  if (!Number.isFinite(targetSec) || !Number.isFinite(minSec) || !Number.isFinite(maxSec)) {
    return null
  }
  if (maxSec < minSec) return null
  if (!Number.isFinite(baseSec) || !Number.isFinite(stepSec) || stepSec <= 0) return null
  const minN = Math.ceil((minSec - baseSec) / stepSec)
  const maxN = Math.floor((maxSec - baseSec) / stepSec)
  if (minN > maxN) return null
  const approxN = Math.round((targetSec - baseSec) / stepSec)
  const safeN = Math.max(minN, Math.min(maxN, approxN))
  return baseSec + safeN * stepSec
}

export const snapSecToVisibleGrid = ({
  track,
  sec,
  durationSec,
  zoom,
  firstBeatSec,
  minSec,
  maxSec
}: SnapSecToVisibleGridPayload) => {
  const safeDurationSec = Math.max(0, Number(durationSec) || 0)
  const safeMinSec = clampNumber(Number(minSec) || 0, 0, safeDurationSec)
  const safeMaxSec = clampNumber(
    Number.isFinite(Number(maxSec)) ? Number(maxSec) : safeDurationSec,
    safeMinSec,
    safeDurationSec
  )
  const safeSec = clampNumber(Number(sec) || 0, safeMinSec, safeMaxSec)
  const beatSec = resolveBeatSecByBpm(Number(track.bpm))
  if (!beatSec) return null
  const barOffset = normalizeBeatOffsetByMixxx(track.barBeatOffset, 32)
  const barBaseSec = firstBeatSec + barOffset * beatSec
  const { snapBar, snapBeat4, snapBeat } = resolveGridSnapModes(zoom)
  const candidates: number[] = []
  if (snapBar) {
    const barSec = resolveNearestGridSec({
      targetSec: safeSec,
      minSec: safeMinSec,
      maxSec: safeMaxSec,
      baseSec: barBaseSec,
      stepSec: beatSec * 32
    })
    if (typeof barSec === 'number' && Number.isFinite(barSec)) candidates.push(barSec)
  }
  if (snapBeat4) {
    const beat4Sec = resolveNearestGridSec({
      targetSec: safeSec,
      minSec: safeMinSec,
      maxSec: safeMaxSec,
      baseSec: barBaseSec,
      stepSec: beatSec * 4
    })
    if (typeof beat4Sec === 'number' && Number.isFinite(beat4Sec)) candidates.push(beat4Sec)
  }
  if (snapBeat) {
    const beatSecPoint = resolveNearestGridSec({
      targetSec: safeSec,
      minSec: safeMinSec,
      maxSec: safeMaxSec,
      baseSec: firstBeatSec,
      stepSec: beatSec
    })
    if (typeof beatSecPoint === 'number' && Number.isFinite(beatSecPoint)) {
      candidates.push(beatSecPoint)
    }
  }
  if (!candidates.length) return null
  let nearest = candidates[0]
  let minDiff = Math.abs(nearest - safeSec)
  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    const diff = Math.abs(candidate - safeSec)
    if (diff < minDiff) {
      minDiff = diff
      nearest = candidate
    }
  }
  return clampNumber(nearest, safeMinSec, safeMaxSec)
}

export const resolveVolumeMuteSegmentMasks = (
  durationSec: number,
  segments: MixtapeMuteSegment[]
): VolumeMuteSegmentMask[] => {
  if (!durationSec || !segments.length) return []
  return segments
    .map((segment) => {
      const startRatio = clampNumber(segment.startSec / durationSec, 0, 1)
      const endRatio = clampNumber(segment.endSec / durationSec, 0, 1)
      const widthRatio = Math.max(0, endRatio - startRatio)
      if (widthRatio <= 0.0001) return null
      return {
        key: resolveVolumeMuteSegmentKey(segment),
        left: Number((startRatio * 100).toFixed(4)),
        width: Number((widthRatio * 100).toFixed(4))
      }
    })
    .filter((segment): segment is VolumeMuteSegmentMask => segment !== null)
}

export const resolveVolumeMuteSegmentsByToggle = (
  baseSegments: MixtapeMuteSegment[],
  touched: Map<string, MixtapeMuteSegment>
) => {
  const nextMap = new Map(
    baseSegments.map((segment) => [resolveVolumeMuteSegmentKey(segment), segment])
  )
  for (const [key, segment] of touched.entries()) {
    if (nextMap.has(key)) {
      nextMap.delete(key)
    } else {
      nextMap.set(key, segment)
    }
  }
  return Array.from(nextMap.values())
}
