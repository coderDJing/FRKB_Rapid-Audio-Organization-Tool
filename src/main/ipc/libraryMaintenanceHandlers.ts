import { app, ipcMain } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import store from '../store'
import mainWindow from '../window/mainWindow'
import {
  getCoreFsDirName,
  mapRendererPathToFsPath,
  runWithConcurrency,
  waitForUserDecision
} from '../utils'
import {
  getRecycleBinRootAbs,
  moveFileToRecycleBin,
  normalizeRendererPlaylistPath,
  permanentlyDeleteFile,
  restoreRecycleBinFile,
  toLibraryRelativePath
} from '../recycleBinService'
import { findLibraryNodeByPath } from '../libraryTreeDb'
import {
  listRecycleBinRecords,
  deleteRecycleBinRecords,
  upsertRecycleBinRecord
} from '../recycleBinDb'
import { scanSongList as svcScanSongList } from '../services/scanSongs'
import { RECYCLE_BIN_UUID } from '../../shared/recycleBin'
import { getLibraryDb } from '../libraryDb'
import { getLibraryStemCacheRootAbs } from '../services/libraryStemAssetStorage'

const DIRTY_DATA_SQL_TABLES = [
  'song_cache',
  'cover_index',
  'waveform_cache',
  'pioneer_preview_waveform_cache',
  'mixtape_items',
  'mixtape_projects',
  'mixtape_stem_assets',
  'library_stem_assets',
  'mixtape_waveform_cache',
  'mixtape_raw_waveform_cache',
  'mixtape_waveform_hires_cache',
  'mixtape_stem_waveform_cache'
] as const

type DirtyDataSqlSummary = {
  removedRows: number
  removedByTable: Record<string, number>
  missingTables: string[]
}

type DirtyDataPathSummary = {
  removedCount: number
  removedPaths: string[]
}

function clearDirtyDataSqlTables(db: any): DirtyDataSqlSummary {
  const removedByTable: Record<string, number> = {}
  const missingTables: string[] = []
  let removedRows = 0
  const existingRows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{
    name: string
  }>
  const existingTableSet = new Set(existingRows.map((row) => String(row.name)))
  const runDelete = db.transaction(() => {
    for (const table of DIRTY_DATA_SQL_TABLES) {
      if (!existingTableSet.has(table)) {
        missingTables.push(table)
        removedByTable[table] = 0
        continue
      }
      const info = db.prepare(`DELETE FROM ${table}`).run() as { changes?: number }
      const changes = Number(info?.changes || 0)
      removedByTable[table] = changes
      removedRows += changes
    }
  })
  runDelete()
  return {
    removedRows,
    removedByTable,
    missingTables
  }
}

async function collectLibraryDirtyCacheTargets(libraryRoot: string): Promise<string[]> {
  if (!libraryRoot || !(await fs.pathExists(libraryRoot))) return []
  const targets: string[] = []
  const queue: string[] = [libraryRoot]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue
    let entries: fs.Dirent[] = []
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isFile() && entry.name === '.songs.cache.json') {
        targets.push(fullPath)
        continue
      }
      if (!entry.isDirectory()) continue
      if (entry.name === '.frkb_covers') {
        targets.push(fullPath)
        continue
      }
      if (entry.name.startsWith('.')) continue
      queue.push(fullPath)
    }
  }
  return targets
}

async function removeExistingPaths(paths: string[]): Promise<DirtyDataPathSummary> {
  const removedPaths: string[] = []
  const uniquePaths = Array.from(new Set(paths.filter((item) => !!item)))
  for (const item of uniquePaths) {
    try {
      if (!(await fs.pathExists(item))) continue
      await fs.remove(item)
      removedPaths.push(item)
    } catch {}
  }
  return {
    removedCount: removedPaths.length,
    removedPaths
  }
}

function normalizeAudioExtensions(input?: string[]): Set<string> {
  const result = new Set<string>()
  if (!Array.isArray(input)) return result
  for (const raw of input) {
    if (!raw) continue
    let ext = String(raw).trim().toLowerCase()
    if (!ext) continue
    if (!ext.startsWith('.')) ext = `.${ext}`
    result.add(ext)
  }
  return result
}

export function registerLibraryMaintenanceHandlers() {
  const executeDelSongs = async (
    payload: { filePaths: string[]; songListPath?: string; sourceType?: string } | string[]
  ) => {
    const filePaths = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.filePaths)
        ? payload.filePaths
        : []
    if (!filePaths.length) {
      return {
        total: 0,
        success: 0,
        failed: 0,
        skipped: 0,
        hasENOSPC: false,
        removedPaths: [] as string[]
      }
    }
    const originalPlaylistPath =
      payload && !Array.isArray(payload) && payload.songListPath
        ? normalizeRendererPlaylistPath(payload.songListPath)
        : null
    const sourceType =
      payload && !Array.isArray(payload) && payload.sourceType ? payload.sourceType : null
    const uniquePaths = Array.from(new Set(filePaths.filter(Boolean)))
    const tasks: Array<() => Promise<any>> = []
    for (const item of uniquePaths) {
      tasks.push(async () => {
        const result = await moveFileToRecycleBin(item, {
          originalPlaylistPath,
          sourceType
        })
        if (result.status === 'failed') {
          throw new Error(result.error || 'move to recycle bin failed')
        }
        return result
      })
    }
    const batchId = `delSongs_${Date.now()}`
    if (mainWindow.instance) {
      mainWindow.instance.webContents.send('progressSet', {
        id: batchId,
        titleKey: 'library.deleteProgressRemoving',
        now: 0,
        total: tasks.length,
        isInitial: true
      })
    }
    const { success, failed, hasENOSPC, skipped, results } = await runWithConcurrency(tasks, {
      concurrency: 16,
      onProgress: (done, total) => {
        if (mainWindow.instance) {
          mainWindow.instance.webContents.send('progressSet', {
            id: batchId,
            titleKey: 'library.deleteProgressRemoving',
            now: done,
            total
          })
        }
      },
      stopOnENOSPC: true,
      onInterrupted: async (interruptPayload) =>
        waitForUserDecision(mainWindow.instance ?? null, batchId, 'delSongs', interruptPayload)
    })
    if (hasENOSPC && mainWindow.instance) {
      mainWindow.instance.webContents.send('file-batch-summary', {
        context: 'delSongs',
        total: tasks.length,
        success,
        failed,
        hasENOSPC,
        skipped,
        errorSamples: results
          .map((r, i) =>
            r instanceof Error ? { code: (r as any).code, message: r.message, index: i } : null
          )
          .filter(Boolean)
          .slice(0, 3)
      })
    }
    if (mainWindow.instance) {
      mainWindow.instance.webContents.send('progressSet', {
        id: batchId,
        titleKey: 'library.deleteProgressRemoving',
        now: tasks.length,
        total: tasks.length
      })
    }
    const removedPaths = results
      .filter(
        (item): item is { status: string; srcPath: string } =>
          !!item && !(item instanceof Error) && typeof (item as any).srcPath === 'string'
      )
      .map((item) => item.srcPath)
    return {
      total: tasks.length,
      success,
      failed,
      skipped,
      hasENOSPC,
      removedPaths
    }
  }

  ipcMain.on(
    'delSongs',
    async (
      _e,
      payload: { filePaths: string[]; songListPath?: string; sourceType?: string } | string[]
    ) => {
      const summary = await executeDelSongs(payload)
      if (summary.failed > 0) {
        throw new Error('delSongs failed')
      }
    }
  )

  ipcMain.handle(
    'delSongsAwaitable',
    async (
      _e,
      payload: { filePaths: string[]; songListPath?: string; sourceType?: string } | string[]
    ) => {
      return await executeDelSongs(payload)
    }
  )

  ipcMain.handle('permanentlyDelSongs', async (_e, songFilePaths: string[]) => {
    const uniquePaths = Array.isArray(songFilePaths)
      ? Array.from(new Set(songFilePaths.filter(Boolean)))
      : []
    if (uniquePaths.length === 0) {
      return { total: 0, success: 0, failed: 0, removedPaths: [] }
    }
    const tasks = uniquePaths.map((item) => async () => {
      const ok = await permanentlyDeleteFile(item)
      if (!ok) {
        throw new Error('delete failed')
      }
      return item
    })
    const batchId = `permanentlyDelSongs_${Date.now()}`
    if (mainWindow.instance) {
      mainWindow.instance.webContents.send('progressSet', {
        id: batchId,
        titleKey: 'recycleBin.progressDeleting',
        now: 0,
        total: tasks.length,
        isInitial: true
      })
    }
    const { results, success, failed } = await runWithConcurrency(tasks, {
      concurrency: 16,
      onProgress: (done, total) => {
        if (mainWindow.instance) {
          mainWindow.instance.webContents.send('progressSet', {
            id: batchId,
            titleKey: 'recycleBin.progressDeleting',
            now: done,
            total
          })
        }
      }
    })
    if (mainWindow.instance) {
      mainWindow.instance.webContents.send('progressSet', {
        id: batchId,
        titleKey: 'recycleBin.progressDeleting',
        now: tasks.length,
        total: tasks.length
      })
    }
    const removedPaths = results
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item)
    return { total: results.length, success, failed, removedPaths }
  })

  ipcMain.handle('recycleBin:list', async () => {
    const records = listRecycleBinRecords()
    const recordMap = new Map(records.map((r) => [r.filePath, r]))
    const rootDir = store.databaseDir
    if (!rootDir) {
      return { scanData: [], songListUUID: RECYCLE_BIN_UUID }
    }
    const recycleRoot = getRecycleBinRootAbs()
    const recycleRootExists = recycleRoot ? await fs.pathExists(recycleRoot) : false
    if (recycleRootExists && recycleRoot) {
      const audioExts = normalizeAudioExtensions(store.settingConfig?.audioExt || [])
      let entries: fs.Dirent[] = []
      try {
        entries = await fs.readdir(recycleRoot, { withFileTypes: true })
      } catch {
        entries = []
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const ext = path.extname(entry.name).toLowerCase()
        if (!audioExts.has(ext)) continue
        const absPath = path.join(recycleRoot, entry.name)
        const rel = toLibraryRelativePath(absPath)
        if (!rel || recordMap.has(rel)) continue
        const stat = await fs.stat(absPath).catch(() => null)
        const deletedAtMs = stat && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : Date.now()
        const newRecord = {
          filePath: rel,
          deletedAtMs,
          originalPlaylistPath: null,
          originalFileName: entry.name,
          sourceType: null
        }
        upsertRecycleBinRecord(newRecord)
        records.push(newRecord)
        recordMap.set(rel, newRecord)
      }
    }
    const libraryRoot = path.join(rootDir, 'library')
    const existing: Array<{ record: any; absPath: string }> = []
    const missingRecords: string[] = []
    for (const record of records) {
      const absPath = path.isAbsolute(record.filePath)
        ? record.filePath
        : path.join(libraryRoot, record.filePath)
      if (!(await fs.pathExists(absPath))) {
        missingRecords.push(record.filePath)
      } else {
        existing.push({ record, absPath })
      }
    }
    if (missingRecords.length > 0) {
      deleteRecycleBinRecords(missingRecords)
    }
    const filePaths = existing.map((item) => item.absPath)
    const scanTarget = recycleRootExists && recycleRoot ? recycleRoot : filePaths
    if (Array.isArray(scanTarget) && scanTarget.length === 0) {
      return { scanData: [], songListUUID: RECYCLE_BIN_UUID }
    }
    const { scanData } = await svcScanSongList(
      scanTarget,
      store.settingConfig.audioExt,
      RECYCLE_BIN_UUID
    )
    const recordByPath = new Map<string, any>()
    for (const item of existing) {
      recordByPath.set(path.resolve(item.absPath), item.record)
    }
    const merged = scanData.map((song) => {
      const record = recordByPath.get(path.resolve(song.filePath))
      if (!record) return song
      return {
        ...song,
        deletedAtMs: record.deletedAtMs,
        originalPlaylistPath: record.originalPlaylistPath ?? null,
        recycleBinSourceType: record.sourceType ?? null
      }
    })
    return { scanData: merged, songListUUID: RECYCLE_BIN_UUID }
  })

  ipcMain.handle('recycleBin:restore', async (_e, payload: { filePaths?: string[] } | string[]) => {
    const filePaths = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.filePaths)
        ? payload.filePaths
        : []
    const uniquePaths = Array.from(new Set(filePaths.filter(Boolean)))
    if (uniquePaths.length === 0) {
      return {
        total: 0,
        restored: 0,
        missingPlaylist: 0,
        missingRecord: 0,
        missingFile: 0,
        failed: 0,
        removedPaths: [],
        playlistUuids: []
      }
    }
    const tasks = uniquePaths.map((filePath) => async () => {
      return await restoreRecycleBinFile(filePath)
    })
    const { results } = await runWithConcurrency(tasks, { concurrency: 8 })
    let restored = 0
    let missingPlaylist = 0
    let missingRecord = 0
    let missingFile = 0
    let failed = 0
    const removedPaths: string[] = []
    const playlistUuids = new Set<string>()
    for (const res of results) {
      if (res instanceof Error || !res) {
        failed += 1
        continue
      }
      if (res.status === 'restored') {
        restored += 1
        removedPaths.push(res.srcPath)
        if (res.playlistPath) {
          const node = findLibraryNodeByPath(path.join('library', res.playlistPath))
          if (node?.uuid) playlistUuids.add(node.uuid)
        }
        continue
      }
      if (res.status === 'missing_playlist') {
        missingPlaylist += 1
        continue
      }
      if (res.status === 'missing_record') {
        missingRecord += 1
        continue
      }
      if (res.status === 'missing_file') {
        missingFile += 1
        removedPaths.push(res.srcPath)
        continue
      }
      if (res.status === 'failed') {
        failed += 1
      }
    }
    return {
      total: uniquePaths.length,
      restored,
      missingPlaylist,
      missingRecord,
      missingFile,
      failed,
      removedPaths,
      playlistUuids: Array.from(playlistUuids)
    }
  })

  ipcMain.handle('dirPathExists', async (_e, targetPath: string) => {
    try {
      const mapped = mapRendererPathToFsPath(targetPath)
      const absPath = path.join(store.databaseDir, mapped)
      if (!(await fs.pathExists(absPath))) return false
      const node = findLibraryNodeByPath(mapped)
      const validTypes = ['root', 'library', 'dir', 'songList', 'mixtapeList']
      return !!(node && validTypes.includes(node.nodeType))
    } catch {
      return false
    }
  })

  ipcMain.handle('library:clear-dirty-data', async () => {
    const dbRoot = store.databaseDir
    if (!dbRoot) {
      throw new Error('databaseDir is empty')
    }
    const db = getLibraryDb()
    if (!db) {
      throw new Error('library db unavailable')
    }
    const database = clearDirtyDataSqlTables(db)

    const libraryRoot = path.join(dbRoot, 'library')
    const mixtapeVaultPath = path.join(
      libraryRoot,
      getCoreFsDirName('MixtapeLibrary'),
      '.mixtape_vault'
    )
    const libraryStemCachePath = getLibraryStemCacheRootAbs()
    const libraryDirtyTargets = await collectLibraryDirtyCacheTargets(libraryRoot)
    libraryDirtyTargets.push(mixtapeVaultPath)
    if (libraryStemCachePath) {
      libraryDirtyTargets.push(libraryStemCachePath)
    }
    const libraryCache = await removeExistingPaths(libraryDirtyTargets)

    const userDataRoot = app.getPath('userData')
    const userDataCache = await removeExistingPaths([
      path.join(userDataRoot, 'stems'),
      path.join(userDataRoot, 'cache', 'musicbrainz'),
      path.join(userDataRoot, 'fingerprintCache.json'),
      path.join(userDataRoot, 'waveforms', 'mixxx-waveform-v1')
    ])

    return {
      success: true,
      database,
      libraryCache,
      userDataCache
    }
  })
}
