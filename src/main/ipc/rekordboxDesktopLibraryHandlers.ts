import { ipcMain } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { probeRekordboxDesktopLibrary } from '../services/rekordboxDesktopLibrary/detect'
import { loadRekordboxDesktopPlaylistTree } from '../services/rekordboxDesktopLibrary/tree'
import { loadRekordboxDesktopPlaylistTracks } from '../services/rekordboxDesktopLibrary/tracks'
import {
  loadRekordboxDesktopPreviewWaveforms,
  streamRekordboxDesktopPreviewWaveforms
} from '../services/rekordboxDesktopLibrary/waveform'
import { buildPioneerPlaylistTree } from '../services/pioneerDeviceLibrary/tree'

export function registerRekordboxDesktopLibraryHandlers() {
  const mimeFromExt = (ext: string) =>
    ext === '.png'
      ? 'image/png'
      : ext === '.webp'
        ? 'image/webp'
        : ext === '.gif'
          ? 'image/gif'
          : ext === '.bmp'
            ? 'image/bmp'
            : 'image/jpeg'

  ipcMain.handle('rekordbox-desktop-library:probe', async () => {
    return await probeRekordboxDesktopLibrary(true)
  })

  ipcMain.handle('rekordbox-desktop-library:load-tree', async () => {
    const loaded = await loadRekordboxDesktopPlaylistTree()
    return {
      ...loaded.probe,
      treeNodes: buildPioneerPlaylistTree(loaded.nodes)
    }
  })

  ipcMain.handle(
    'rekordbox-desktop-library:load-playlist-tracks',
    async (_event, playlistId: number) => {
      const loaded = await loadRekordboxDesktopPlaylistTracks(playlistId)
      return {
        ...loaded.probe,
        playlistId: loaded.playlistId,
        playlistName: loaded.playlistName,
        trackTotal: loaded.trackTotal,
        tracks: loaded.tracks
      }
    }
  )

  ipcMain.handle(
    'rekordbox-desktop-library:get-preview-waveforms',
    async (_event, rootPath: string, analyzePaths: string[]) => {
      return await loadRekordboxDesktopPreviewWaveforms(rootPath, analyzePaths)
    }
  )

  ipcMain.on(
    'rekordbox-desktop-library:stream-preview-waveforms',
    async (
      event,
      payload: {
        requestId?: string
        rootPath?: string
        analyzePaths?: string[]
      }
    ) => {
      const requestId = String(payload?.requestId || '').trim()
      if (!requestId) return
      const rootPath = String(payload?.rootPath || '').trim()
      const analyzePaths = Array.isArray(payload?.analyzePaths) ? payload.analyzePaths : []

      try {
        const result = await streamRekordboxDesktopPreviewWaveforms(
          rootPath,
          analyzePaths,
          (item) => {
            try {
              event.sender.send('rekordbox-desktop-library:preview-waveform-item', {
                requestId,
                ...item
              })
            } catch {}
          }
        )
        try {
          event.sender.send('rekordbox-desktop-library:preview-waveform-done', {
            requestId,
            rootPath: result.rootPath,
            total: result.total
          })
        } catch {}
      } catch (error) {
        try {
          event.sender.send('rekordbox-desktop-library:preview-waveform-done', {
            requestId,
            error: error instanceof Error ? error.message : String(error || 'unknown error')
          })
        } catch {}
      }
    }
  )

  ipcMain.handle('rekordbox-desktop-library:get-cover-thumb', async (_event, coverPath: string) => {
    const normalized = String(coverPath || '').trim()
    if (!normalized) return null
    try {
      const data = await fs.readFile(normalized)
      const mime = mimeFromExt(path.extname(normalized).toLowerCase())
      return {
        format: mime,
        data,
        dataUrl: `data:${mime};base64,${data.toString('base64')}`
      }
    } catch {
      return null
    }
  })
}
