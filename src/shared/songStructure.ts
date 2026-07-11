import { buildSongStructureAnalysisCore } from './songStructureAnalysis'
import {
  CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION,
  CURRENT_SONG_STRUCTURE_FORMAT_VERSION,
  PHRASE_BARS,
  clamp01,
  isSameGridValue,
  normalizeStructureGrid,
  toFixedNumber,
  type BuildSongStructureInput,
  type SongStructureAnalysis,
  type SongStructureAnalysisSource,
  type SongStructureSection,
  type SongStructureSectionKind
} from './songStructureCommon'
import { normalizeSongBeatGridMap } from './songBeatGridMap'

const LEGACY_SONG_STRUCTURE_FORMAT_VERSION = 1

export {
  CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION,
  CURRENT_SONG_STRUCTURE_FORMAT_VERSION,
  type SongStructureAnalysis,
  type SongStructureSection,
  type SongStructureSectionKind
} from './songStructureCommon'

export const buildSongStructureAnalysis = (
  input: BuildSongStructureInput
): SongStructureAnalysis | null => buildSongStructureAnalysisCore(input)

const normalizeSectionKind = (value: unknown): SongStructureSectionKind | null => {
  if (
    value === 'intro' ||
    value === 'groove' ||
    value === 'breakdown' ||
    value === 'build' ||
    value === 'drop' ||
    value === 'outro'
  ) {
    return value
  }
  return null
}

const normalizeStructureSource = (value: unknown): SongStructureAnalysisSource | undefined => {
  if (value === 'algorithmic') return 'algorithmic'
  return undefined
}

const normalizeSongStructureSection = (value: unknown): SongStructureSection | null => {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : null
  if (!input) return null
  const record = input as Partial<Record<keyof SongStructureSection, unknown>>
  const kind = normalizeSectionKind(record.kind)
  const startSec = Number(record.startSec)
  const endSec = Number(record.endSec)
  if (!kind || !Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    return null
  }
  return {
    startSec: toFixedNumber(Math.max(0, startSec), 3),
    endSec: toFixedNumber(Math.max(0, endSec), 3),
    startBar: Math.max(1, Math.floor(Number(record.startBar) || 1)),
    endBar: Math.max(1, Math.floor(Number(record.endBar) || 1)),
    phraseIndex: Math.max(0, Math.floor(Number(record.phraseIndex) || 0)),
    kind,
    confidence: toFixedNumber(clamp01(Number(record.confidence) || 0), 3),
    energy: toFixedNumber(clamp01(Number(record.energy) || 0), 3),
    low: toFixedNumber(clamp01(Number(record.low) || 0), 3),
    high: toFixedNumber(clamp01(Number(record.high) || 0), 3),
    novelty: toFixedNumber(clamp01(Number(record.novelty) || 0), 3)
  }
}

export const normalizeSongStructureAnalysis = (
  value: unknown
): SongStructureAnalysis | undefined => {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : null
  if (!input) return undefined
  const record = input as Partial<Record<keyof SongStructureAnalysis, unknown>>
  const formatVersion =
    record.formatVersion === undefined
      ? LEGACY_SONG_STRUCTURE_FORMAT_VERSION
      : Math.floor(Number(record.formatVersion) || 0)
  const algorithmVersion = Math.floor(Number(record.algorithmVersion) || 0)
  const durationSec = Number(record.durationSec)
  const grid = normalizeStructureGrid(record)
  const sections = Array.isArray(record.sections)
    ? record.sections
        .map((section) => normalizeSongStructureSection(section))
        .filter((section): section is SongStructureSection => section !== null)
    : []
  if (
    formatVersion !== CURRENT_SONG_STRUCTURE_FORMAT_VERSION ||
    algorithmVersion <= 0 ||
    !grid ||
    !Number.isFinite(durationSec) ||
    durationSec <= 0 ||
    sections.length <= 0
  ) {
    return undefined
  }
  return {
    formatVersion,
    algorithmVersion,
    source: normalizeStructureSource(record.source),
    durationSec: toFixedNumber(durationSec, 3),
    bpm: grid.bpm,
    firstBeatMs: grid.firstBeatMs,
    barBeatOffset: grid.barBeatOffset,
    beatGridSignature:
      typeof record.beatGridSignature === 'string' && record.beatGridSignature.trim()
        ? record.beatGridSignature.trim()
        : undefined,
    phraseBars: PHRASE_BARS,
    sections
  }
}

type SongStructureAnalysisInfo =
  | {
      songStructure?: unknown
      bpm?: unknown
      firstBeatMs?: unknown
      barBeatOffset?: unknown
      beatGridMap?: unknown
    }
  | null
  | undefined

const hasMatchingSongStructureGrid = (
  info: SongStructureAnalysisInfo,
  structure: SongStructureAnalysis
) => {
  const beatGridMap = normalizeSongBeatGridMap(info?.beatGridMap)
  if (beatGridMap) {
    return structure.beatGridSignature === beatGridMap.signature
  }
  if (structure.beatGridSignature) return false
  const grid = normalizeStructureGrid(info)
  if (!grid) return false
  return (
    isSameGridValue(grid.bpm, structure.bpm, 0.0001) &&
    isSameGridValue(grid.firstBeatMs, structure.firstBeatMs, 0.001) &&
    isSameGridValue(grid.barBeatOffset, structure.barBeatOffset, 0)
  )
}

export const hasUsableSongStructureAnalysis = (info: SongStructureAnalysisInfo) => {
  const structure = normalizeSongStructureAnalysis(info?.songStructure)
  return !!structure && hasMatchingSongStructureGrid(info, structure)
}

export const hasCurrentSongStructureAnalysis = (info: SongStructureAnalysisInfo) => {
  const structure = normalizeSongStructureAnalysis(info?.songStructure)
  return (
    !!structure &&
    structure.algorithmVersion === CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION &&
    hasMatchingSongStructureGrid(info, structure)
  )
}
