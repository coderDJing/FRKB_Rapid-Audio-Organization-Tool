import libraryUtils from '@renderer/utils/libraryUtils'

type ScanSongListResult = {
  scanData?: Array<{
    filePath?: string
    key?: unknown
    bpm?: unknown
    firstBeatMs?: unknown
    barBeatOffset?: unknown
  }>
}

type AnalysisCandidate = {
  filePath?: string
  key?: unknown
  bpm?: unknown
  firstBeatMs?: unknown
  barBeatOffset?: unknown
  fileMissing?: boolean
}

const normalizeFilePathKey = (filePath: string) => filePath.replace(/\//g, '\\').toLowerCase()

export const hasRequiredAnalysis = (
  song: { key?: unknown; bpm?: unknown; firstBeatMs?: unknown; barBeatOffset?: unknown },
  requiresRuntimeAnalysis: boolean
) => {
  const keyText = typeof song.key === 'string' ? song.key.trim() : ''
  if (!keyText) return false
  if (!requiresRuntimeAnalysis) return true
  const bpm = Number(song.bpm)
  const firstBeatMs = Number(song.firstBeatMs)
  const barBeatOffset = Number(song.barBeatOffset)
  return (
    Number.isFinite(bpm) &&
    bpm > 0 &&
    Number.isFinite(firstBeatMs) &&
    Number.isFinite(barBeatOffset)
  )
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
