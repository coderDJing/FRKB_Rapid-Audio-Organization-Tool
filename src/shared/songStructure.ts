import { buildSongStructureAnalysisCore } from './songStructureAnalysis'
import {
  CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION,
  PHRASE_BARS,
  clamp01,
  isSameGridValue,
  normalizeStructureGrid,
  toFixedNumber,
  type BuildSongStructureInput,
  type SongStructureAnalysis,
  type SongStructureSection,
  type SongStructureSectionKind
} from './songStructureCommon'

export {
  CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION,
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
  const algorithmVersion = Math.floor(Number(record.algorithmVersion) || 0)
  const durationSec = Number(record.durationSec)
  const grid = normalizeStructureGrid(record)
  const sections = Array.isArray(record.sections)
    ? record.sections
        .map((section) => normalizeSongStructureSection(section))
        .filter((section): section is SongStructureSection => section !== null)
    : []
  if (
    algorithmVersion !== CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION ||
    !grid ||
    !Number.isFinite(durationSec) ||
    durationSec <= 0 ||
    sections.length <= 0
  ) {
    return undefined
  }
  return {
    algorithmVersion,
    durationSec: toFixedNumber(durationSec, 3),
    bpm: grid.bpm,
    firstBeatMs: grid.firstBeatMs,
    barBeatOffset: grid.barBeatOffset,
    phraseBars: PHRASE_BARS,
    sections
  }
}

export const hasCurrentSongStructureAnalysis = (
  info:
    | {
        songStructure?: unknown
        bpm?: unknown
        firstBeatMs?: unknown
        barBeatOffset?: unknown
      }
    | null
    | undefined
) => {
  const structure = normalizeSongStructureAnalysis(info?.songStructure)
  const grid = normalizeStructureGrid(info)
  if (!structure || !grid) return false
  return (
    isSameGridValue(grid.bpm, structure.bpm, 0.0001) &&
    isSameGridValue(grid.firstBeatMs, structure.firstBeatMs, 0.001) &&
    isSameGridValue(grid.barBeatOffset, structure.barBeatOffset, 0)
  )
}
