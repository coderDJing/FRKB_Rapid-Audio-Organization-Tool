import { hasUsableSongEnergyAnalysis } from '../../../shared/songEnergy'
import {
  hasRequiredSongStructureAnalysis,
  hasUsableKeyAnalysis,
  resolveUsableSongBeatGrid
} from '../../../shared/songAnalysisCompleteness'

export type AnalysisCandidate = {
  filePath?: string
  key?: unknown
  keyAnalysisAlgorithmVersion?: unknown
  bpm?: unknown
  firstBeatMs?: unknown
  barBeatOffset?: unknown
  beatGridMap?: unknown
  beatGridStatus?: unknown
  beatGridAlgorithmVersion?: unknown
  energyScore?: unknown
  energyAlgorithmVersion?: unknown
  songStructure?: unknown
  fileMissing?: boolean
}

export type MissingAnalysisOptions = {
  includeSongStructure?: boolean
  missingWaveformFilePaths?: readonly string[]
  missingWaveformFilePathKeys?: ReadonlySet<string>
}

const normalizeFilePathKey = (filePath: string) => filePath.replace(/\//g, '\\').toLowerCase()

const resolveMissingWaveformFilePathKeys = (options: MissingAnalysisOptions) => {
  if (options.missingWaveformFilePathKeys) return options.missingWaveformFilePathKeys
  if (!options.missingWaveformFilePaths) return undefined
  return new Set(
    options.missingWaveformFilePaths
      .map((filePath) => normalizeFilePathKey(String(filePath || '').trim()))
      .filter(Boolean)
  )
}

const isWaveformMissing = (song: AnalysisCandidate, options: MissingAnalysisOptions) => {
  const filePath = typeof song.filePath === 'string' ? song.filePath.trim() : ''
  if (!filePath) return false
  return resolveMissingWaveformFilePathKeys(options)?.has(normalizeFilePathKey(filePath)) === true
}

export const hasRequiredAnalysis = (
  song: AnalysisCandidate,
  requiresRuntimeAnalysis: boolean,
  options: MissingAnalysisOptions = {}
) => resolveMissingAnalysisReasons(song, requiresRuntimeAnalysis, options).length === 0

export const resolveMissingAnalysisReasons = (
  song: AnalysisCandidate,
  _requiresRuntimeAnalysis: boolean,
  options: MissingAnalysisOptions = {}
) => {
  const reasons: string[] = []
  if (!hasUsableSongEnergyAnalysis(song)) reasons.push('missing-energy-score')
  if (!hasUsableKeyAnalysis(song)) reasons.push('missing-key')
  if (isWaveformMissing(song, options)) reasons.push('missing-waveform')

  const grid = resolveUsableSongBeatGrid(song)
  if (grid.kind === 'no-bpm') return reasons
  if (grid.kind === 'dynamic') {
    if (options.includeSongStructure === true && !hasRequiredSongStructureAnalysis(song)) {
      reasons.push('missing-song-structure')
    }
    return reasons
  }

  const bpm = Number(song.bpm)
  const firstBeatMs = Number(song.firstBeatMs)
  const barBeatOffset = Number(song.barBeatOffset)
  if (!Number.isFinite(bpm) || bpm <= 0) reasons.push('missing-bpm')
  if (!Number.isFinite(firstBeatMs)) reasons.push('missing-first-beat')
  if (!Number.isFinite(barBeatOffset)) reasons.push('missing-bar-beat-offset')
  if (
    grid.kind === 'fixed' &&
    options.includeSongStructure === true &&
    !hasRequiredSongStructureAnalysis(song)
  ) {
    reasons.push('missing-song-structure')
  }
  return reasons
}

export const collectMissingAnalysisFilesFromSongs = (
  songs: AnalysisCandidate[],
  requiresRuntimeAnalysis: boolean,
  seen = new Set<string>(),
  options: MissingAnalysisOptions = {}
) => {
  const files: string[] = []
  const resolvedOptions: MissingAnalysisOptions = {
    ...options,
    missingWaveformFilePathKeys: resolveMissingWaveformFilePathKeys(options)
  }
  for (const song of songs) {
    if (song.fileMissing) continue
    const filePath = String(song.filePath || '').trim()
    const key = normalizeFilePathKey(filePath)
    if (!filePath || seen.has(key)) continue
    if (hasRequiredAnalysis(song, requiresRuntimeAnalysis, resolvedOptions)) continue
    seen.add(key)
    files.push(filePath)
  }
  return files
}
