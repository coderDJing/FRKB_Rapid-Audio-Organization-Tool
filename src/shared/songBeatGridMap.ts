export const SONG_BEAT_GRID_MAP_VERSION = 1
export const SONG_BEAT_GRID_BAR_BEAT_INTERVAL = 32

const SIGNATURE_HASH_OFFSET = 2166136261
const SIGNATURE_HASH_PRIME = 16777619
const SECONDS_DECIMALS = 6
const BPM_DECIMALS = 6
const BPM_DISPLAY_DECIMALS = 2
const BPM_DISPLAY_SCALE = 10 ** BPM_DISPLAY_DECIMALS
const PHASE_EPSILON_BEATS = 0.0001
const LINE_EPSILON_SEC = 0.000001

export type SongBeatGridClip = {
  startSec: number
  anchorSec: number
  bpm: number
  barBeatOffset: number
}

export type SongBeatGridMap = {
  version: number
  source: 'manual'
  clips: SongBeatGridClip[]
  signature: string
}

export type SongBeatGridFixedProjection = {
  bpm: number
  firstBeatMs: number
  barBeatOffset: number
}

export type SongBeatGridBpmSummary = {
  displayText: string
  titleText: string
  values: number[]
  minimumBpm: number | null
  isDynamic: boolean
}

export type SongBeatGridLineLevel = 'bar' | 'beat4' | 'beat'

export type SongBeatGridLine = {
  sec: number
  clipIndex: number
  beatOrdinal: number
  clipBeatIndex: number
  bpm: number
  level: SongBeatGridLineLevel
}

export type SongBeatGridRuntimeClip = SongBeatGridClip & {
  index: number
  endSec: number
  beatSec: number
  firstBeatIndex: number
  lastBeatIndex: number
  firstBeatOrdinal: number
  lineCount: number
}

export type SongBeatGridRuntime = {
  map: SongBeatGridMap
  signature: string
  durationSec: number
  clips: SongBeatGridRuntimeClip[]
  lines: SongBeatGridLine[]
  clipBoundaries: number[]
}

export type NormalizeSongBeatGridMapOptions = {
  durationSec?: number
  allowSingleClip?: boolean
  mergeContinuousClips?: boolean
}

const normalizePositiveNumber = (value: unknown, decimals: number): number | null => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return Number(numeric.toFixed(decimals))
}

const normalizeSecond = (value: unknown): number | null => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  return Number(numeric.toFixed(SECONDS_DECIMALS))
}

const normalizeStartSec = (value: unknown): number | null => {
  const normalized = normalizeSecond(value)
  if (normalized === null || normalized < 0) return null
  return Object.is(normalized, -0) ? 0 : normalized
}

export const normalizeSongBeatGridBarBeatOffset = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  const rounded = Math.round(numeric)
  return (
    ((rounded % SONG_BEAT_GRID_BAR_BEAT_INTERVAL) + SONG_BEAT_GRID_BAR_BEAT_INTERVAL) %
    SONG_BEAT_GRID_BAR_BEAT_INTERVAL
  )
}

export const normalizeSongBeatGridBpm = (value: unknown) =>
  normalizePositiveNumber(value, BPM_DECIMALS)

export const normalizeSongBeatGridBpmDisplayScaled = (value: unknown): number | null => {
  const normalized = normalizeSongBeatGridBpm(value)
  if (normalized === null) return null

  const [integerPartRaw, fractionPartRaw = ''] = normalized.toFixed(BPM_DECIMALS).split('.')
  const integerPart = Number(integerPartRaw)
  const fractionPart = fractionPartRaw.padEnd(BPM_DECIMALS, '0')
  const preservedDigits = Number(fractionPart.slice(0, BPM_DISPLAY_DECIMALS) || '0')
  const thirdDigit = Number(fractionPart.charAt(BPM_DISPLAY_DECIMALS) || '0')

  let scaled = integerPart * BPM_DISPLAY_SCALE + preservedDigits
  if (thirdDigit >= 6) {
    scaled += 1
  }
  return scaled
}

export const formatSongBeatGridBpmDisplay = (value: unknown, fallback = 'N/A') => {
  const scaled = normalizeSongBeatGridBpmDisplayScaled(value)
  if (scaled === null) return fallback
  return (scaled / BPM_DISPLAY_SCALE).toFixed(BPM_DISPLAY_DECIMALS)
}

const normalizeClip = (value: unknown): SongBeatGridClip | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const startSec = normalizeStartSec(record.startSec)
  const anchorSec = normalizeSecond(record.anchorSec)
  const bpm = normalizeSongBeatGridBpm(record.bpm)
  const barBeatOffset = normalizeSongBeatGridBarBeatOffset(record.barBeatOffset)
  if (startSec === null || anchorSec === null || bpm === null || barBeatOffset === null) {
    return null
  }
  return {
    startSec,
    anchorSec,
    bpm,
    barBeatOffset
  }
}

const areClipPhasesContinuous = (left: SongBeatGridClip, right: SongBeatGridClip) => {
  if (Math.abs(left.bpm - right.bpm) > 0.000001) return false
  if (left.barBeatOffset !== right.barBeatOffset) return false
  const beatSec = 60 / left.bpm
  if (!Number.isFinite(beatSec) || beatSec <= 0) return false
  const leftBeat = (right.startSec - left.anchorSec) / beatSec
  const rightBeat = (right.startSec - right.anchorSec) / beatSec
  const phaseDiff = Math.abs(leftBeat - rightBeat)
  const nearestIntegerDiff = Math.abs(phaseDiff - Math.round(phaseDiff))
  return nearestIntegerDiff <= PHASE_EPSILON_BEATS
}

const normalizeClips = (
  rawClips: unknown,
  options: NormalizeSongBeatGridMapOptions
): SongBeatGridClip[] | null => {
  if (!Array.isArray(rawClips)) return null
  const durationSec =
    typeof options.durationSec === 'number' && Number.isFinite(options.durationSec)
      ? Math.max(0, options.durationSec)
      : null
  const clips = rawClips.map(normalizeClip)
  if (clips.some((clip) => clip === null)) return null
  const sorted = (clips as SongBeatGridClip[]).sort((left, right) => left.startSec - right.startSec)
  if (!sorted.length || Math.abs(sorted[0].startSec) > 0.000001) return null
  sorted[0] = { ...sorted[0], startSec: 0 }
  for (let index = 1; index < sorted.length; index += 1) {
    const clip = sorted[index]
    if (clip.startSec <= sorted[index - 1].startSec) return null
    if (clip.startSec <= 0) return null
    if (durationSec !== null && durationSec > 0 && clip.startSec >= durationSec) return null
  }

  const clipsToReturn = options.mergeContinuousClips
    ? sorted.reduce<SongBeatGridClip[]>((merged, clip) => {
        const previous = merged[merged.length - 1]
        if (previous && areClipPhasesContinuous(previous, clip)) return merged
        merged.push(clip)
        return merged
      }, [])
    : sorted
  if (!options.allowSingleClip && clipsToReturn.length < 2) return null
  return clipsToReturn
}

const buildSignaturePayload = (clips: readonly SongBeatGridClip[]) =>
  clips
    .map((clip) =>
      [
        clip.startSec.toFixed(SECONDS_DECIMALS),
        clip.anchorSec.toFixed(SECONDS_DECIMALS),
        clip.bpm.toFixed(BPM_DECIMALS),
        String(clip.barBeatOffset)
      ].join(',')
    )
    .join('|')

export const calculateSongBeatGridMapSignature = (clips: readonly SongBeatGridClip[]) => {
  const payload = `v${SONG_BEAT_GRID_MAP_VERSION}:${buildSignaturePayload(clips)}`
  let hash = SIGNATURE_HASH_OFFSET
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index)
    hash = Math.imul(hash, SIGNATURE_HASH_PRIME)
  }
  return `sbgm_${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export const normalizeSongBeatGridMap = (
  value: unknown,
  options: NormalizeSongBeatGridMapOptions = {}
): SongBeatGridMap | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.source !== 'manual') return null
  const clips = normalizeClips(record.clips, options)
  if (!clips) return null
  return {
    version: SONG_BEAT_GRID_MAP_VERSION,
    source: 'manual',
    clips,
    signature: calculateSongBeatGridMapSignature(clips)
  }
}

export const createSongBeatGridMapFromClips = (
  clips: readonly SongBeatGridClip[],
  options: NormalizeSongBeatGridMapOptions = {}
): SongBeatGridMap | null =>
  normalizeSongBeatGridMap(
    {
      version: SONG_BEAT_GRID_MAP_VERSION,
      source: 'manual',
      clips
    },
    options
  )

export const createSongBeatGridMapFromFixedGrid = (input: {
  bpm?: unknown
  firstBeatMs?: unknown
  barBeatOffset?: unknown
}): SongBeatGridMap | null => {
  const bpm = normalizeSongBeatGridBpm(input.bpm)
  const firstBeatSec = normalizeSecond((Number(input.firstBeatMs) || 0) / 1000)
  const barBeatOffset = normalizeSongBeatGridBarBeatOffset(input.barBeatOffset)
  if (bpm === null || firstBeatSec === null || barBeatOffset === null) return null
  return createSongBeatGridMapFromClips(
    [
      {
        startSec: 0,
        anchorSec: firstBeatSec,
        bpm,
        barBeatOffset
      }
    ],
    { allowSingleClip: true }
  )
}

export const projectSongBeatGridMapToFixedGrid = (
  value: unknown
): SongBeatGridFixedProjection | null => {
  const map = normalizeSongBeatGridMap(value, { allowSingleClip: true })
  const firstClip = map?.clips[0]
  if (!map || !firstClip) return null
  const beatSec = 60 / firstClip.bpm
  if (!Number.isFinite(beatSec) || beatSec <= 0) return null
  const firstBeatSec =
    firstClip.anchorSec + Math.ceil((0 - firstClip.anchorSec) / beatSec) * beatSec
  return {
    bpm: firstClip.bpm,
    firstBeatMs: Number((Math.max(0, firstBeatSec) * 1000).toFixed(3)),
    barBeatOffset: firstClip.barBeatOffset
  }
}

const roundSongBeatGridSec = (value: number) => Number(value.toFixed(SECONDS_DECIMALS))

const normalizeRuntimeDurationSec = (value: unknown): number | null => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return Number(numeric.toFixed(SECONDS_DECIMALS))
}

const resolveBeatLineLevel = (
  clipBeatIndex: number,
  barBeatOffset: number
): SongBeatGridLineLevel => {
  const shiftedIndex = clipBeatIndex - barBeatOffset
  const mod32 =
    ((shiftedIndex % SONG_BEAT_GRID_BAR_BEAT_INTERVAL) + SONG_BEAT_GRID_BAR_BEAT_INTERVAL) %
    SONG_BEAT_GRID_BAR_BEAT_INTERVAL
  if (mod32 === 0) return 'bar'
  const mod4 = ((shiftedIndex % 4) + 4) % 4
  return mod4 === 0 ? 'beat4' : 'beat'
}

const createRuntimeClip = (
  clip: SongBeatGridClip,
  index: number,
  endSec: number,
  firstBeatOrdinal: number
): SongBeatGridRuntimeClip | null => {
  const beatSec = 60 / clip.bpm
  if (!Number.isFinite(beatSec) || beatSec <= 0 || endSec <= clip.startSec) return null
  const firstBeatIndex = Math.ceil((clip.startSec - clip.anchorSec - LINE_EPSILON_SEC) / beatSec)
  const lastBeatIndex = Math.floor((endSec - clip.anchorSec - LINE_EPSILON_SEC) / beatSec)
  const lineCount = Math.max(0, lastBeatIndex - firstBeatIndex + 1)
  return {
    ...clip,
    index,
    endSec,
    beatSec,
    firstBeatIndex,
    lastBeatIndex,
    firstBeatOrdinal,
    lineCount
  }
}

export const createSongBeatGridRuntime = (
  value: unknown,
  durationSecInput: unknown
): SongBeatGridRuntime | null => {
  const durationSec = normalizeRuntimeDurationSec(durationSecInput)
  if (durationSec === null) return null
  const map = normalizeSongBeatGridMap(value, { durationSec, allowSingleClip: true })
  if (!map) return null

  const clips: SongBeatGridRuntimeClip[] = []
  const lines: SongBeatGridLine[] = []
  let nextBeatOrdinal = 0

  for (let index = 0; index < map.clips.length; index += 1) {
    const clip = map.clips[index]
    const nextClip = map.clips[index + 1]
    const endSec = nextClip ? nextClip.startSec : durationSec
    const runtimeClip = createRuntimeClip(clip, index, endSec, nextBeatOrdinal)
    if (!runtimeClip) continue
    clips.push(runtimeClip)
    for (
      let clipBeatIndex = runtimeClip.firstBeatIndex;
      clipBeatIndex <= runtimeClip.lastBeatIndex;
      clipBeatIndex += 1
    ) {
      const sec = roundSongBeatGridSec(clip.anchorSec + clipBeatIndex * runtimeClip.beatSec)
      if (sec < runtimeClip.startSec - LINE_EPSILON_SEC) continue
      if (sec >= runtimeClip.endSec - LINE_EPSILON_SEC && runtimeClip.endSec < durationSec) {
        continue
      }
      if (sec > durationSec + LINE_EPSILON_SEC) continue
      lines.push({
        sec: Math.max(0, Math.min(durationSec, sec)),
        clipIndex: index,
        beatOrdinal: nextBeatOrdinal,
        clipBeatIndex,
        bpm: clip.bpm,
        level: resolveBeatLineLevel(clipBeatIndex, clip.barBeatOffset)
      })
      nextBeatOrdinal += 1
    }
    runtimeClip.lineCount = nextBeatOrdinal - runtimeClip.firstBeatOrdinal
  }

  if (!clips.length || !lines.length) return null
  return {
    map,
    signature: map.signature,
    durationSec,
    clips,
    lines,
    clipBoundaries: map.clips.slice(1).map((clip) => clip.startSec)
  }
}

export const resolveSongBeatGridClipAtSec = (
  value: unknown,
  durationSec: unknown,
  secInput: unknown
): SongBeatGridRuntimeClip | null => {
  const runtime = createSongBeatGridRuntime(value, durationSec)
  if (!runtime) return null
  const sec = Math.max(0, Math.min(runtime.durationSec, Number(secInput) || 0))
  let left = 0
  let right = runtime.clips.length - 1
  let answer = runtime.clips[0] || null
  while (left <= right) {
    const middle = (left + right) >> 1
    const clip = runtime.clips[middle]
    if (!clip) break
    if (clip.startSec <= sec + LINE_EPSILON_SEC) {
      answer = clip
      left = middle + 1
    } else {
      right = middle - 1
    }
  }
  if (!answer) return null
  return sec <= answer.endSec + LINE_EPSILON_SEC ? answer : null
}

export const resolveSongBeatGridBpmAtSec = (
  value: unknown,
  durationSec: unknown,
  secInput: unknown
): number | null => resolveSongBeatGridClipAtSec(value, durationSec, secInput)?.bpm ?? null

export const resolveNearestSongBeatGridLine = (
  value: unknown,
  durationSec: unknown,
  secInput: unknown,
  options: {
    minSec?: number
    maxSec?: number
    levels?: SongBeatGridLineLevel[]
  } = {}
): SongBeatGridLine | null => {
  const runtime = createSongBeatGridRuntime(value, durationSec)
  if (!runtime) return null
  const sec = Math.max(0, Math.min(runtime.durationSec, Number(secInput) || 0))
  const minSec = Number.isFinite(Number(options.minSec)) ? Number(options.minSec) : 0
  const maxSec = Number.isFinite(Number(options.maxSec))
    ? Number(options.maxSec)
    : runtime.durationSec
  const levelSet = Array.isArray(options.levels) ? new Set(options.levels) : null
  let nearest: SongBeatGridLine | null = null
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const line of runtime.lines) {
    if (line.sec < minSec - LINE_EPSILON_SEC || line.sec > maxSec + LINE_EPSILON_SEC) continue
    if (levelSet && !levelSet.has(line.level)) continue
    const distance = Math.abs(line.sec - sec)
    if (distance >= nearestDistance) continue
    nearest = line
    nearestDistance = distance
  }
  return nearest
}

export const resolveSongBeatGridLineByOrdinal = (
  value: unknown,
  durationSec: unknown,
  beatOrdinalInput: unknown
): SongBeatGridLine | null => {
  const runtime = createSongBeatGridRuntime(value, durationSec)
  if (!runtime) return null
  const beatOrdinal = Math.round(Number(beatOrdinalInput))
  if (!Number.isFinite(beatOrdinal)) return null
  return runtime.lines.find((line) => line.beatOrdinal === beatOrdinal) || null
}

export const resolveSongBeatGridBeatOrdinalAtSec = (
  value: unknown,
  durationSec: unknown,
  secInput: unknown
): number | null => {
  const runtime = createSongBeatGridRuntime(value, durationSec)
  if (!runtime) return null
  const sec = Math.max(0, Math.min(runtime.durationSec, Number(secInput) || 0))
  const lines = runtime.lines
  if (!lines.length) return null
  for (let index = 0; index < lines.length - 1; index += 1) {
    const left = lines[index]
    const right = lines[index + 1]
    if (sec < left.sec || sec > right.sec) continue
    const spanSec = right.sec - left.sec
    if (!Number.isFinite(spanSec) || spanSec <= 0) return left.beatOrdinal
    return left.beatOrdinal + (sec - left.sec) / spanSec
  }
  const nearestClip = resolveSongBeatGridClipAtSec(runtime.map, runtime.durationSec, sec)
  if (!nearestClip) return lines[0].beatOrdinal
  const referenceLine = sec < lines[0].sec ? lines[0] : lines[lines.length - 1]
  return referenceLine.beatOrdinal + (sec - referenceLine.sec) / nearestClip.beatSec
}

export const resolveSongBeatGridSecAtBeatOrdinal = (
  value: unknown,
  durationSec: unknown,
  beatOrdinalInput: unknown
): number | null => {
  const runtime = createSongBeatGridRuntime(value, durationSec)
  if (!runtime) return null
  const beatOrdinal = Number(beatOrdinalInput)
  if (!Number.isFinite(beatOrdinal)) return null
  const lines = runtime.lines
  if (!lines.length) return null
  if (beatOrdinal <= lines[0].beatOrdinal) return 0
  const lastLine = lines[lines.length - 1]
  if (beatOrdinal >= lastLine.beatOrdinal) return runtime.durationSec
  const leftOrdinal = Math.floor(beatOrdinal)
  const rightOrdinal = Math.ceil(beatOrdinal)
  const leftLine = lines.find((line) => line.beatOrdinal === leftOrdinal) || null
  const rightLine = lines.find((line) => line.beatOrdinal === rightOrdinal) || null
  if (!leftLine || !rightLine) return null
  if (leftOrdinal === rightOrdinal) return leftLine.sec
  const ratio = beatOrdinal - leftOrdinal
  return roundSongBeatGridSec(leftLine.sec + (rightLine.sec - leftLine.sec) * ratio)
}

export const resolveSongBeatGridBeatJumpSec = (
  value: unknown,
  durationSec: unknown,
  secInput: unknown,
  beatDeltaInput: unknown
): number | null => {
  const beatOrdinal = resolveSongBeatGridBeatOrdinalAtSec(value, durationSec, secInput)
  const beatDelta = Number(beatDeltaInput)
  if (beatOrdinal === null || !Number.isFinite(beatDelta)) return null
  return resolveSongBeatGridSecAtBeatOrdinal(value, durationSec, beatOrdinal + beatDelta)
}

const collectDistinctBpmValues = (map: SongBeatGridMap) => {
  const result: number[] = []
  let previousScaled: number | null = null
  for (const clip of map.clips) {
    const scaled = normalizeSongBeatGridBpmDisplayScaled(clip.bpm)
    if (scaled === null || scaled === previousScaled) continue
    previousScaled = scaled
    result.push(clip.bpm)
  }
  return result
}

const formatBpmSequence = (values: readonly number[]) =>
  values.map((value) => formatSongBeatGridBpmDisplay(value, ''))

export const summarizeSongBeatGridBpm = (
  beatGridMap: unknown,
  fixedBpm?: unknown
): SongBeatGridBpmSummary => {
  const map = normalizeSongBeatGridMap(beatGridMap)
  if (map) {
    const values = collectDistinctBpmValues(map)
    const displayValues =
      values.length > 3
        ? [
            ...formatBpmSequence(values.slice(0, 2)),
            '...',
            formatSongBeatGridBpmDisplay(values[values.length - 1], '')
          ]
        : formatBpmSequence(values)
    const titleValues = formatBpmSequence(values)
    const minimumBpm = values.length > 0 ? Math.min(...values) : null
    return {
      displayText: displayValues.join(' -> '),
      titleText: titleValues.join(' -> '),
      values,
      minimumBpm,
      isDynamic: map.clips.length > 1
    }
  }

  const bpm = normalizeSongBeatGridBpm(fixedBpm)
  return {
    displayText: bpm === null ? '' : formatSongBeatGridBpmDisplay(bpm, ''),
    titleText: bpm === null ? '' : formatSongBeatGridBpmDisplay(bpm, ''),
    values: bpm === null ? [] : [bpm],
    minimumBpm: bpm,
    isDynamic: false
  }
}

export const resolveSongBeatGridBpmFilterValues = (beatGridMap: unknown, fixedBpm?: unknown) =>
  summarizeSongBeatGridBpm(beatGridMap, fixedBpm).values

export const resolveSongBeatGridBpmSortValue = (beatGridMap: unknown, fixedBpm?: unknown) =>
  summarizeSongBeatGridBpm(beatGridMap, fixedBpm).minimumBpm
