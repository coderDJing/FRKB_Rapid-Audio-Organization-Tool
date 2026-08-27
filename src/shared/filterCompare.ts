export type CompareFilterOp = 'eq' | 'gte' | 'lte' | 'between'

function isFiniteNumber(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value)
}

export function matchComparableByFilter(
  value: number,
  op: CompareFilterOp | undefined,
  target: number | null | undefined,
  targetTo?: number | null
): boolean {
  if (!op || !Number.isFinite(value)) return false
  if (op === 'eq') return isFiniteNumber(target) && value === target
  if (op === 'gte') return isFiniteNumber(target) && value >= target
  if (op === 'lte') return isFiniteNumber(target) && value <= target
  if (op === 'between') {
    const hasFrom = isFiniteNumber(target)
    const hasTo = isFiniteNumber(targetTo)
    if (hasFrom && hasTo) {
      const low = Math.min(target, targetTo)
      const high = Math.max(target, targetTo)
      return value >= low && value <= high
    }
    if (hasFrom) return value >= target
    if (hasTo) return value <= targetTo
    return false
  }
  return false
}
