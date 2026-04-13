import { ipcMain, type BrowserWindow } from 'electron'
import {
  startAudioConversion,
  cancelAudioConversion,
  listAvailableTargetFormats,
  filterOutFilesWithExistingConvertedCopies
} from '../../services/audioConversion'

export function registerAudioConversionHandlers(getWindow: () => BrowserWindow | null) {
  ipcMain.handle('audio:convert:start', async (_e, payload) => {
    return await startAudioConversion(getWindow(), payload)
  })

  ipcMain.on('audio:convert:cancel', (_e, jobId: string) => {
    cancelAudioConversion(jobId)
  })

  ipcMain.handle('audio:convert:list-target-formats', async () => {
    return await listAvailableTargetFormats()
  })

  ipcMain.handle('audio:convert:filter-existing-target-copies', async (_e, payload) => {
    return await filterOutFilesWithExistingConvertedCopies(
      Array.isArray(payload?.files) ? payload.files : [],
      payload?.targetFormat,
      payload?.outputDir
    )
  })
}
