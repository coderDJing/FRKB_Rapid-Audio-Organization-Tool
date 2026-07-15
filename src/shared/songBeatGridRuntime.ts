import { createSongBeatGridRuntimeV2, type SongBeatGridLineLevelV2 } from './songBeatGridMapV2'

export type UnifiedSongBeatGridLineLevel = SongBeatGridLineLevelV2

export type UnifiedSongBeatGridLine = {
  sec: number
  clipIndex: number
  beatOrdinal: number
  clipBeatIndex: number
  bpm: number
  level: SongBeatGridLineLevelV2
}

export type UnifiedSongBeatGridRuntimeClip = {
  index: number
  startSec: number
  endSec: number
  anchorSec: number
  bpm: number
  beatSec: number
  firstBeatIndex: number
  lastBeatIndex: number
  firstBeatOrdinal: number
  lineCount: number
}

export type UnifiedSongBeatGridRuntime = {
  signature: string
  durationSec: number
  clips: UnifiedSongBeatGridRuntimeClip[]
  lines: UnifiedSongBeatGridLine[]
  clipBoundaries: number[]
}

export const createUnifiedSongBeatGridRuntime = (
  value: unknown,
  durationSec: unknown
): UnifiedSongBeatGridRuntime | null => {
  const v2 = createSongBeatGridRuntimeV2(value, durationSec)
  if (!v2) return null
  return {
    signature: v2.signature,
    durationSec: v2.durationSec,
    clips: v2.clips,
    lines: v2.lines,
    clipBoundaries: v2.clipBoundaries
  }
}

export const resolveNearestUnifiedSongBeatGridLine = (
  value: unknown,
  durationSec: unknown,
  secInput: unknown,
  options: { minSec?: number; maxSec?: number; levels?: SongBeatGridLineLevelV2[] } = {}
): UnifiedSongBeatGridLine | null => {
  const runtime = createUnifiedSongBeatGridRuntime(value, durationSec)
  if (!runtime) return null
  const sec = Math.max(0, Math.min(runtime.durationSec, Number(secInput) || 0))
  const minSec = Number.isFinite(Number(options.minSec)) ? Number(options.minSec) : 0
  const maxSec = Number.isFinite(Number(options.maxSec))
    ? Number(options.maxSec)
    : runtime.durationSec
  const levels = Array.isArray(options.levels) ? new Set(options.levels) : null
  let nearest: UnifiedSongBeatGridLine | null = null
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const line of runtime.lines) {
    if (line.sec < minSec || line.sec > maxSec) continue
    if (levels && !levels.has(line.level)) continue
    const distance = Math.abs(line.sec - sec)
    if (distance >= nearestDistance) continue
    nearest = line
    nearestDistance = distance
  }
  return nearest
}

export const resolveUnifiedSongBeatGridSecAtBeatOrdinal = (
  value: unknown,
  durationSec: unknown,
  beatOrdinalInput: unknown
): number | null => {
  const runtime = createUnifiedSongBeatGridRuntime(value, durationSec)
  if (!runtime) return null
  const beatOrdinal = Number(beatOrdinalInput)
  if (!Number.isFinite(beatOrdinal)) return null
  const lines = runtime.lines
  const firstLine = lines[0]
  const lastLine = lines[lines.length - 1]
  if (!firstLine || !lastLine) return null
  if (beatOrdinal <= firstLine.beatOrdinal) return 0
  if (beatOrdinal >= lastLine.beatOrdinal) return runtime.durationSec
  const leftOrdinal = Math.floor(beatOrdinal)
  const rightOrdinal = Math.ceil(beatOrdinal)
  const leftLine = lines.find((line) => line.beatOrdinal === leftOrdinal)
  const rightLine = lines.find((line) => line.beatOrdinal === rightOrdinal)
  if (!leftLine || !rightLine) return null
  if (leftOrdinal === rightOrdinal) return leftLine.sec
  return Number(
    (leftLine.sec + (rightLine.sec - leftLine.sec) * (beatOrdinal - leftOrdinal)).toFixed(6)
  )
}
