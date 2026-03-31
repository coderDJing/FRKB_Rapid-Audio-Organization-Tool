import { createMixtapeMasterGrid } from '@renderer/composables/mixtape/mixtapeMasterGrid'
import {
  BPM_POINT_SEC_EPSILON,
  clampTrackTempoNumber,
  roundTrackTempoSec
} from '@renderer/composables/mixtape/trackTempoModel'
import type { MixtapeBpmPoint, MixtapeTrack } from '@renderer/composables/mixtape/types'

export type BpmDragPointer = {
  sec: number
  bpm: number
  clientY?: number
}

export const MASTER_BPM_DRAG_STEP_PX = 8

const resolveLockedGridBeat = (beat: number) => {
  const numeric = Number(beat)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return Math.max(0, Math.round(numeric))
}

export const clonePoints = (points: MixtapeBpmPoint[]) =>
  points.map((point) => ({
    sec: Number(point.sec),
    bpm: Number(point.bpm)
  }))

export const cloneTracks = (tracks: MixtapeTrack[]) => tracks.map((track) => ({ ...track }))

export const resolveTrackStartSec = (track: Pick<MixtapeTrack, 'startSec'> | null | undefined) => {
  const numeric = Number(track?.startSec)
  if (!Number.isFinite(numeric) || numeric < 0) return 0
  return roundTrackTempoSec(numeric)
}

export const buildTrackTargetSignature = (tracks: MixtapeTrack[]) =>
  JSON.stringify(tracks.map((track) => `${Number(track.bpm) || 0}:${resolveTrackStartSec(track)}`))

export const buildTrackStartBeatById = (
  tracks: MixtapeTrack[],
  points: MixtapeBpmPoint[],
  fallbackBpm: number,
  phaseOffsetSec: number = 0
) => {
  const masterGrid = createMixtapeMasterGrid({
    points,
    fallbackBpm,
    phaseOffsetSec
  })
  return new Map(
    tracks.map((track) => [
      String(track.id || ''),
      masterGrid.mapSecToBeats(resolveTrackStartSec(track))
    ])
  )
}

export const buildPointGridBeatMap = (
  points: MixtapeBpmPoint[],
  fallbackBpm: number,
  phaseOffsetSec: number = 0
) => {
  const grid = createMixtapeMasterGrid({ points, fallbackBpm, phaseOffsetSec })
  const map = new Map<number, number>()
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]
    if (!point) continue
    map.set(index, resolveLockedGridBeat(grid.mapSecToBeats(point.sec)))
  }
  return map
}

export const resolveLockedPointSec = (params: {
  points: MixtapeBpmPoint[]
  pointIndex: number
  pointGridBeats: Map<number, number>
  durationSec: number
}) => {
  const targetPoint = params.points[params.pointIndex]
  const prevPoint = params.points[params.pointIndex - 1]
  if (!targetPoint || !prevPoint) return 0

  const targetBeat = params.pointGridBeats.get(params.pointIndex)
  const prevBeat = params.pointGridBeats.get(params.pointIndex - 1) ?? 0
  if (
    targetBeat === undefined ||
    !Number.isFinite(targetBeat) ||
    !Number.isFinite(prevBeat) ||
    targetBeat < prevBeat - BPM_POINT_SEC_EPSILON
  ) {
    return roundTrackTempoSec(
      clampTrackTempoNumber(
        Number(targetPoint.sec) || 0,
        Number(prevPoint.sec) || 0,
        Math.max(0, Number(params.durationSec) || 0)
      )
    )
  }
  const safeTargetBeat = Number(targetBeat)

  const bpmSum = Number(prevPoint.bpm) + Number(targetPoint.bpm)
  if (bpmSum <= BPM_POINT_SEC_EPSILON) {
    return roundTrackTempoSec(
      clampTrackTempoNumber(
        Number(targetPoint.sec) || 0,
        Number(prevPoint.sec) || 0,
        Math.max(0, Number(params.durationSec) || 0)
      )
    )
  }

  return roundTrackTempoSec(
    clampTrackTempoNumber(
      (Number(prevPoint.sec) || 0) + ((safeTargetBeat - prevBeat) * 120) / bpmSum,
      Number(prevPoint.sec) || 0,
      Math.max(Number(prevPoint.sec) || 0, Math.max(0, Number(params.durationSec) || 0))
    )
  )
}
