import { ipcMain } from 'electron'
import {
  clearInstalledAnalysisRuntimes,
  downloadPreferredAnalysisRuntime,
  getAnalysisRuntimeDownloadState,
  getPreferredAnalysisRuntimeDownloadInfo
} from '../services/analysisRuntimeDownload'

export function registerAnalysisRuntimeHandlers() {
  ipcMain.handle('analysis-runtime:get-status', async () => {
    return {
      preferred: await getPreferredAnalysisRuntimeDownloadInfo(),
      state: getAnalysisRuntimeDownloadState()
    }
  })

  ipcMain.handle('analysis-runtime:download-preferred', async () => {
    const started = await downloadPreferredAnalysisRuntime()
    return {
      started,
      state: getAnalysisRuntimeDownloadState()
    }
  })

  ipcMain.handle('analysis-runtime:clear-local', async () => {
    const cleared = await clearInstalledAnalysisRuntimes()
    return {
      success: true,
      cleared,
      state: getAnalysisRuntimeDownloadState()
    }
  })
}
