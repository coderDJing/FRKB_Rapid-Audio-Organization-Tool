import { ipcMain } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  clearSongListCaches as svcClearSongListCaches,
  clearTrackCache as svcClearTrackCache,
  findSongListRoot
} from '../services/cacheMaintenance'
import store from '../store'
import { getLibrary, mapRendererPathToFsPath } from '../utils'
import * as LibraryCacheDb from '../libraryCacheDb'
import type { MixxxWaveformData } from '../waveformCache'

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

  ipcMain.handle(
    'waveform-cache:batch',
    async (
      _e,
      payload: {
        listRoot?: string
        filePaths?: string[]
      }
    ) => {
      const filePaths = Array.isArray(payload?.filePaths) ? payload.filePaths : []
      const normalizedPaths = filePaths.filter(
        (filePath) => typeof filePath === 'string' && filePath.trim().length > 0
      )
      if (normalizedPaths.length === 0) {
        return { items: [] as Array<{ filePath: string; data: MixxxWaveformData | null }> }
      }

      const items: Array<{ filePath: string; data: MixxxWaveformData | null }> = []
      const listRootRaw = typeof payload?.listRoot === 'string' ? payload.listRoot.trim() : ''
      let resolvedListRoot = ''
      if (listRootRaw) {
        let input = listRootRaw
        if (process.platform === 'win32' && /^\//.test(input)) input = input.replace(/^\/+/, '')
        if (path.isAbsolute(input)) {
          resolvedListRoot = input
        } else if (store.databaseDir) {
          const mapped = mapRendererPathToFsPath(input)
          resolvedListRoot = path.join(store.databaseDir, mapped)
        }
      }
      for (const filePath of normalizedPaths) {
        let listRoot = resolvedListRoot
        if (!listRoot) {
          listRoot = (await findSongListRoot(path.dirname(filePath))) || ''
        }
        if (!listRoot) {
          items.push({ filePath, data: null })
          continue
        }
        try {
          const fsStat = await fs.stat(filePath)
          const data = await LibraryCacheDb.loadWaveformCacheData(listRoot, filePath, {
            size: fsStat.size,
            mtimeMs: fsStat.mtimeMs
          })
          items.push({ filePath, data: data ?? null })
        } catch {
          await LibraryCacheDb.removeSongCacheEntry(listRoot, filePath)
          await LibraryCacheDb.removeWaveformCacheEntry(listRoot, filePath)
          items.push({ filePath, data: null })
        }
      }

      return { items }
    }
  )
}
