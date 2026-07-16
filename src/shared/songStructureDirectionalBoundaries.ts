import { clamp, clamp01, percentile } from './songStructureCommon'
import type {
  SongStructureSpectralBarFeature,
  SongStructureSpectralValues
} from './songStructureSpectralFeatures'
import type {
  SongStructureSpectralBoundary,
  SongStructureSpectralClusteringResult
} from './songStructureSpectralClustering'

export type SongStructureDirectionalBoundaryKind = 'fall' | 'landing' | 'switch'

export type SongStructureDirectionalBoundaryEvent = {
  index: number
  kind: SongStructureDirectionalBoundaryKind
  score: number
  fallScore: number
  landingScore: number
  switchScore: number
  switchPersistence: number
}

export type SongStructureDirectionalBoundaryResult = {
  boundaries: SongStructureSpectralBoundary[]
  events: SongStructureDirectionalBoundaryEvent[]
}

const MIN_SECTION_DOWNBEATS = 3
const EVENT_NEIGHBOR_RADIUS = 1
const AUXILIARY_BOUNDARY_RADIUS = 2
const MAX_BOUNDARY_COUNT = 32
const MAX_FALL_LANDING_SPAN = 12
const MIN_PROTECTED_FALL_SCORE = 0.17
const LANDING_SWITCH_TIE_MARGIN = 0.01
const MIN_WEAK_SWITCH_SCORE = 0.065
const MIN_SWITCH_DOMINANCE = 0.012
const MIN_SWITCH_PERSISTENCE = 0.52
const PERSISTENT_FALL_RADIUS = 2
const MIN_PERSISTENT_FALL_RATIO = 0.72
const PRE_FALL_SWITCH_RADIUS = 3
const MIN_SWITCH_FALL_SHARE = 0.72

const createEmptyValues = (): SongStructureSpectralValues => ({
  energy: 0,
  low: 0,
  mid: 0,
  high: 0,
  attack: 0,
  attackDensity: 0,
  density: 0,
  brightness: 0,
  crest: 0,
  lowShare: 0,
  midShare: 0,
  highShare: 0
})

const averageValues = (
  bars: readonly SongStructureSpectralBarFeature[],
  startIndex: number,
  endIndex: number
) => {
  const start = clamp(Math.floor(startIndex), 0, bars.length)
  const end = clamp(Math.ceil(endIndex), start, bars.length)
  const result = createEmptyValues()
  if (end <= start) return result
  for (let index = start; index < end; index += 1) {
    const values = bars[index]?.values
    if (!values) continue
    for (const key of Object.keys(result) as Array<keyof SongStructureSpectralValues>) {
      result[key] += values[key] / (end - start)
    }
  }
  return result
}

const medianValues = (
  bars: readonly SongStructureSpectralBarFeature[],
  startIndex: number,
  endIndex: number
) => {
  const start = clamp(Math.floor(startIndex), 0, bars.length)
  const end = clamp(Math.ceil(endIndex), start, bars.length)
  const result = createEmptyValues()
  for (const key of Object.keys(result) as Array<keyof SongStructureSpectralValues>) {
    result[key] = percentile(
      bars.slice(start, end).map((bar) => bar.values[key]),
      0.5
    )
  }
  return result
}

const positiveDifference = (
  left: SongStructureSpectralValues,
  right: SongStructureSpectralValues
) =>
  clamp01(
    Math.max(0, left.energy - right.energy) * 0.2 +
      Math.max(0, left.low - right.low) * 0.25 +
      Math.max(0, left.mid - right.mid) * 0.08 +
      Math.max(0, left.high - right.high) * 0.06 +
      Math.max(0, left.attack - right.attack) * 0.08 +
      Math.max(0, left.attackDensity - right.attackDensity) * 0.14 +
      Math.max(0, left.density - right.density) * 0.19
  )

const resolveSwitchScore = (
  previous: SongStructureSpectralValues,
  current: SongStructureSpectralValues
) => {
  const energyDifference = Math.abs(current.energy - previous.energy)
  const timbreDifference =
    Math.abs(current.lowShare - previous.lowShare) * 0.25 +
    Math.abs(current.midShare - previous.midShare) * 0.22 +
    Math.abs(current.highShare - previous.highShare) * 0.2 +
    Math.abs(current.brightness - previous.brightness) * 0.18 +
    Math.abs(current.high - previous.high) * 0.15
  return clamp01(timbreDifference * (1 - clamp01(energyDifference / 0.28) * 0.35))
}

const resolveSwitchPersistence = (stepSwitch: number, sustainedSwitch: number, stability: number) =>
  clamp01(rampRatio(sustainedSwitch, Math.max(0.012, stepSwitch * 0.72)) * 0.8 + stability * 0.2)

const rampRatio = (value: number, target: number) => clamp01(value / Math.max(1e-6, target))

const resolvePostStability = (bars: readonly SongStructureSpectralBarFeature[], index: number) => {
  const start = clamp(index, 0, bars.length - 1)
  const end = clamp(index + 4, start + 1, bars.length)
  if (end - start <= 1) return 0.5
  let volatility = 0
  let count = 0
  for (let cursor = start + 1; cursor < end; cursor += 1) {
    const previous = bars[cursor - 1]?.values
    const current = bars[cursor]?.values
    if (!previous || !current) continue
    volatility +=
      Math.abs(current.energy - previous.energy) * 0.22 +
      Math.abs(current.low - previous.low) * 0.25 +
      Math.abs(current.attackDensity - previous.attackDensity) * 0.2 +
      Math.abs(current.density - previous.density) * 0.2 +
      Math.abs(current.brightness - previous.brightness) * 0.13
    count += 1
  }
  return 1 - clamp01(volatility / Math.max(1, count) / 0.12)
}

const buildDirectionalEvents = (bars: readonly SongStructureSpectralBarFeature[]) => {
  const events: SongStructureDirectionalBoundaryEvent[] = []
  for (let index = 1; index < bars.length; index += 1) {
    const previousBar = bars[index - 1]?.values
    const currentBar = bars[index]?.values
    if (!previousBar || !currentBar) continue
    const before = averageValues(bars, index - 2, index)
    const after = averageValues(bars, index, index + 2)
    const stepFall = positiveDifference(previousBar, currentBar)
    const contextFall = positiveDifference(before, after)
    const stepLanding = positiveDifference(currentBar, previousBar)
    const contextLanding = positiveDifference(after, before)
    const stability = resolvePostStability(bars, index)
    const fallScore = clamp01((stepFall * 0.7 + contextFall * 0.3) * (0.86 + stability * 0.14))
    const landingScore = clamp01(
      (stepLanding * 0.72 + contextLanding * 0.28) * (0.78 + stability * 0.22)
    )
    const stepSwitch = resolveSwitchScore(previousBar, currentBar)
    const switchReference = medianValues(bars, index - 4, index)
    const sustainedState = medianValues(bars, index + 1, index + 5)
    const sustainedSwitch = resolveSwitchScore(switchReference, sustainedState)
    const switchPersistence = resolveSwitchPersistence(stepSwitch, sustainedSwitch, stability)
    const switchScore = clamp01(
      (stepSwitch * 0.35 + sustainedSwitch * 0.65) * (0.76 + switchPersistence * 0.24)
    )
    const score = Math.max(fallScore, landingScore, switchScore)
    const hasSustainedLanding =
      contextLanding >= Math.max(0.018, stepLanding * 0.32) && stability >= 0.45
    const kind: SongStructureDirectionalBoundaryKind =
      fallScore >= landingScore && fallScore >= switchScore
        ? 'fall'
        : landingScore >= switchScore ||
            (hasSustainedLanding && landingScore >= switchScore - LANDING_SWITCH_TIE_MARGIN)
          ? 'landing'
          : 'switch'
    events.push({
      index,
      kind,
      score,
      fallScore,
      landingScore,
      switchScore,
      switchPersistence
    })
  }
  return events
}

const isSupportedSwitch = (
  event: SongStructureDirectionalBoundaryEvent,
  strongFloor: number,
  spectralBoundaryIndexes: readonly number[]
) => {
  if (event.kind !== 'switch') return true
  const alternativeScore = Math.max(event.fallScore, event.landingScore)
  const hasSpectralSupport = spectralBoundaryIndexes.some(
    (index) => Math.abs(index - event.index) <= AUXILIARY_BOUNDARY_RADIUS
  )
  return (
    event.switchScore >= alternativeScore + MIN_SWITCH_DOMINANCE &&
    event.switchPersistence >= MIN_SWITCH_PERSISTENCE &&
    (event.switchScore >= strongFloor ||
      event.switchScore >= MIN_WEAK_SWITCH_SCORE ||
      hasSpectralSupport)
  )
}

const refinePersistentFallEvent = (
  event: SongStructureDirectionalBoundaryEvent,
  eventsByIndex: ReadonlyMap<number, SongStructureDirectionalBoundaryEvent>,
  adaptiveFloor: number
) => {
  if (event.kind !== 'fall') return event
  let refined = event
  for (let offset = 1; offset <= PERSISTENT_FALL_RADIUS; offset += 1) {
    const later = eventsByIndex.get(event.index + offset)
    if (
      later?.kind === 'fall' &&
      later.fallScore >= adaptiveFloor * 0.9 &&
      later.fallScore >= event.fallScore * MIN_PERSISTENT_FALL_RATIO
    ) {
      refined = later
    }
  }
  return refined
}

const removePreFallSwitchEvents = (events: readonly SongStructureDirectionalBoundaryEvent[]) =>
  events.filter((event) => {
    if (event.kind !== 'switch' || event.fallScore < event.switchScore * MIN_SWITCH_FALL_SHARE) {
      return true
    }
    return !events.some(
      (candidate) =>
        candidate.kind === 'fall' &&
        candidate.index > event.index &&
        candidate.index - event.index <= PRE_FALL_SWITCH_RADIUS &&
        candidate.fallScore >= event.score
    )
  })

const isLocalPeak = (
  event: SongStructureDirectionalBoundaryEvent,
  eventsByIndex: ReadonlyMap<number, SongStructureDirectionalBoundaryEvent>
) => {
  for (let offset = -EVENT_NEIGHBOR_RADIUS; offset <= EVENT_NEIGHBOR_RADIUS; offset += 1) {
    if (offset === 0) continue
    const neighbor = eventsByIndex.get(event.index + offset)
    if (!neighbor || neighbor.kind !== event.kind) continue
    if (neighbor.score > event.score + 1e-8) return false
    if (Math.abs(neighbor.score - event.score) <= 1e-8) {
      if (event.kind === 'fall' && neighbor.index < event.index) return false
      if (event.kind !== 'fall' && neighbor.index > event.index) return false
    }
  }
  return true
}

const eventToBoundary = (event: SongStructureDirectionalBoundaryEvent) => ({
  index: event.index,
  score: clamp01(event.score * 3.2),
  buildRamp: 0
})

const compactBoundaries = (
  boundaries: readonly SongStructureSpectralBoundary[],
  eventsByIndex: ReadonlyMap<number, SongStructureDirectionalBoundaryEvent>,
  barCount: number
) => {
  const sorted = [...boundaries]
    .filter(
      (boundary) =>
        boundary.index >= MIN_SECTION_DOWNBEATS &&
        boundary.index <= barCount - MIN_SECTION_DOWNBEATS
    )
    .sort((left, right) => left.index - right.index || right.score - left.score)
  const compacted: SongStructureSpectralBoundary[] = []
  for (const boundary of sorted) {
    const previous = compacted.at(-1)
    if (!previous || boundary.index - previous.index >= MIN_SECTION_DOWNBEATS) {
      compacted.push(boundary)
      continue
    }
    const previousEvent = eventsByIndex.get(previous.index)
    const currentEvent = eventsByIndex.get(boundary.index)
    const opposingTransition =
      previousEvent &&
      currentEvent &&
      previousEvent.kind !== currentEvent.kind &&
      previousEvent.kind !== 'switch' &&
      currentEvent.kind !== 'switch'
    if (opposingTransition && boundary.index - previous.index >= 2) {
      compacted.push(boundary)
      continue
    }
    if (boundary.score > previous.score) compacted[compacted.length - 1] = boundary
  }
  if (compacted.length <= MAX_BOUNDARY_COUNT) return compacted
  return compacted
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, MAX_BOUNDARY_COUNT)
    .sort((left, right) => left.index - right.index)
}

const removeFallLandingInteriorSwitches = (
  boundaries: readonly SongStructureSpectralBoundary[],
  events: readonly SongStructureDirectionalBoundaryEvent[],
  eventsByIndex: ReadonlyMap<number, SongStructureDirectionalBoundaryEvent>,
  adaptiveFloor: number,
  strongFloor: number
) => {
  const protectedSpans = events.flatMap((event) => {
    if (event.kind !== 'fall' || event.score < Math.max(strongFloor, MIN_PROTECTED_FALL_SCORE)) {
      return []
    }
    const landing = events.find(
      (candidate) =>
        candidate.index > event.index &&
        candidate.index - event.index <= MAX_FALL_LANDING_SPAN &&
        candidate.kind === 'landing' &&
        candidate.landingScore >= adaptiveFloor
    )
    return landing ? [{ startIndex: event.index, endIndex: landing.index }] : []
  })
  if (!protectedSpans.length) return [...boundaries]
  return boundaries.filter((boundary) => {
    const event = eventsByIndex.get(boundary.index)
    if (event?.kind !== 'switch') return true
    return !protectedSpans.some(
      (span) => boundary.index > span.startIndex && boundary.index < span.endIndex
    )
  })
}

export const buildSongStructureDirectionalBoundaries = (
  bars: readonly SongStructureSpectralBarFeature[],
  spectralClustering: SongStructureSpectralClusteringResult
): SongStructureDirectionalBoundaryResult => {
  const events = buildDirectionalEvents(bars)
  const eventsByIndex = new Map(events.map((event) => [event.index, event]))
  const scores = events.map((event) => event.score)
  const adaptiveFloor = Math.max(0.045, percentile(scores, 0.72))
  const strongFloor = Math.max(0.075, percentile(scores, 0.88))
  const spectralBoundaryIndexes = spectralClustering.boundaries
    .slice(1, -1)
    .map((boundary) => boundary.index)
  const directionalEvents = removePreFallSwitchEvents(
    events
      .filter(
        (event) =>
          event.score >= adaptiveFloor &&
          isSupportedSwitch(event, strongFloor, spectralBoundaryIndexes) &&
          (event.score >= strongFloor || isLocalPeak(event, eventsByIndex))
      )
      .map((event) => refinePersistentFallEvent(event, eventsByIndex, adaptiveFloor))
      .filter(
        (event, index, selected) =>
          selected.findIndex((candidate) => candidate.index === event.index) === index
      )
  )
  const directional = directionalEvents.map(eventToBoundary)
  const auxiliary = spectralClustering.boundaries.slice(1, -1).flatMap((boundary) => {
    const nearbyDirectional = directional.some(
      (candidate) => Math.abs(candidate.index - boundary.index) <= AUXILIARY_BOUNDARY_RADIUS
    )
    if (nearbyDirectional) return []
    const event = eventsByIndex.get(boundary.index)
    if (
      !event ||
      event.score < adaptiveFloor * 0.72 ||
      !isSupportedSwitch(event, strongFloor, spectralBoundaryIndexes)
    ) {
      return []
    }
    return [{ ...boundary, score: Math.max(boundary.score * 0.72, event.score * 2.4) }]
  })
  const transitionProtected = removeFallLandingInteriorSwitches(
    [...directional, ...auxiliary],
    events,
    eventsByIndex,
    adaptiveFloor,
    strongFloor
  )
  const compacted = compactBoundaries(transitionProtected, eventsByIndex, bars.length)
  return {
    boundaries: [
      { index: 0, score: 0, buildRamp: 0 },
      ...compacted,
      { index: bars.length, score: 0, buildRamp: 0 }
    ],
    events
  }
}
