import { ipcMain } from 'electron'
import globalSongSearchEngine, { markGlobalSongSearchDirty } from '../services/globalSongSearch'

export function registerSongSearchHandlers() {
  ipcMain.handle('song-search:warmup', async (_event, payload?: { force?: boolean }) => {
    const force = payload?.force === true
    return await globalSongSearchEngine.warmup(force)
  })

  ipcMain.handle(
    'song-search:query',
    async (_event, payload?: { keyword?: string; limit?: number }) => {
      const keyword = typeof payload?.keyword === 'string' ? payload.keyword : ''
      const limit = typeof payload?.limit === 'number' ? payload.limit : undefined
      return await globalSongSearchEngine.query(keyword, limit)
    }
  )

  ipcMain.handle(
    'song-search:playlist-fast-load',
    async (_event, payload?: { songListUUID?: string }) => {
      const songListUUID =
        typeof payload?.songListUUID === 'string' ? payload.songListUUID.trim() : ''
      return await globalSongSearchEngine.getPlaylistFastLoad(songListUUID)
    }
  )

  ipcMain.handle('song-search:mark-dirty', async (_event, payload?: { reason?: string }) => {
    const reason = typeof payload?.reason === 'string' ? payload.reason : undefined
    markGlobalSongSearchDirty(reason)
    return { success: true }
  })
}
