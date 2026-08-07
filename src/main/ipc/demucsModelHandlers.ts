import { ipcMain } from 'electron'
import { isMixtapeStemQueueBusy } from '../services/mixtapeStemQueue'
import {
  downloadDemucsUltraModel,
  getDemucsUltraModelDownloadInfo,
  getDemucsUltraModelDownloadState,
  isDemucsUltraModelDownloadBusy,
  removeDemucsUltraModel
} from '../services/demucsUltraModelDownload'

export function registerDemucsModelHandlers() {
  ipcMain.handle('demucs-model:get-ultra-status', async () => {
    return await getDemucsUltraModelDownloadInfo()
  })

  ipcMain.handle('demucs-model:download-ultra', async () => {
    const started = await downloadDemucsUltraModel()
    return {
      started,
      state: getDemucsUltraModelDownloadState(),
      info: await getDemucsUltraModelDownloadInfo()
    }
  })

  ipcMain.handle('demucs-model:remove-ultra', async () => {
    if (isDemucsUltraModelDownloadBusy() || isMixtapeStemQueueBusy()) {
      return { removedModel: false, removedDownloadCache: false, busy: true }
    }
    const result = await removeDemucsUltraModel()
    return {
      ...result,
      info: await getDemucsUltraModelDownloadInfo()
    }
  })
}
