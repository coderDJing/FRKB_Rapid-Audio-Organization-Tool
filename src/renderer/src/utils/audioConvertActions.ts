import type { AudioConvertDialogResult } from '@renderer/components/audioConvertDialog.types'
import type { SupportedAudioFormat } from '@shared/audioFormats'

type StartAudioConvertFromFilesArgs = {
  files: string[]
  songListUUID?: string
  allowedSourceExts: string[]
  presetTargetFormat?: SupportedAudioFormat
  lockTargetFormat?: boolean
  excludeSameFormatAsTarget?: boolean
  skipExistingTargetCopies?: boolean
}

type StartAudioConvertFromFilesResult =
  | { status: 'started'; files: string[] }
  | { status: 'cancel'; files: string[] }
  | { status: 'no-files'; files: string[] }

type SongListScanRequest = {
  songListPath: string | string[]
  songListUUID: string
}

type CollectFilesForAudioConvertResult = {
  files: string[]
}

type FilterExistingTargetCopiesPayload = {
  files: string[]
  targetFormat: SupportedAudioFormat
  outputDir?: string
}

const getFileExtension = (filePath: string) => {
  const normalizedPath = String(filePath || '').toLowerCase()
  return normalizedPath.match(/\.[^\\/.]+$/)?.[0] || ''
}

const isSameFormatAsTarget = (filePath: string, targetFormat: SupportedAudioFormat) => {
  const ext = getFileExtension(filePath)
  if (targetFormat === 'aif' || targetFormat === 'aiff') {
    return ext === '.aif' || ext === '.aiff'
  }
  return ext === `.${targetFormat}`
}

export const filterFilesByTargetFormat = (files: string[], targetFormat: SupportedAudioFormat) =>
  Array.from(new Set(files.map((item) => String(item || '').trim()).filter(Boolean))).filter(
    (filePath) => !isSameFormatAsTarget(filePath, targetFormat)
  )

export const collectSourceExts = (files: string[], allowedSourceExts: string[]) => {
  const allowedExtSet = new Set(allowedSourceExts.map((item) => String(item || '').toLowerCase()))
  return Array.from(
    new Set(
      files
        .map((filePath) => getFileExtension(filePath))
        .filter((extension) => allowedExtSet.has(extension))
    )
  )
}

export const collectFilesForAudioConvert = async (songLists: SongListScanRequest[]) => {
  const result = (await window.electron.ipcRenderer.invoke('audio:convert:collect-files', {
    songLists,
    titleKey: 'convert.scanningSourceFiles'
  })) as CollectFilesForAudioConvertResult | null

  return Array.isArray(result?.files)
    ? result.files.map((item) => String(item || '').trim()).filter(Boolean)
    : []
}

export const startAudioConvertFromFiles = async ({
  files,
  songListUUID,
  allowedSourceExts,
  presetTargetFormat,
  lockTargetFormat = false,
  excludeSameFormatAsTarget = false,
  skipExistingTargetCopies = false
}: StartAudioConvertFromFilesArgs): Promise<StartAudioConvertFromFilesResult> => {
  const uniqueFiles = Array.from(
    new Set(files.map((item) => String(item || '').trim()).filter(Boolean))
  )
  const filteredFiles =
    excludeSameFormatAsTarget && presetTargetFormat
      ? filterFilesByTargetFormat(uniqueFiles, presetTargetFormat)
      : uniqueFiles

  if (filteredFiles.length === 0) {
    return { status: 'no-files', files: filteredFiles }
  }

  const sourceExts = collectSourceExts(filteredFiles, allowedSourceExts)
  const { default: openConvertDialog } = await import('@renderer/components/audioConvertDialog')
  const dialogResult = (await openConvertDialog({
    sourceExts,
    presetTargetFormat,
    lockTargetFormat
  })) as AudioConvertDialogResult

  if (dialogResult === 'cancel' || 'files' in dialogResult) {
    return { status: 'cancel', files: filteredFiles }
  }

  let filesToConvert = filteredFiles
  if (skipExistingTargetCopies && dialogResult.strategy === 'new_file') {
    const payload: FilterExistingTargetCopiesPayload = {
      files: filteredFiles,
      targetFormat: dialogResult.targetFormat,
      outputDir: dialogResult.outputDir
    }
    const result = (await window.electron.ipcRenderer.invoke(
      'audio:convert:filter-existing-target-copies',
      payload
    )) as string[] | null
    filesToConvert = Array.isArray(result)
      ? result.map((item) => String(item || '').trim()).filter(Boolean)
      : filteredFiles
    if (filesToConvert.length === 0) {
      return { status: 'no-files', files: filesToConvert }
    }
  }

  await window.electron.ipcRenderer.invoke('audio:convert:start', {
    files: filesToConvert,
    options: dialogResult,
    songListUUID
  })

  return { status: 'started', files: filesToConvert }
}
