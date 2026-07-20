import libraryUtils from '@renderer/utils/libraryUtils'
import {
  collectMissingAnalysisFilesFromSongs,
  type MissingAnalysisOptions
} from './manualKeyAnalysisCompleteness'
import { useRuntimeStore } from '@renderer/stores/runtime'
import openAnalysisBpmRangeDialog from '@renderer/components/analysisBpmRangeDialog'
import {
  normalizeAnalysisBpmRangeId,
  type AnalysisBpmRangePresetId
} from '@shared/analysisBpmRange'

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

export const queueManualKeyAnalysisBatch = async (
  filePaths: string[],
  titleKey: string,
  analysisBpmRangeId: AnalysisBpmRangePresetId
) =>
  await window.electron.ipcRenderer.invoke('key-analysis:queue-manual-batch', {
    filePaths,
    titleKey,
    analysisBpmRangeId
  })

export const promptAndQueueManualKeyAnalysisBatch = async (
  filePaths: string[],
  titleKey: string
) => {
  const selectedRangeId = await promptAnalysisBpmRangeForManualBatch(filePaths.length)
  if (!selectedRangeId) {
    return { batchId: '', queued: 0, canceled: true }
  }
  return await queueManualKeyAnalysisBatch(filePaths, titleKey, selectedRangeId)
}

export const promptAnalysisBpmRangeForManualBatch = async (count: number) => {
  const runtime = useRuntimeStore()
  const initialRangeId = normalizeAnalysisBpmRangeId(runtime.setting.analysisBpmRange)
  const selectedRangeId = await openAnalysisBpmRangeDialog({
    count,
    initialRangeId
  })
  if (!selectedRangeId) return null

  if (runtime.setting.analysisBpmRange !== selectedRangeId) {
    runtime.setting.analysisBpmRange = selectedRangeId
    await window.electron.ipcRenderer.invoke(
      'setSetting',
      JSON.parse(JSON.stringify(runtime.setting))
    )
  }

  return selectedRangeId
}
