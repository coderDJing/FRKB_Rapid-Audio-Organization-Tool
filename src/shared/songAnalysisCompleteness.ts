import {
  normalizeSongBeatGridMap,
  projectSongBeatGridMapToFixedGrid,
  type SongBeatGridMap
} from './songBeatGridMap'
import { hasUsableSongEnergyAnalysis } from './songEnergy'
import { hasUsableSongStructureAnalysis } from './songStructure'

export type SongAnalysisCompletenessInfo = {
  key?: unknown
  bpm?: unknown
  firstBeatMs?: unknown
  barBeatOffset?: unknown
  beatGridStatus?: unknown
  beatGridMap?: unknown
  energyScore?: unknown
  songStructure?: unknown
}

export type UsableSongBeatGrid =
  | {
      kind: 'dynamic'
      beatGridMap: SongBeatGridMap
      bpm: number
      firstBeatMs: number
      barBeatOffset: number
    }
  | { kind: 'fixed'; bpm: number; firstBeatMs: number; barBeatOffset: number }
  | { kind: 'no-bpm' }
  | { kind: 'missing' }

const normalizeBpm = (value: unknown) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null
}

const normalizeFirstBeatMs = (value: unknown) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

const normalizeBarBeatOffset = (value: unknown) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

export const hasUsableKeyAnalysis = (
  info: Pick<SongAnalysisCompletenessInfo, 'key'> | null | undefined
) => typeof info?.key === 'string' && info.key.trim().length > 0

export const resolveUsableSongBeatGrid = (
  info: SongAnalysisCompletenessInfo | null | undefined
): UsableSongBeatGrid => {
  const beatGridMap = normalizeSongBeatGridMap(info?.beatGridMap)
  const projection = projectSongBeatGridMapToFixedGrid(beatGridMap)
  if (beatGridMap && projection) return { kind: 'dynamic', beatGridMap, ...projection }

  const bpm = normalizeBpm(info?.bpm)
  const firstBeatMs = normalizeFirstBeatMs(info?.firstBeatMs)
  const barBeatOffset = normalizeBarBeatOffset(info?.barBeatOffset)
  if (bpm !== null && firstBeatMs !== null && barBeatOffset !== null) {
    return { kind: 'fixed', bpm, firstBeatMs, barBeatOffset }
  }

  if (info?.beatGridStatus === 'no-bpm') return { kind: 'no-bpm' }
  return { kind: 'missing' }
}

export const hasUsableSongBeatGridAnalysis = (
  info: SongAnalysisCompletenessInfo | null | undefined
) => resolveUsableSongBeatGrid(info).kind !== 'missing'

export const hasUsableNoBpmBeatGridResult = (
  info: SongAnalysisCompletenessInfo | null | undefined
) => resolveUsableSongBeatGrid(info).kind === 'no-bpm'

export const hasRequiredSongStructureAnalysis = (
  info: SongAnalysisCompletenessInfo | null | undefined
) => {
  const grid = resolveUsableSongBeatGrid(info)
  return grid.kind === 'no-bpm' || (grid.kind !== 'missing' && hasUsableSongStructureAnalysis(info))
}

export const hasUsableCoreSongAnalysis = (
  info: SongAnalysisCompletenessInfo | null | undefined,
  options: { includeStructure?: boolean; waveformAvailable?: boolean } = {}
) => {
  if (!hasUsableKeyAnalysis(info) || !hasUsableSongEnergyAnalysis(info)) return false
  if (options.waveformAvailable === false) return false
  const grid = resolveUsableSongBeatGrid(info)
  if (grid.kind === 'missing') return false
  if (options.includeStructure !== true || grid.kind === 'no-bpm') return true
  return hasUsableSongStructureAnalysis(info)
}
