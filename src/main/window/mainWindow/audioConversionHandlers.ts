import { ipcMain, type BrowserWindow } from 'electron'
import {
  startAudioConversion,
  cancelAudioConversion,
  listAvailableTargetFormats
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
}
