import libraryUtils from '@renderer/utils/libraryUtils'
import {
  CURRENT_SONG_ENERGY_ALGORITHM_VERSION,
  hasCurrentSongEnergyAnalysis,
  normalizeSongEnergyScore
} from '@shared/songEnergy'

type ScanSongListResult = {
  scanData?: Array<{
    filePath?: string
    key?: unknown
    bpm?: unknown
    firstBeatMs?: unknown
    barBeatOffset?: unknown
    beatGridStatus?: unknown
    energyScore?: unknown
    energyAlgorithmVersion?: unknown
  }>
}

type AnalysisCandidate = {
  filePath?: string
  key?: unknown
  bpm?: unknown
  firstBeatMs?: unknown
  barBeatOffset?: unknown
  beatGridStatus?: unknown
  energyScore?: unknown
  energyAlgorithmVersion?: unknown
  fileMissing?: boolean
}

const normalizeFilePathKey = (filePath: string) => filePath.replace(/\//g, '\\').toLowerCase()

export const hasRequiredAnalysis = (
  song: {
    key?: unknown
    bpm?: unknown
    firstBeatMs?: unknown
    barBeatOffset?: unknown
    beatGridStatus?: unknown
    energyScore?: unknown
    energyAlgorithmVersion?: unknown
  },
  requiresRuntimeAnalysis: boolean
) => resolveMissingAnalysisReasons(song, requiresRuntimeAnalysis).length === 0

export const resolveMissingAnalysisReasons = (
  song: {
    key?: unknown
    bpm?: unknown
    firstBeatMs?: unknown
    barBeatOffset?: unknown
    beatGridStatus?: unknown
    energyScore?: unknown
    energyAlgorithmVersion?: unknown
  },
  requiresRuntimeAnalysis: boolean
) => {
  const reasons: string[] = []
  if (!hasCurrentSongEnergyAnalysis(song)) {
    reasons.push(
      normalizeSongEnergyScore(song.energyScore) === undefined
        ? 'missing-energy-score'
        : `stale-energy-version:${String(song.energyAlgorithmVersion || '')}->${CURRENT_SONG_ENERGY_ALGORITHM_VERSION}`
    )
  }
  const keyText = typeof song.key === 'string' ? song.key.trim() : ''
  if (!keyText) reasons.push('missing-key')
  if (!requiresRuntimeAnalysis) return reasons
  if (song.beatGridStatus === 'no-bpm') return reasons
  const bpm = Number(song.bpm)
  const firstBeatMs = Number(song.firstBeatMs)
  const barBeatOffset = Number(song.barBeatOffset)
  if (!Number.isFinite(bpm) || bpm <= 0) reasons.push('missing-bpm')
  if (!Number.isFinite(firstBeatMs)) reasons.push('missing-first-beat')
  if (!Number.isFinite(barBeatOffset)) reasons.push('missing-bar-beat-offset')
  return reasons
}

export const collectMissingAnalysisFilesFromSongs = (
  songs: AnalysisCandidate[],
  requiresRuntimeAnalysis: boolean,
  seen = new Set<string>()
) => {
  const files: string[] = []
  for (const song of songs) {
    if (song.fileMissing) continue
    const filePath = String(song.filePath || '').trim()
    const key = normalizeFilePathKey(filePath)
    if (!filePath || seen.has(key)) continue
    if (hasRequiredAnalysis(song, requiresRuntimeAnalysis)) continue
    seen.add(key)
    files.push(filePath)
  }
  return files
}

export const scanSongListsForMissingAnalysisFiles = async (
  uuids: string[],
  requiresRuntimeAnalysis: boolean
): Promise<string[]> => {
  const files: string[] = []
  const seen = new Set<string>()
  for (const uuid of uuids) {
    const dirPath = libraryUtils.findDirPathByUuid(uuid)
    const scan = (await window.electron.ipcRenderer.invoke(
      'scanSongList',
      dirPath,
      uuid
    )) as ScanSongListResult | null
    if (!Array.isArray(scan?.scanData)) continue
    files.push(
      ...collectMissingAnalysisFilesFromSongs(scan.scanData, requiresRuntimeAnalysis, seen)
    )
  }
  return files
}

export const queueManualKeyAnalysisBatch = async (filePaths: string[], titleKey: string) =>
  await window.electron.ipcRenderer.invoke('key-analysis:queue-manual-batch', {
    filePaths,
    titleKey
  })
