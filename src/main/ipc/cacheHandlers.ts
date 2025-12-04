import { ipcMain } from 'electron'
import {
  clearSongListCaches as svcClearSongListCaches,
  clearTrackCache as svcClearTrackCache
} from '../services/cacheMaintenance'
import { getLibrary } from '../utils'

export function registerCacheHandlers() {
  ipcMain.handle('playlist:cache:clear', async (_e, songListPath: string) => {
    await svcClearSongListCaches(songListPath)
  })

  ipcMain.handle('track:cache:clear', async (_e, filePath: string) => {
    await svcClearTrackCache(filePath)
  })

  ipcMain.handle('getLibrary', async () => {
    return await getLibrary()
  })
}
