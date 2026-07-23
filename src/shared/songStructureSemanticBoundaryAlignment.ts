import { percentile } from './songStructureCommon'
import {
  resolveSongStructureSemanticActivity,
  resolveSongStructureSemanticFoundation
} from './songStructureSemanticActivity'
import type { SongStructureSemanticRange } from './songStructureSemanticOutro'
import type {
  SongStructureSpectralBarFeature,
  SongStructureSpectralValueKey,
  SongStructureSpectralValues
} from './songStructureSpectralFeatures'

const RIGHT_PROTOTYPE_BLOCKS = 4
const MIN_REMAINING_NEXT_BLOCKS = 4
const MIN_RIGHT_DISTANCE_IMPROVEMENT = 0.08
const MIN_FOLLOWING_DISTANCE_IMPROVEMENT = 0.04
const MIN_BREAKDOWN_RELEASE = 0.1
const MIN_BREAKDOWN_FLOOR_DROP = 0.08

const PROTOTYPE_WEIGHTS: ReadonlyArray<readonly [SongStructureSpectralValueKey, number]> = [
  ['energy', 0.16],
  ['low', 0.22],
  ['mid', 0.12],
  ['high', 0.12],
  ['attack', 0.06],
  ['attackDensity', 0.14],
  ['density', 0.18]
]

const summarizePrototype = (
  bars: readonly SongStructureSpectralBarFeature[],
  startIndex: number,
  endIndex: number
) => {
  const start = Math.max(0, Math.floor(startIndex))
  const end = Math.min(bars.length, Math.ceil(endIndex))
  if (end <= start) return null
  return Object.fromEntries(
    PROTOTYPE_WEIGHTS.map(([key]) => [
      key,
      percentile(
        bars.slice(start, end).map((bar) => bar.normalized[key]),
        0.5
      )
    ])
  ) as Pick<SongStructureSpectralValues, (typeof PROTOTYPE_WEIGHTS)[number][0]>
}

const distanceToPrototype = (
  values: SongStructureSpectralValues,
  prototype: Pick<SongStructureSpectralValues, (typeof PROTOTYPE_WEIGHTS)[number][0]>
) =>
  PROTOTYPE_WEIGHTS.reduce(
    (total, [key, weight]) => total + Math.abs(values[key] - prototype[key]) * weight,
    0
  )

const resolveTension = (values: SongStructureSpectralValues) =>
  values.energy * 0.25 + values.mid * 0.35 + values.high * 0.4

const resolvePositiveRelease = (
  reference: Pick<SongStructureSpectralValues, (typeof PROTOTYPE_WEIGHTS)[number][0]>,
  current: SongStructureSpectralValues
) =>
  Math.max(0, reference.energy - current.energy) * 0.18 +
  Math.max(0, reference.low - current.low) * 0.18 +
  Math.max(0, reference.mid - current.mid) * 0.18 +
  Math.max(0, reference.high - current.high) * 0.18 +
  Math.max(0, reference.attackDensity - current.attackDensity) * 0.12 +
  Math.max(0, reference.density - current.density) * 0.16

const shouldShiftBreakdownBackward = (
  bars: readonly SongStructureSpectralBarFeature[],
  previousRange: SongStructureSemanticRange,
  nextRange: SongStructureSemanticRange
) => {
  if (nextRange.kind !== 'breakdown') return false
  const boundaryIndex = nextRange.startIndex
  if (
    previousRange.endIndex - previousRange.startIndex <= 4 ||
    boundaryIndex < 4 ||
    nextRange.endIndex - boundaryIndex < 4
  ) {
    return false
  }
  const transition = bars[boundaryIndex - 1]?.normalized
  const inactive = bars[boundaryIndex]?.normalized
  const following = bars[boundaryIndex + 1]?.normalized
  const activePrototype = summarizePrototype(bars, boundaryIndex - 5, boundaryIndex - 1)
  const inactivePrototype = summarizePrototype(
    bars,
    boundaryIndex,
    Math.min(nextRange.endIndex, boundaryIndex + RIGHT_PROTOTYPE_BLOCKS)
  )
  if (!transition || !inactive || !following || !activePrototype || !inactivePrototype) {
    return false
  }
  const transitionFoundation = resolveSongStructureSemanticFoundation(transition)
  const transitionActivity = resolveSongStructureSemanticActivity(transition)
  const inactiveValues = { ...transition, ...inactivePrototype }
  const inactiveFoundation = resolveSongStructureSemanticFoundation(inactiveValues)
  const inactiveActivity = resolveSongStructureSemanticActivity(inactiveValues)
  const followingFoundation = resolveSongStructureSemanticFoundation(following)
  const highRelease = activePrototype.high - transition.high
  const energyRelease = activePrototype.energy - transition.energy
  const lowRelease = activePrototype.low - transition.low
  return (
    resolvePositiveRelease(activePrototype, transition) >= MIN_BREAKDOWN_RELEASE &&
    highRelease >= 0.35 &&
    energyRelease <= 0.12 &&
    lowRelease <= 0.08 &&
    transitionFoundation >= 0.45 &&
    transitionFoundation - inactiveFoundation >= MIN_BREAKDOWN_FLOOR_DROP &&
    transitionActivity - inactiveActivity >= MIN_BREAKDOWN_FLOOR_DROP &&
    followingFoundation <= transitionFoundation - MIN_BREAKDOWN_FLOOR_DROP * 0.6
  )
}

const isPreDropTransition = (
  current: SongStructureSpectralValues,
  next: SongStructureSpectralValues,
  following: SongStructureSpectralValues,
  rightPrototype: Pick<SongStructureSpectralValues, (typeof PROTOTYPE_WEIGHTS)[number][0]>
) => {
  const currentFoundation = resolveSongStructureSemanticFoundation(current)
  const nextFoundation = resolveSongStructureSemanticFoundation(next)
  const followingFoundation = resolveSongStructureSemanticFoundation(following)
  const prototypeFoundation = resolveSongStructureSemanticFoundation({
    ...current,
    ...rightPrototype
  })
  const currentActivity = resolveSongStructureSemanticActivity(current)
  const nextActivity = resolveSongStructureSemanticActivity(next)
  return (
    next.low - current.low >= 0.18 &&
    nextFoundation - currentFoundation >= 0.075 &&
    followingFoundation - currentFoundation >= 0.045 &&
    prototypeFoundation - currentFoundation >= 0.07 &&
    nextFoundation >= prototypeFoundation - 0.1 &&
    nextActivity - currentActivity >= 0.025
  )
}

const isPreBuildTransition = (
  previous: SongStructureSpectralValues,
  current: SongStructureSpectralValues,
  next: SongStructureSpectralValues,
  following: SongStructureSpectralValues,
  rightPrototype: Pick<SongStructureSpectralValues, (typeof PROTOTYPE_WEIGHTS)[number][0]>
) => {
  const previousFoundation = resolveSongStructureSemanticFoundation(previous)
  const currentFoundation = resolveSongStructureSemanticFoundation(current)
  const nextFoundation = resolveSongStructureSemanticFoundation(next)
  const prototypeTension = resolveTension({ ...current, ...rightPrototype })
  const currentTension = resolveTension(current)
  const nextTension = resolveTension(next)
  const followingTension = resolveTension(following)
  return (
    previousFoundation - currentFoundation >= 0.025 &&
    nextFoundation - currentFoundation >= 0.015 &&
    nextTension - currentTension >= 0.12 &&
    prototypeTension - currentTension >= 0.15 &&
    followingTension > currentTension
  )
}

const shouldShiftBoundaryForward = (
  bars: readonly SongStructureSpectralBarFeature[],
  previousRange: SongStructureSemanticRange,
  nextRange: SongStructureSemanticRange
) => {
  if (nextRange.kind !== 'build' && nextRange.kind !== 'drop') return false
  const boundaryIndex = nextRange.startIndex
  if (
    boundaryIndex <= previousRange.startIndex ||
    nextRange.endIndex - boundaryIndex <= MIN_REMAINING_NEXT_BLOCKS ||
    boundaryIndex + 2 >= nextRange.endIndex
  ) {
    return false
  }
  const previous = bars[boundaryIndex - 1]?.normalized
  const current = bars[boundaryIndex]?.normalized
  const next = bars[boundaryIndex + 1]?.normalized
  const following = bars[boundaryIndex + 2]?.normalized
  const rightPrototype = summarizePrototype(
    bars,
    boundaryIndex + 1,
    Math.min(nextRange.endIndex, boundaryIndex + 1 + RIGHT_PROTOTYPE_BLOCKS)
  )
  if (!previous || !current || !next || !following || !rightPrototype) return false

  const currentDistance = distanceToPrototype(current, rightPrototype)
  const nextDistance = distanceToPrototype(next, rightPrototype)
  const followingDistance = distanceToPrototype(following, rightPrototype)
  if (currentDistance - nextDistance < MIN_RIGHT_DISTANCE_IMPROVEMENT) {
    return false
  }
  if (
    nextRange.kind === 'drop' &&
    currentDistance - followingDistance < MIN_FOLLOWING_DISTANCE_IMPROVEMENT
  ) {
    return false
  }

  return nextRange.kind === 'drop'
    ? isPreDropTransition(current, next, following, rightPrototype)
    : isPreBuildTransition(previous, current, next, following, rightPrototype)
}

export const refineSongStructureSemanticBoundaryAlignment = (
  bars: readonly SongStructureSpectralBarFeature[],
  ranges: readonly SongStructureSemanticRange[]
) => {
  const result = ranges.map((range) => ({ ...range }))
  for (let index = 1; index < result.length; index += 1) {
    const previous = result[index - 1]
    const next = result[index]
    if (!previous || !next || previous.endIndex !== next.startIndex) continue
    if (shouldShiftBreakdownBackward(bars, previous, next)) {
      previous.endIndex -= 1
      next.startIndex -= 1
      continue
    }
    if (!shouldShiftBoundaryForward(bars, previous, next)) continue
    previous.endIndex += 1
    next.startIndex += 1
  }
  return result
}
