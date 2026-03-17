import { BPM_POINT_SEC_EPSILON } from '@renderer/composables/mixtape/trackTempoModel'
import type { PhaseSyncPlan } from '@renderer/composables/mixtape/phaseSyncPlanner'
import type { MixtapeGridLineOverride, MixtapeTrack } from '@renderer/composables/mixtape/types'

export type PhaseSyncApplyTrigger = 'track-position' | 'bpm-edit'

export const mergePhaseSyncGridLines = (params: {
  currentLines: MixtapeGridLineOverride[] | undefined
  replacementLines: MixtapeGridLineOverride[]
  currentRange?: {
    startSec?: number
    endSec?: number
  }
  replacementRange: {
    startSec: number
    endSec: number
  }
}) => {
  const { currentLines, replacementLines, currentRange, replacementRange } = params
  if (!replacementLines.length) return currentLines ?? []
  const currentStartSec = Number(currentRange?.startSec)
  const currentEndSec = Number(currentRange?.endSec)
  const clearStart = Number.isFinite(currentStartSec)
    ? Math.min(currentStartSec, replacementRange.startSec)
    : replacementRange.startSec
  const clearEnd = Number.isFinite(currentEndSec)
    ? Math.max(currentEndSec, replacementRange.endSec)
    : replacementRange.endSec
  const preserved = Array.isArray(currentLines)
    ? currentLines.filter(
        (line) =>
          line.sec < clearStart - BPM_POINT_SEC_EPSILON ||
          line.sec > clearEnd + BPM_POINT_SEC_EPSILON
      )
    : []
  return [...preserved, ...replacementLines].sort((left, right) => left.sec - right.sec)
}

export const applyPhaseSyncPlanToTrack = (params: {
  track: MixtapeTrack
  trigger: PhaseSyncApplyTrigger
  plan: PhaseSyncPlan
}) => {
  const mergedGridLines = mergePhaseSyncGridLines({
    currentLines: params.track.phaseSyncGridLines,
    replacementLines: params.plan.gridOverride.lines,
    currentRange: {
      startSec: params.track.phaseSyncGridRangeStartSec,
      endSec: params.track.phaseSyncGridRangeEndSec
    },
    replacementRange: {
      startSec: params.plan.gridOverride.rangeStartLocalSec,
      endSec: params.plan.gridOverride.rangeEndLocalSec
    }
  })

  return {
    ...params.track,
    bpmEnvelope:
      params.trigger === 'bpm-edit' ? params.plan.nextTempoPoints : params.track.bpmEnvelope,
    phaseSyncGridLines: mergedGridLines,
    phaseSyncGridRangeStartSec: params.plan.gridOverride.rangeStartLocalSec,
    phaseSyncGridRangeEndSec: params.plan.gridOverride.rangeEndLocalSec
  } satisfies MixtapeTrack
}
