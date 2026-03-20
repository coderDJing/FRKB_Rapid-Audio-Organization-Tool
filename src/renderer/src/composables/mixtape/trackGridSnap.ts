const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export const findNearestSortedGridValues = (values: number[], target: number) => {
  if (!values.length) return [] as number[]
  let left = 0
  let right = values.length - 1
  while (left < right) {
    const middle = Math.floor((left + right) / 2)
    if ((values[middle] || 0) < target) {
      left = middle + 1
    } else {
      right = middle
    }
  }
  const result = new Set<number>()
  if (values[left] !== undefined) result.add(values[left] as number)
  if (left > 0 && values[left - 1] !== undefined) result.add(values[left - 1] as number)
  if (left + 1 < values.length && values[left + 1] !== undefined) {
    result.add(values[left + 1] as number)
  }
  return Array.from(result)
}

export const resolveSnappedStartSecByVisibleGrid = (payload: {
  rawStartSec: number
  minStartSec: number
  maxStartSec: number
  currentLocalGridSecs: number[]
  targetTimelineGridSecs: number[]
  boundaryCandidates?: number[]
}) => {
  const rawStartSec = Math.max(0, Number(payload.rawStartSec) || 0)
  const minStartSec = Math.max(0, Number(payload.minStartSec) || 0)
  const maxStartSec = Number.isFinite(Number(payload.maxStartSec))
    ? Math.max(minStartSec, Number(payload.maxStartSec))
    : Number.POSITIVE_INFINITY
  if (!payload.currentLocalGridSecs.length || !payload.targetTimelineGridSecs.length) return null

  let nearestSec: number | null = null
  let nearestDiff = Number.POSITIVE_INFINITY
  for (const localSec of payload.currentLocalGridSecs) {
    const safeLocalSec = Number(localSec)
    if (!Number.isFinite(safeLocalSec) || safeLocalSec < 0) continue
    const nearestTargets = findNearestSortedGridValues(
      payload.targetTimelineGridSecs,
      rawStartSec + safeLocalSec
    )
    for (const targetSec of nearestTargets) {
      const snappedStartSec = clampNumber(targetSec - safeLocalSec, minStartSec, maxStartSec)
      const diff = Math.abs(snappedStartSec - rawStartSec)
      if (diff < nearestDiff) {
        nearestSec = snappedStartSec
        nearestDiff = diff
      }
    }
  }
  if (Array.isArray(payload.boundaryCandidates)) {
    for (const candidate of payload.boundaryCandidates) {
      const safeCandidate = clampNumber(Number(candidate) || 0, minStartSec, maxStartSec)
      const diff = Math.abs(safeCandidate - rawStartSec)
      if (diff < nearestDiff) {
        nearestSec = safeCandidate
        nearestDiff = diff
      }
    }
  }
  return nearestSec
}
