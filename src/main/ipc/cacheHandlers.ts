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
import { queueMixtapeWaveforms, requestMixtapeWaveform } from '../services/mixtapeWaveformQueue'
import { requestMixtapeRawWaveform } from '../services/mixtapeRawWaveformQueue'

export function registerCacheHandlers() {
  const resolveRequestedRawRate = (value: unknown) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined
    return parsed
  }

  const resolveRequestedWaveformRate = (value: unknown) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined
    return parsed
  }

  const isRawWaveformRateSufficient = (data: any, requestedRate?: number) => {
    if (!data) return false
    if (!requestedRate) return true
    const cachedRate = Number(data?.rate)
    if (!Number.isFinite(cachedRate) || cachedRate <= 0) return false
    const sampleRate = Number(data?.sampleRate)
    const cappedSampleRate =
      Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : requestedRate
    const requiredRate = Math.max(1, Math.min(requestedRate, cappedSampleRate))
    return cachedRate >= requiredRate
  }

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
    'mixtape-waveform-raw:batch',
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
        return { items: [] as Array<{ filePath: string; data: any | null }> }
      }

      const targetRate = resolveRequestedRawRate(payload?.targetRate)
      const items: Array<{ filePath: string; data: any | null }> = []
      for (const filePath of normalizedPaths) {
        try {
          let listRoot = await findSongListRoot(path.dirname(filePath))
          let stat = await fs.stat(filePath).catch(() => null)
          let cached: any | null | undefined = null
          if (listRoot && stat) {
            cached = await LibraryCacheDb.loadMixtapeRawWaveformCacheData(listRoot, filePath, {
              size: stat.size,
              mtimeMs: stat.mtimeMs
            })
          }
          if (isRawWaveformRateSufficient(cached, targetRate)) {
            items.push({ filePath, data: cached })
            continue
          }
          const data = await requestMixtapeRawWaveform(filePath, targetRate)
          if (data && listRoot && stat) {
            await LibraryCacheDb.upsertMixtapeRawWaveformCacheEntry(
              listRoot,
              filePath,
              { size: stat.size, mtimeMs: stat.mtimeMs },
              data
            )
          }
          items.push({ filePath, data: data ?? null })
        } catch {
          items.push({ filePath, data: null })
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
          const data = await requestMixtapeWaveform(filePath, targetRate)
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
