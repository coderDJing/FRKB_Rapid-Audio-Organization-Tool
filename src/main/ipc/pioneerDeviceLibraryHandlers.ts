import { ipcMain } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { listPioneerRemovableDrives } from '../services/pioneerDeviceLibrary/deviceDetection'
import {
  buildPioneerPlaylistTree,
  loadPioneerPlaylistTracksByDrivePath,
  loadPioneerPlaylistTreeByDrivePath
} from '../services/pioneerDeviceLibrary/tree'
import {
  loadPioneerPreviewWaveformsByDrivePath,
  streamPioneerPreviewWaveformsByDrivePath
} from '../services/pioneerDeviceLibrary/waveform'

export function registerPioneerDeviceLibraryHandlers() {
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

  ipcMain.handle('pioneer-device-library:list-removable-drives', async () => {
    return await listPioneerRemovableDrives()
  })

  ipcMain.handle('pioneer-device-library:load-tree', async (_event, rootPath: string) => {
    const loaded = await loadPioneerPlaylistTreeByDrivePath(rootPath)
    return {
      ...loaded,
      treeNodes: buildPioneerPlaylistTree(loaded.nodes)
    }
  })

  ipcMain.handle(
    'pioneer-device-library:load-playlist-tracks',
    async (_event, rootPath: string, playlistId: number) => {
      return await loadPioneerPlaylistTracksByDrivePath(rootPath, playlistId)
    }
  )

  ipcMain.handle(
    'pioneer-device-library:get-preview-waveforms',
    async (_event, rootPath: string, analyzePaths: string[]) => {
      return await loadPioneerPreviewWaveformsByDrivePath(rootPath, analyzePaths)
    }
  )

  ipcMain.on(
    'pioneer-device-library:stream-preview-waveforms',
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
        const result = await streamPioneerPreviewWaveformsByDrivePath(
          rootPath,
          analyzePaths,
          (item) => {
            try {
              event.sender.send('pioneer-device-library:preview-waveform-item', {
                requestId,
                ...item
              })
            } catch {}
          }
        )
        try {
          event.sender.send('pioneer-device-library:preview-waveform-done', {
            requestId,
            drivePath: result.drivePath,
            total: result.total
          })
        } catch {}
      } catch (error) {
        try {
          event.sender.send('pioneer-device-library:preview-waveform-done', {
            requestId,
            error: error instanceof Error ? error.message : String(error || 'unknown error')
          })
        } catch {}
      }
    }
  )

  ipcMain.handle('pioneer-device-library:get-cover-thumb', async (_event, coverPath: string) => {
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
