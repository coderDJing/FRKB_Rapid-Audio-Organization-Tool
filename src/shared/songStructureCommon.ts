import type { UnifiedDisplayWaveformDetailData } from './unifiedDisplayWaveform'
import type { SongBeatGridMap } from './songBeatGridMap'
import type { SongStructureFeatureData } from './songStructureFeatureData'

export const CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION = 22
// 仅持久化结构格式不兼容时升级；普通算法调参只升级 algorithmVersion。
export const CURRENT_SONG_STRUCTURE_FORMAT_VERSION = 1

export type SongStructureSectionKind = 'intro' | 'groove' | 'breakdown' | 'build' | 'drop' | 'outro'

export type SongStructureAnalysisSource = 'algorithmic'

export type SongStructureSection = {
  startSec: number
  endSec: number
  startBar: number
  endBar: number
  phraseIndex: number
  kind: SongStructureSectionKind
  confidence: number
  energy: number
  low: number
  high: number
  novelty: number
}

export type SongStructureAnalysis = {
  formatVersion: number
  algorithmVersion: number
  source?: SongStructureAnalysisSource
  durationSec: number
  bpm: number
  firstBeatMs: number
  barBeatOffset: number
  beatGridSignature?: string
  phraseBars: number
  sections: SongStructureSection[]
}

export type BuildSongStructureInput = {
  waveformData: UnifiedDisplayWaveformDetailData | null | undefined
  structureFeatureData?: SongStructureFeatureData | null
  bpm: unknown
  firstBeatMs: unknown
  barBeatOffset: unknown
  beatGridMap?: SongBeatGridMap | null
}

export type SongStructureGrid = {
  bpm?: unknown
  firstBeatMs?: unknown
  barBeatOffset?: unknown
  beatGridMap?: unknown
}

export const BYTE_MAX = 255
export const BEATS_PER_BAR = 4
export const PHRASE_BARS = 8
export const PHRASE_BEATS = BEATS_PER_BAR * PHRASE_BARS
export const MAX_SECTIONS = 64

export const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value))

export const clamp01 = (value: number) => (Number.isFinite(value) ? clamp(value, 0, 1) : 0)

export const ramp = (value: number, min: number, max: number) => {
  if (max <= min) return value >= max ? 1 : 0
  return clamp01((value - min) / (max - min))
}

export const toFixedNumber = (value: number, digits: number) => Number(value.toFixed(digits))

export const resolveSongStructureTimelineFirstBeatMs = (
  analyzedFirstBeatMs: unknown,
  cachedFirstBeatMs: unknown,
  timeBasisOffsetMs: unknown
): number | undefined => {
  const analyzed = Number(analyzedFirstBeatMs)
  if (Number.isFinite(analyzed)) {
    const offset = Number(timeBasisOffsetMs)
    return toFixedNumber(analyzed + (Number.isFinite(offset) ? Math.max(0, offset) : 0), 3)
  }
  const cached = Number(cachedFirstBeatMs)
  return Number.isFinite(cached) ? toFixedNumber(cached, 3) : undefined
}

export const resolveBassPresence = (value: { energy: number; low: number }) =>
  clamp01(Math.sqrt(clamp01(value.energy) * clamp01(value.low)))

const normalizeBpm = (value: unknown): number | undefined => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined
  return toFixedNumber(numeric, 6)
}

const normalizeFirstBeatMs = (value: unknown): number | undefined => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return undefined
  return toFixedNumber(numeric, 3)
}

export const normalizeBeatOffset = (
  value: unknown,
  interval = PHRASE_BEATS
): number | undefined => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return undefined
  const rounded = Math.round(numeric)
  return ((rounded % interval) + interval) % interval
}

export const normalizeStructureGrid = (value: SongStructureGrid | null | undefined) => {
  const bpm = normalizeBpm(value?.bpm)
  const firstBeatMs = normalizeFirstBeatMs(value?.firstBeatMs)
  const barBeatOffset = normalizeBeatOffset(value?.barBeatOffset)
  if (bpm === undefined || firstBeatMs === undefined || barBeatOffset === undefined) return null
  return { bpm, firstBeatMs, barBeatOffset }
}

export const normalizeGridBeatOffset = (barBeatOffset: number) =>
  ((barBeatOffset % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR

export const isSameGridValue = (left: number | undefined, right: number, epsilon: number) =>
  left !== undefined && Math.abs(left - right) <= epsilon

export const readByteRatio = (values: Uint8Array | undefined, index: number) => {
  if (!values?.length) return 0
  const safeIndex = clamp(Math.floor(index), 0, values.length - 1)
  return clamp(values[safeIndex] ?? 0, 0, BYTE_MAX) / BYTE_MAX
}

export const percentile = (values: readonly number[], ratio: number) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = clamp(Math.round((sorted.length - 1) * clamp01(ratio)), 0, sorted.length - 1)
  return sorted[index] ?? 0
}
