import type { HorizontalBrowseDirection } from '@renderer/components/horizontalBrowseRawWaveformCanvasTypes'

type LinkedGridSample = {
  active: boolean
  atMs: number
  epochMs: number
  bpm: number
  beatSec: number
  currentSec: number
  beatDistance: number
  beatPhase: number
  barBeatOffset: number
}

type LinkedGridRenderClockSample = {
  atMs: number
  epochMs: number
  seconds: number
}

type LinkedGridVisualPhaseInput = {
  direction: HorizontalBrowseDirection
  active: boolean
  clockActive: boolean
  bpm: number
  firstBeatMs: number
  barBeatOffset: number
  currentSec: number
  playbackRate: number
}

type LinkedGridVisualPhaseResult = {
  barBeatOffset: number
  sourceBarBeatOffset: number
  playbackSeconds: number
  sourcePlaybackSeconds: number
  playbackRenderClockEpochMs: number | null
  playbackClockLinked: boolean
  phaseShiftSec: number
  linked: boolean
  referenceDirection: HorizontalBrowseDirection | null
}

const BAR_BEAT_INTERVAL = 32
const LINKED_GRID_SAMPLE_MAX_AGE_MS = 1000
const LINKED_GRID_BPM_EPSILON = 0.001
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

const resolveSignedCircularDelta = (left: number, right: number, modulo: number) => {
  const normalized = normalizePhase(left - right, modulo)
  return normalized > modulo / 2 ? normalized - modulo : normalized
}

const normalizeBarBeatOffset = (value: number) =>
  normalizePhase(Math.round(Number.isFinite(value) ? value : 0), BAR_BEAT_INTERVAL)

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
  const firstBeatSec = (Number(input.firstBeatMs) || 0) / 1000
  if (!input.active || !Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(currentSec)) {
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
    beatSec,
    currentSec,
    beatDistance,
    beatPhase: normalizePhase(beatDistance, 1),
    barBeatOffset: normalizeBarBeatOffset(input.barBeatOffset)
  }
}

const canLinkSamples = (
  current: LinkedGridSample,
  reference: LinkedGridSample | null | undefined,
  nowMs: number,
  clockActive: boolean,
  playbackRate: number
) => {
  if (!reference?.active) return false
  if (nowMs - reference.atMs > LINKED_GRID_SAMPLE_MAX_AGE_MS) return false
  if (Math.abs(current.bpm - reference.bpm) > LINKED_GRID_BPM_EPSILON) return false
  const clockDeltaSec = clockActive
    ? ((current.epochMs - reference.epochMs) / 1000) * playbackRate
    : 0
  const referenceBeatDistance =
    reference.beatDistance + (reference.beatSec > 0 ? clockDeltaSec / reference.beatSec : 0)
  const referenceBeatPhase = normalizePhase(referenceBeatDistance, 1)
  return (
    resolveCircularDelta(current.beatPhase, referenceBeatPhase, 1) <= LINKED_GRID_BEAT_PHASE_EPSILON
  )
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

export const resolveHorizontalBrowseLinkedGridVisualPhase = (
  input: LinkedGridVisualPhaseInput
): LinkedGridVisualPhaseResult => {
  const sourceBarBeatOffset = normalizeBarBeatOffset(input.barBeatOffset)
  const sourcePlaybackSeconds = Number(input.currentSec) || 0
  const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const currentSample = buildSample(input, nowMs)
  samples[input.direction] = currentSample ?? {
    active: false,
    atMs: nowMs,
    epochMs: resolveEpochMs(nowMs),
    bpm: 0,
    beatSec: 0,
    currentSec: sourcePlaybackSeconds,
    beatDistance: 0,
    beatPhase: 0,
    barBeatOffset: sourceBarBeatOffset
  }
  if (!currentSample) {
    return {
      barBeatOffset: sourceBarBeatOffset,
      sourceBarBeatOffset,
      playbackSeconds: sourcePlaybackSeconds,
      sourcePlaybackSeconds,
      playbackRenderClockEpochMs: null,
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
  const playbackRate = Math.max(0.25, Number(input.playbackRate) || 1)
  const linkedToCounterpart =
    !!reference &&
    reference !== currentSample &&
    canLinkSamples(currentSample, reference, nowMs, input.clockActive, playbackRate)
  if (input.direction === 'up' && linkedToCounterpart) {
    return {
      barBeatOffset: sourceBarBeatOffset,
      sourceBarBeatOffset,
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
      barBeatOffset: sourceBarBeatOffset,
      sourceBarBeatOffset,
      playbackSeconds: sourcePlaybackSeconds,
      sourcePlaybackSeconds,
      playbackRenderClockEpochMs: currentSample.epochMs,
      playbackClockLinked: false,
      phaseShiftSec: 0,
      linked: false,
      referenceDirection: null
    }
  }

  const clockDeltaSec = input.clockActive
    ? ((currentSample.epochMs - reference.epochMs) / 1000) * playbackRate
    : 0
  const referenceBeatDistance =
    reference.beatDistance + (reference.beatSec > 0 ? clockDeltaSec / reference.beatSec : 0)
  const referenceBarPhase = normalizePhase(referenceBeatDistance - reference.barBeatOffset, 32)
  const barBeatOffset = normalizeBarBeatOffset(currentSample.beatDistance - referenceBarPhase)
  const currentBarPhase = normalizePhase(currentSample.beatDistance - barBeatOffset, 32)
  const phaseShiftSec =
    resolveSignedCircularDelta(currentBarPhase, referenceBarPhase, 32) * currentSample.beatSec
  return {
    barBeatOffset,
    sourceBarBeatOffset,
    playbackSeconds: sourcePlaybackSeconds - clockDeltaSec - phaseShiftSec,
    sourcePlaybackSeconds,
    playbackRenderClockEpochMs: reference.epochMs,
    playbackClockLinked: true,
    phaseShiftSec,
    linked: true,
    referenceDirection
  }
}
