import {
  clearInstalledStemRuntimes,
  downloadPreferredStemRuntime,
  getPreferredStemRuntimeDownloadInfo,
  getStemRuntimeDownloadState,
  stemRuntimeDownloadEvents,
  type MixtapeStemRuntimeDownloadInfo,
  type MixtapeStemRuntimeDownloadState
} from './mixtapeStemRuntimeDownload'
import { resetBeatThisRuntimeResolution } from '../workers/beatThisRuntime'

export type AnalysisRuntimeDownloadInfo = MixtapeStemRuntimeDownloadInfo
export type AnalysisRuntimeDownloadState = MixtapeStemRuntimeDownloadState

export const analysisRuntimeDownloadEvents = stemRuntimeDownloadEvents

export const getPreferredAnalysisRuntimeDownloadInfo =
  async (): Promise<AnalysisRuntimeDownloadInfo> => await getPreferredStemRuntimeDownloadInfo()

export const getAnalysisRuntimeDownloadState = (): AnalysisRuntimeDownloadState =>
  getStemRuntimeDownloadState()

export const downloadPreferredAnalysisRuntime = async (): Promise<boolean> =>
  await downloadPreferredStemRuntime()

export const isAnalysisRuntimeAvailable = async (): Promise<boolean> => {
  const preferred = await getPreferredAnalysisRuntimeDownloadInfo()
  if (preferred.alreadyAvailable) return true
  const state = getAnalysisRuntimeDownloadState()
  return state.status === 'ready'
}

export const clearInstalledAnalysisRuntimes = async () => {
  const result = await clearInstalledStemRuntimes()
  resetBeatThisRuntimeResolution()
  return result
}
