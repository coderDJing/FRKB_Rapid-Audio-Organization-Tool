import type { MixtapeMuteSegment } from '@renderer/composables/mixtape/types'

const MUTE_SEGMENT_EPSILON = 0.0001

export const normalizeVolumeMuteSegments = (
  value: unknown,
  durationSec?: number
): MixtapeMuteSegment[] => {
  const hasDuration = Number.isFinite(Number(durationSec))
  const safeDuration = hasDuration
    ? Math.max(0, Number(durationSec) || 0)
    : Number.POSITIVE_INFINITY
  const segments = Array.isArray(value)
    ? value
        .map((item) => {
          const startSec = Number((item as any)?.startSec)
          const endSec = Number((item as any)?.endSec)
          if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return null
          const safeStart = Math.max(0, startSec)
          const safeEnd = Math.min(safeDuration, endSec)
          if (safeEnd - safeStart <= MUTE_SEGMENT_EPSILON) return null
          return {
            startSec: Number(safeStart.toFixed(4)),
            endSec: Number(safeEnd.toFixed(4))
          }
        })
        .filter(Boolean)
    : []
  if (!segments.length) return []
  const sorted = (segments as MixtapeMuteSegment[]).sort((a, b) => {
    if (Math.abs(a.startSec - b.startSec) > MUTE_SEGMENT_EPSILON) return a.startSec - b.startSec
    return a.endSec - b.endSec
  })
  const deduped: MixtapeMuteSegment[] = []
  for (const segment of sorted) {
    const last = deduped[deduped.length - 1]
    if (
      last &&
      Math.abs(last.startSec - segment.startSec) <= MUTE_SEGMENT_EPSILON &&
      Math.abs(last.endSec - segment.endSec) <= MUTE_SEGMENT_EPSILON
    ) {
      continue
    }
    deduped.push(segment)
  }
  return deduped
}

export const isSecMutedBySegments = (
  segments: MixtapeMuteSegment[] | undefined,
  sec: number
): boolean => {
  if (!Array.isArray(segments) || !segments.length) return false
  const targetSec = Number(sec)
  if (!Number.isFinite(targetSec) || targetSec < 0) return false
  for (const segment of segments) {
    if (targetSec < segment.startSec - MUTE_SEGMENT_EPSILON) {
      return false
    }
    if (
      targetSec >= segment.startSec - MUTE_SEGMENT_EPSILON &&
      targetSec < segment.endSec - MUTE_SEGMENT_EPSILON
    ) {
      return true
    }
  }
  return false
}
