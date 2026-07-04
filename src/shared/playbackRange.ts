import {
  normalizeSongStructureAnalysis,
  type SongStructureSection,
  type SongStructureSectionKind
} from './songStructure'

export const PLAYBACK_RANGE_SECTION_KINDS = [
  'intro',
  'groove',
  'breakdown',
  'build',
  'drop',
  'outro'
] as const satisfies readonly SongStructureSectionKind[]

export const PLAYBACK_RANGE_SECTION_LABELS: Record<SongStructureSectionKind, string> = {
  intro: 'INTRO',
  groove: 'GROOVE',
  breakdown: 'BREAK',
  build: 'BUILD',
  drop: 'DROP',
  outro: 'OUTRO'
}

export const DEFAULT_PLAYBACK_RANGE_SECTION_KINDS = [
  'drop'
] as const satisfies readonly SongStructureSectionKind[]

export type PlaybackRangeMode = 'custom' | 'section'
export type PlaybackRangeSectionMatchMode = 'all' | 'first' | 'last'

export type PlaybackRangeSettingsLike = {
  enablePlaybackRange?: unknown
  playbackRangeMode?: unknown
  playbackRangeSectionKinds?: unknown
  playbackRangeSectionMatchMode?: unknown
  startPlayPercent?: unknown
  endPlayPercent?: unknown
}

export type PlaybackSectionRange = {
  startSec: number
  endSec: number
  kinds: SongStructureSectionKind[]
}

export type PlaybackSectionRangeStatus = 'disabled' | 'custom' | 'unanalysed' | 'no-match' | 'ready'

export type PlaybackSectionRangeResolution = {
  mode: PlaybackRangeMode
  status: PlaybackSectionRangeStatus
  ranges: PlaybackSectionRange[]
}

const SECTION_RANGE_MERGE_GAP_SEC = 0.15

const isSectionKind = (value: unknown): value is SongStructureSectionKind =>
  PLAYBACK_RANGE_SECTION_KINDS.some((kind) => kind === value)

const uniqueKindsInDisplayOrder = (input: Iterable<unknown>) => {
  const selected = new Set<SongStructureSectionKind>()
  for (const item of input) {
    if (isSectionKind(item)) selected.add(item)
  }
  return PLAYBACK_RANGE_SECTION_KINDS.filter((kind) => selected.has(kind))
}

export const normalizePlaybackRangeMode = (value: unknown): PlaybackRangeMode =>
  value === 'section' ? 'section' : 'custom'

export const normalizePlaybackRangeSectionMatchMode = (
  value: unknown
): PlaybackRangeSectionMatchMode => {
  if (value === 'first' || value === 'last') return value
  return 'all'
}

export const normalizePlaybackRangeSectionKinds = (
  value: unknown,
  fallback: readonly SongStructureSectionKind[] = DEFAULT_PLAYBACK_RANGE_SECTION_KINDS
): SongStructureSectionKind[] => {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const normalized = uniqueKindsInDisplayOrder(source)
  return normalized.length ? normalized : [...fallback]
}

export const clampPlaybackRangePercent = (value: unknown, fallback: number) => {
  const raw = typeof value === 'number' ? value : Number(value)
  const safe = Number.isFinite(raw) ? raw : fallback
  return Math.min(Math.max(safe, 0), 100)
}

export const isPlaybackSectionRangeMode = (setting: PlaybackRangeSettingsLike) =>
  setting.enablePlaybackRange === true &&
  normalizePlaybackRangeMode(setting.playbackRangeMode) === 'section'

const resolvePositiveSeconds = (value: unknown) => {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0
}

const clampSectionRange = (
  section: SongStructureSection,
  durationSec: number
): PlaybackSectionRange | null => {
  const startSec = Math.max(0, Math.min(section.startSec, durationSec))
  const endSec = Math.max(0, Math.min(section.endSec, durationSec))
  if (endSec <= startSec) return null
  return {
    startSec,
    endSec,
    kinds: [section.kind]
  }
}

const mergePlaybackSectionRanges = (ranges: PlaybackSectionRange[]) => {
  const sorted = [...ranges].sort((left, right) => left.startSec - right.startSec)
  const merged: PlaybackSectionRange[] = []
  for (const range of sorted) {
    const previous = merged[merged.length - 1]
    if (previous && range.startSec <= previous.endSec + SECTION_RANGE_MERGE_GAP_SEC) {
      previous.endSec = Math.max(previous.endSec, range.endSec)
      previous.kinds = uniqueKindsInDisplayOrder([...previous.kinds, ...range.kinds])
      continue
    }
    merged.push({ ...range, kinds: [...range.kinds] })
  }
  return merged
}

const pickMatchingSections = (
  sections: SongStructureSection[],
  selectedKinds: SongStructureSectionKind[],
  matchMode: PlaybackRangeSectionMatchMode
) => {
  const selected = new Set(selectedKinds)
  const matching = sections.filter((section) => selected.has(section.kind))
  if (matchMode === 'all') return matching

  const picked: SongStructureSection[] = []
  for (const kind of selectedKinds) {
    const sectionsForKind = matching.filter((section) => section.kind === kind)
    const section =
      matchMode === 'first' ? sectionsForKind[0] : sectionsForKind[sectionsForKind.length - 1]
    if (section) picked.push(section)
  }
  return picked.sort((left, right) => left.startSec - right.startSec)
}

export const resolvePlaybackSectionRangeResolution = (
  setting: PlaybackRangeSettingsLike,
  songStructure: unknown,
  durationSec?: unknown
): PlaybackSectionRangeResolution => {
  const mode = normalizePlaybackRangeMode(setting.playbackRangeMode)
  if (setting.enablePlaybackRange !== true) {
    return { mode, status: 'disabled', ranges: [] }
  }
  if (mode !== 'section') {
    return { mode, status: 'custom', ranges: [] }
  }

  const structure = normalizeSongStructureAnalysis(songStructure)
  if (!structure) {
    return { mode, status: 'unanalysed', ranges: [] }
  }

  const selectedKinds = normalizePlaybackRangeSectionKinds(setting.playbackRangeSectionKinds)
  const matchMode = normalizePlaybackRangeSectionMatchMode(setting.playbackRangeSectionMatchMode)
  const timelineDuration = resolvePositiveSeconds(durationSec) || structure.durationSec
  const ranges = pickMatchingSections(structure.sections, selectedKinds, matchMode)
    .map((section) => clampSectionRange(section, timelineDuration))
    .filter((range): range is PlaybackSectionRange => range !== null)

  const mergedRanges = mergePlaybackSectionRanges(ranges)
  return {
    mode,
    status: mergedRanges.length ? 'ready' : 'no-match',
    ranges: mergedRanges
  }
}

export const resolveInitialPlaybackRangeStartSec = (
  setting: PlaybackRangeSettingsLike,
  songStructure: unknown,
  durationSec: number
) => {
  if (setting.enablePlaybackRange !== true || durationSec <= 0) return 0
  const mode = normalizePlaybackRangeMode(setting.playbackRangeMode)
  if (mode === 'section') {
    const resolution = resolvePlaybackSectionRangeResolution(setting, songStructure, durationSec)
    return resolution.status === 'ready' ? (resolution.ranges[0]?.startSec ?? 0) : 0
  }
  return (durationSec * clampPlaybackRangePercent(setting.startPlayPercent, 0)) / 100
}

export const resolveCustomPlaybackRangeEndSec = (
  setting: PlaybackRangeSettingsLike,
  durationSec: number
) =>
  durationSec > 0 ? (durationSec * clampPlaybackRangePercent(setting.endPlayPercent, 100)) / 100 : 0

export const findCurrentOrUpcomingPlaybackSectionRange = (
  ranges: readonly PlaybackSectionRange[],
  currentSec: number,
  toleranceSec = 0.05
) => {
  const safeCurrent = Math.max(0, Number(currentSec) || 0)
  const current = ranges.find(
    (range) =>
      safeCurrent >= range.startSec - toleranceSec && safeCurrent <= range.endSec + toleranceSec
  )
  if (current) return current
  return ranges.find((range) => range.startSec > safeCurrent + toleranceSec) ?? null
}

export const findCrossedPlaybackSectionRange = (
  ranges: readonly PlaybackSectionRange[],
  previousSec: number,
  currentSec: number,
  toleranceSec = 0.05
) => {
  if (currentSec < previousSec) return null
  return (
    ranges.find((range) => {
      const effectiveEnd = Math.max(range.endSec - toleranceSec, 0)
      return currentSec >= effectiveEnd && previousSec < effectiveEnd
    }) ?? null
  )
}

export const findNextPlaybackSectionRange = (
  ranges: readonly PlaybackSectionRange[],
  afterSec: number,
  toleranceSec = 0.05
) => ranges.find((range) => range.startSec > afterSec + toleranceSec) ?? null
