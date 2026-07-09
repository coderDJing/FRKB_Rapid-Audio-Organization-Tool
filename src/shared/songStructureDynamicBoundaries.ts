import { toFixedNumber, type BuildSongStructureInput } from './songStructureCommon'
import { createSongBeatGridRuntime, type SongBeatGridRuntime } from './songBeatGridMap'

const DYNAMIC_BOUNDARY_MIN_GAP_SEC = 2
const DYNAMIC_PHRASE_BOUNDARY_PRIORITY = 1
const DYNAMIC_CLIP_BOUNDARY_PRIORITY = 2

type DynamicBoundaryCandidate = {
  sec: number
  priority: number
}

type DynamicPhraseBoundaries = {
  runtime: SongBeatGridRuntime
  boundaries: number[]
}

const normalizeBoundarySec = (sec: number) => toFixedNumber(Math.max(0, sec), 4)

const isInnerBoundarySec = (sec: number, durationSec: number) =>
  sec > DYNAMIC_BOUNDARY_MIN_GAP_SEC && sec < durationSec - DYNAMIC_BOUNDARY_MIN_GAP_SEC

const pushCandidate = (
  candidates: DynamicBoundaryCandidate[],
  secInput: number,
  priority: number,
  durationSec: number
) => {
  if (!Number.isFinite(secInput) || !isInnerBoundarySec(secInput, durationSec)) return
  candidates.push({
    sec: normalizeBoundarySec(secInput),
    priority
  })
}

const buildBoundariesFromCandidates = (
  candidates: readonly DynamicBoundaryCandidate[],
  durationSec: number
) => {
  const selected: DynamicBoundaryCandidate[] = []
  for (const candidate of [...candidates].sort(
    (left, right) => left.sec - right.sec || right.priority - left.priority
  )) {
    const last = selected[selected.length - 1]
    if (!last || candidate.sec - last.sec >= DYNAMIC_BOUNDARY_MIN_GAP_SEC) {
      selected.push(candidate)
      continue
    }
    if (candidate.priority > last.priority) {
      selected[selected.length - 1] = candidate
    }
  }

  const boundaries = [0, ...selected.map((candidate) => candidate.sec)]
  const lastBoundary = boundaries[boundaries.length - 1] ?? 0
  if (durationSec - lastBoundary >= DYNAMIC_BOUNDARY_MIN_GAP_SEC) {
    boundaries.push(toFixedNumber(durationSec, 4))
  } else {
    boundaries[boundaries.length - 1] = toFixedNumber(durationSec, 4)
  }
  return boundaries
}

export const buildDynamicPhraseBoundaries = (
  input: BuildSongStructureInput,
  durationSec: number
): DynamicPhraseBoundaries | null => {
  const runtime = createSongBeatGridRuntime(input.beatGridMap, durationSec)
  if (!runtime) return null

  const rawBarLines = runtime.lines.filter(
    (line) => line.level === 'bar' && line.sec > 0 && line.sec < durationSec
  )
  if (rawBarLines.length < 1) return null

  const barLines = rawBarLines.filter((line) => isInnerBoundarySec(line.sec, durationSec))

  const candidates: DynamicBoundaryCandidate[] = []
  for (const clip of runtime.clips) {
    if (clip.index > 0) {
      pushCandidate(candidates, clip.startSec, DYNAMIC_CLIP_BOUNDARY_PRIORITY, durationSec)
    }

    const clipBarLines = barLines.filter((line) => line.clipIndex === clip.index)
    for (const line of clipBarLines) {
      pushCandidate(candidates, line.sec, DYNAMIC_PHRASE_BOUNDARY_PRIORITY, durationSec)
    }
  }

  return {
    runtime,
    boundaries: buildBoundariesFromCandidates(candidates, durationSec)
  }
}
