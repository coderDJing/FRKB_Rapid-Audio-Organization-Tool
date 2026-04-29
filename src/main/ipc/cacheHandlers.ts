import { ipcMain } from 'electron'
import { FIXED_MIXTAPE_STEM_MODE } from '../../shared/mixtapeStemMode'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  clearTrackCache as svcClearTrackCache,
  findSongListRoot
} from '../services/cacheMaintenance'
import store from '../store'
import { getLibrary, mapRendererPathToFsPath } from '../utils'
import * as LibraryCacheDb from '../libraryCacheDb'
import type { MixxxWaveformData } from '../waveformCache'
import type { StemWaveformDataLite } from '../stemWaveformCache'
import { queueMixtapeWaveforms } from '../services/mixtapeWaveformQueue'
import { ensureMixtapeWaveformHires } from '../services/mixtapeWaveformHiresQueue'
import { ensureMixtapeStemWaveformBundle } from '../services/mixtapeStemWaveformService'
import { registerMixtapeRawWaveformHandlers } from './mixtapeRawWaveformHandlers'

export function registerCacheHandlers() {
  registerMixtapeRawWaveformHandlers()

  const resolveRequestedWaveformRate = (value: unknown) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined
    return parsed
  }

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

  ipcMain.handle(
    'mixtape-waveform-cache:batch',
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
          const data = await LibraryCacheDb.loadMixtapeWaveformCacheData(listRoot, filePath, {
            size: fsStat.size,
            mtimeMs: fsStat.mtimeMs
          })
          items.push({ filePath, data: data ?? null })
        } catch {
          await LibraryCacheDb.removeMixtapeWaveformCacheEntry(listRoot, filePath)
          items.push({ filePath, data: null })
        }
      }

      return { items }
    }
  )

  ipcMain.handle(
    'mixtape-stem-waveform-cache:batch',
    async (
      _e,
      payload: {
        items?: Array<{
          listRoot?: string
          sourceFilePath?: string
          stemMode?: typeof FIXED_MIXTAPE_STEM_MODE
          stemModel?: string
          stemVersion?: string
          stemPaths?: {
            vocalPath?: string
            instPath?: string
            bassPath?: string
            drumsPath?: string
          }
        }>
      }
    ) => {
      const requests = Array.isArray(payload?.items) ? payload.items : []
      if (!requests.length) {
        return {
          items: [] as Array<{
            sourceFilePath: string
            stems: Array<{ stemId: string; filePath: string; data: StemWaveformDataLite | null }>
          }>
        }
      }

      const items: Array<{
        sourceFilePath: string
        stems: Array<{ stemId: string; filePath: string; data: StemWaveformDataLite | null }>
      }> = []
      for (const request of requests) {
        const sourceFilePath =
          typeof request?.sourceFilePath === 'string' ? request.sourceFilePath.trim() : ''
        if (!sourceFilePath) {
          items.push({ sourceFilePath: '', stems: [] })
          continue
        }
        const stemMode = FIXED_MIXTAPE_STEM_MODE
        try {
          const result = await ensureMixtapeStemWaveformBundle({
            listRoot: typeof request?.listRoot === 'string' ? request.listRoot.trim() : '',
            sourceFilePath,
            stemMode,
            stemModel: request?.stemModel,
            stemVersion: request?.stemVersion,
            stemPaths: {
              vocalPath: request?.stemPaths?.vocalPath,
              instPath: request?.stemPaths?.instPath,
              bassPath: request?.stemPaths?.bassPath,
              drumsPath: request?.stemPaths?.drumsPath
            }
          })
          if (!result) {
            items.push({ sourceFilePath, stems: [] })
            continue
          }
          items.push({
            sourceFilePath: result.sourceFilePath,
            stems: result.stems.map((stem) => ({
              stemId: stem.stemId,
              filePath: stem.filePath,
              data: stem.data ?? null
            }))
          })
        } catch {
          items.push({ sourceFilePath, stems: [] })
        }
      }

      return { items }
    }
  )

  ipcMain.handle(
    'mixtape-waveform-hires:batch',
    async (
      _e,
      payload: {
        filePaths?: string[]
        targetRate?: number
      }
    ) => {
      const filePaths = Array.isArray(payload?.filePaths) ? payload.filePaths : []
      const normalizedPaths = filePaths.filter(
        (filePath) => typeof filePath === 'string' && filePath.trim().length > 0
      )
      if (normalizedPaths.length === 0) {
        return { items: [] as Array<{ filePath: string; data: MixxxWaveformData | null }> }
      }

      const targetRate = resolveRequestedWaveformRate(payload?.targetRate)
      const items: Array<{ filePath: string; data: MixxxWaveformData | null }> = []
      for (const filePath of normalizedPaths) {
        try {
          const result = await ensureMixtapeWaveformHires(filePath, {
            targetRate
          })
          const data = result?.data ?? null
          items.push({ filePath, data: data ?? null })
        } catch {
          items.push({ filePath, data: null })
        }
      }

      return { items }
    }
  )

  ipcMain.on(
    'mixtape-waveform:queue-visible',
    (_e, payload: { listRoot?: string; filePaths?: string[] }) => {
      const filePaths = Array.isArray(payload?.filePaths) ? payload.filePaths : []
      const normalizedPaths = filePaths.filter(
        (filePath) => typeof filePath === 'string' && filePath.trim().length > 0
      )
      if (normalizedPaths.length === 0) return
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
      queueMixtapeWaveforms(normalizedPaths, resolvedListRoot || undefined)
    }
  )
}
