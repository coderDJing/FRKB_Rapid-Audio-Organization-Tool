import libraryUtils from '@renderer/utils/libraryUtils'
import {
  collectMissingAnalysisFilesFromSongs,
  type MissingAnalysisOptions
} from './manualKeyAnalysisCompleteness'

export {
  collectMissingAnalysisFilesFromSongs,
  hasRequiredAnalysis,
  resolveMissingAnalysisReasons,
  type AnalysisCandidate,
  type MissingAnalysisOptions
} from './manualKeyAnalysisCompleteness'

type ScanSongListResult = {
  scanData?: Array<{
    filePath?: string
    key?: unknown
    bpm?: unknown
    firstBeatMs?: unknown
    barBeatOffset?: unknown
    beatGridMap?: unknown
    beatGridStatus?: unknown
    energyScore?: unknown
    energyAlgorithmVersion?: unknown
    songStructure?: unknown
  }>
  missingWaveformFilePaths?: string[]
}

export const scanSongListsForMissingAnalysisFiles = async (
  uuids: string[],
  requiresRuntimeAnalysis: boolean,
  options: MissingAnalysisOptions = {}
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
      ...collectMissingAnalysisFilesFromSongs(scan.scanData, requiresRuntimeAnalysis, seen, {
        ...options,
        missingWaveformFilePaths: Array.isArray(scan.missingWaveformFilePaths)
          ? scan.missingWaveformFilePaths
          : undefined
      })
    )
  }
  return files
}

export const queueManualKeyAnalysisBatch = async (filePaths: string[], titleKey: string) =>
  await window.electron.ipcRenderer.invoke('key-analysis:queue-manual-batch', {
    filePaths,
    titleKey
  })
