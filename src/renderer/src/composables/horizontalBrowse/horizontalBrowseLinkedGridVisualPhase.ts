import type { HorizontalBrowseDirection } from '@renderer/composables/horizontalBrowse/horizontalBrowseRawWaveformCanvasTypes'

type LinkedGridSample = {
  active: boolean
  atMs: number
  epochMs: number
  bpm: number
  playbackRate: number
  effectiveBpm: number
  beatSec: number
  currentSec: number
  beatDistance: number
  beatPhase: number
  downbeatBeatOffset: number
}

type LinkedGridRenderClockSample = {
  atMs: number
  epochMs: number
  seconds: number
}

export type LinkedGridVisualPhaseInput = {
  direction: HorizontalBrowseDirection
  active: boolean
  clockActive: boolean
  bpm: number
  firstBeatMs: number
  downbeatBeatOffset: number
  currentSec: number
  playbackRate: number
  phaseLocked?: boolean
}

type LinkedGridVisualPhaseResult = {
  downbeatBeatOffset: number
  sourceDownbeatBeatOffset: number
  playbackSeconds: number
  sourcePlaybackSeconds: number
  playbackRenderClockEpochMs: number | null
  playbackClockLinked: boolean
  phaseShiftSec: number
  linked: boolean
  referenceDirection: HorizontalBrowseDirection | null
}

const DOWNBEAT_BEAT_INTERVAL = 4
const LINKED_GRID_SAMPLE_MAX_AGE_MS = 1000
const LINKED_GRID_BPM_EPSILON = 0.001
const LINKED_GRID_EFFECTIVE_BPM_EPSILON = 0.01
const LINKED_GRID_BEAT_PHASE_EPSILON = 0.05
const LINKED_GRID_CLOCK_SECONDS_EPSILON = 0.25

const samples: Partial<Record<HorizontalBrowseDirection, LinkedGridSample>> = {}
const renderClockSamples: Partial<Record<HorizontalBrowseDirection, LinkedGridRenderClockSample>> =
  {}

const resolveEpochMs = (atMs: number) => {
  if (typeof performance === 'undefined') return Date.now()
  const timeOrigin = Number(performance.timeOrigin)
  return (Number.isFinite(timeOrigin) ? timeOrigin : Date.now() - performance.now()) + atMs
}

const normalizePhase = (value: number, modulo: number) => {
  if (!Number.isFinite(value) || !Number.isFinite(modulo) || modulo <= 0) return 0
  return ((value % modulo) + modulo) % modulo
}

const resolveCircularDelta = (left: number, right: number, modulo: number) => {
  const normalized = normalizePhase(left - right, modulo)
  return normalized > modulo / 2 ? modulo - normalized : normalized
}

const normalizeDownbeatBeatOffset = (value: number) =>
  normalizePhase(Math.round(Number.isFinite(value) ? value : 0), DOWNBEAT_BEAT_INTERVAL)

const resolveRenderClockSample = (
  direction: HorizontalBrowseDirection,
  currentSec: number,
  nowMs: number
) => {
  const sample = renderClockSamples[direction]
  if (!sample) return null
  if (nowMs - sample.atMs > LINKED_GRID_SAMPLE_MAX_AGE_MS) return null
  if (Math.abs(sample.seconds - currentSec) > LINKED_GRID_CLOCK_SECONDS_EPSILON) return null
  return sample
}

const buildSample = (input: LinkedGridVisualPhaseInput, nowMs: number): LinkedGridSample | null => {
  const bpm = Number(input.bpm)
  const currentSec = Number(input.currentSec)
  const playbackRate = Math.max(0.25, Number(input.playbackRate) || 1)
  const effectiveBpm = bpm * playbackRate
  const firstBeatSec = (Number(input.firstBeatMs) || 0) / 1000
  if (
    !input.active ||
    !Number.isFinite(bpm) ||
    bpm <= 0 ||
    !Number.isFinite(effectiveBpm) ||
    effectiveBpm <= 0 ||
    !Number.isFinite(currentSec)
  ) {
    return null
  }
  const beatSec = 60 / bpm
  if (!Number.isFinite(beatSec) || beatSec <= 0) return null
  const beatDistance = (currentSec - firstBeatSec) / beatSec
  if (!Number.isFinite(beatDistance)) return null
  const renderClock = resolveRenderClockSample(input.direction, currentSec, nowMs)
  return {
    active: true,
    atMs: renderClock?.atMs ?? nowMs,
    epochMs: renderClock?.epochMs ?? resolveEpochMs(nowMs),
    bpm,
    playbackRate,
    effectiveBpm,
    beatSec,
    currentSec,
    beatDistance,
    beatPhase: normalizePhase(beatDistance, 1),
    downbeatBeatOffset: normalizeDownbeatBeatOffset(input.downbeatBeatOffset)
  }
}

const canLinkSamples = (
  current: LinkedGridSample,
  reference: LinkedGridSample | null | undefined,
  nowMs: number,
  clockActive: boolean
) => {
  if (!reference?.active) return false
  if (nowMs - reference.atMs > LINKED_GRID_SAMPLE_MAX_AGE_MS) return false
  const rawBpmLinked = Math.abs(current.bpm - reference.bpm) <= LINKED_GRID_BPM_EPSILON
  const effectiveBpmLinked =
    Math.abs(current.effectiveBpm - reference.effectiveBpm) <= LINKED_GRID_EFFECTIVE_BPM_EPSILON
  if (!rawBpmLinked && !effectiveBpmLinked) return false
  if (!rawBpmLinked && effectiveBpmLinked) return true
  const clockDeltaSec = clockActive
    ? ((current.epochMs - reference.epochMs) / 1000) * reference.playbackRate
    : 0
  const referenceBeatDistance =
    reference.beatDistance + (reference.beatSec > 0 ? clockDeltaSec / reference.beatSec : 0)
  const referenceBeatPhase = normalizePhase(referenceBeatDistance, 1)
  return (
    resolveCircularDelta(current.beatPhase, referenceBeatPhase, 1) <= LINKED_GRID_BEAT_PHASE_EPSILON
  )
}

const canLinkByEffectiveBpmOnly = (current: LinkedGridSample, reference: LinkedGridSample) => {
  const rawBpmLinked = Math.abs(current.bpm - reference.bpm) <= LINKED_GRID_BPM_EPSILON
  const effectiveBpmLinked =
    Math.abs(current.effectiveBpm - reference.effectiveBpm) <= LINKED_GRID_EFFECTIVE_BPM_EPSILON
  return !rawBpmLinked && effectiveBpmLinked
}

export const publishHorizontalBrowseLinkedGridRenderClock = (
  direction: HorizontalBrowseDirection,
  seconds: number,
  atMs = typeof performance !== 'undefined' ? performance.now() : Date.now()
) => {
  renderClockSamples[direction] = {
    atMs,
    epochMs: resolveEpochMs(atMs),
    seconds: Number.isFinite(seconds) ? seconds : 0
  }
}

export const publishHorizontalBrowseLinkedGridRenderClockPair = (
  upSeconds: number,
  downSeconds: number,
  atMs = typeof performance !== 'undefined' ? performance.now() : Date.now()
) => {
  publishHorizontalBrowseLinkedGridRenderClock('up', upSeconds, atMs)
  publishHorizontalBrowseLinkedGridRenderClock('down', downSeconds, atMs)
}

export const publishHorizontalBrowseLinkedGridVisualPhaseSample = (
  input: LinkedGridVisualPhaseInput,
  atMs = typeof performance !== 'undefined' ? performance.now() : Date.now()
) => {
  const sample = buildSample(input, atMs)
  if (!sample) return false
  samples[input.direction] = sample
  return true
}

export const resolveHorizontalBrowseLinkedGridVisualPhase = (
  input: LinkedGridVisualPhaseInput
): LinkedGridVisualPhaseResult => {
  const sourceDownbeatBeatOffset = normalizeDownbeatBeatOffset(input.downbeatBeatOffset)
  const sourcePlaybackSeconds = Number(input.currentSec) || 0
  const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const currentSample = buildSample(input, nowMs)
  samples[input.direction] = currentSample ?? {
    active: false,
    atMs: nowMs,
    epochMs: resolveEpochMs(nowMs),
    bpm: 0,
    playbackRate: 1,
    effectiveBpm: 0,
    beatSec: 0,
    currentSec: sourcePlaybackSeconds,
    beatDistance: 0,
    beatPhase: 0,
    downbeatBeatOffset: sourceDownbeatBeatOffset
  }
  if (!currentSample) {
    return {
      downbeatBeatOffset: sourceDownbeatBeatOffset,
      sourceDownbeatBeatOffset,
      playbackSeconds: sourcePlaybackSeconds,
      sourcePlaybackSeconds,
      playbackRenderClockEpochMs: null,
      playbackClockLinked: false,
      phaseShiftSec: 0,
      linked: false,
      referenceDirection: null
    }
  }
  if (input.phaseLocked === true) {
    return {
      downbeatBeatOffset: sourceDownbeatBeatOffset,
      sourceDownbeatBeatOffset,
      playbackSeconds: sourcePlaybackSeconds,
      sourcePlaybackSeconds,
      playbackRenderClockEpochMs: currentSample.epochMs,
      playbackClockLinked: false,
      phaseShiftSec: 0,
      linked: false,
      referenceDirection: null
    }
  }

  const counterpartDirection: HorizontalBrowseDirection = input.direction === 'up' ? 'down' : 'up'
  const referenceDirection: HorizontalBrowseDirection | null =
    input.direction === 'down' ? 'up' : null
  const reference = referenceDirection ? samples[referenceDirection] : samples[counterpartDirection]
  const linkedToCounterpart =
    !!reference &&
    reference !== currentSample &&
    canLinkSamples(currentSample, reference, nowMs, input.clockActive)
  if (input.direction === 'up' && linkedToCounterpart) {
    return {
      downbeatBeatOffset: sourceDownbeatBeatOffset,
      sourceDownbeatBeatOffset,
      playbackSeconds: sourcePlaybackSeconds,
      sourcePlaybackSeconds,
      playbackRenderClockEpochMs: currentSample.epochMs,
      playbackClockLinked: false,
      phaseShiftSec: 0,
      linked: true,
      referenceDirection: null
    }
  }
  if (!referenceDirection || !reference || !linkedToCounterpart) {
    return {
      downbeatBeatOffset: sourceDownbeatBeatOffset,
      sourceDownbeatBeatOffset,
      playbackSeconds: sourcePlaybackSeconds,
      sourcePlaybackSeconds,
      playbackRenderClockEpochMs: currentSample.epochMs,
      playbackClockLinked: false,
      phaseShiftSec: 0,
      linked: false,
      referenceDirection: null
    }
  }
  if (canLinkByEffectiveBpmOnly(currentSample, reference)) {
    const currentClockDeltaSec = input.clockActive
      ? ((currentSample.epochMs - reference.epochMs) / 1000) * currentSample.playbackRate
      : 0
    return {
      downbeatBeatOffset: sourceDownbeatBeatOffset,
      sourceDownbeatBeatOffset,
      playbackSeconds: sourcePlaybackSeconds - currentClockDeltaSec,
      sourcePlaybackSeconds,
      playbackRenderClockEpochMs: reference.epochMs,
      playbackClockLinked: true,
      phaseShiftSec: 0,
      linked: true,
      referenceDirection
    }
  }

  const clockDeltaSec = input.clockActive
    ? ((currentSample.epochMs - reference.epochMs) / 1000) * reference.playbackRate
    : 0
  return {
    downbeatBeatOffset: sourceDownbeatBeatOffset,
    sourceDownbeatBeatOffset,
    playbackSeconds: sourcePlaybackSeconds - clockDeltaSec,
    sourcePlaybackSeconds,
    playbackRenderClockEpochMs: reference.epochMs,
    playbackClockLinked: true,
    phaseShiftSec: 0,
    linked: true,
    referenceDirection
  }
}
