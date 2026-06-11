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

const hasRequiredAnalysis = (
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
    for (const song of scan.scanData) {
      const filePath = String(song.filePath || '').trim()
      if (!filePath || seen.has(filePath)) continue
      if (hasRequiredAnalysis(song, requiresRuntimeAnalysis)) continue
      seen.add(filePath)
      files.push(filePath)
    }
  }
  return files
}

export const queueManualKeyAnalysisBatch = async (filePaths: string[], titleKey: string) =>
  await window.electron.ipcRenderer.invoke('key-analysis:queue-manual-batch', {
    filePaths,
    titleKey
  })
