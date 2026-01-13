import { ipcMain } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import store from '../store'
import mainWindow from '../window/mainWindow'
import { mapRendererPathToFsPath, runWithConcurrency, waitForUserDecision } from '../utils'
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
  ipcMain.on(
    'delSongs',
    async (
      _e,
      payload: { filePaths: string[]; songListPath?: string; sourceType?: string } | string[]
    ) => {
      const filePaths = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.filePaths)
          ? payload.filePaths
          : []
      if (!filePaths.length) return
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
      const { success, failed, hasENOSPC, skipped, results } = await runWithConcurrency(tasks, {
        concurrency: 16,
        stopOnENOSPC: true,
        onInterrupted: async (payload) =>
          waitForUserDecision(mainWindow.instance ?? null, batchId, 'delSongs', payload)
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
      if (failed > 0) {
        throw new Error('delSongs failed')
      }
    }
  )

  ipcMain.handle('permanentlyDelSongs', async (_e, songFilePaths: string[]) => {
    const uniquePaths = Array.isArray(songFilePaths)
      ? Array.from(new Set(songFilePaths.filter(Boolean)))
      : []
    if (uniquePaths.length === 0) {
      return { total: 0, success: 0, failed: 0, removedPaths: [] }
    }
    const tasks = uniquePaths.map(async (item) => {
      const ok = await permanentlyDeleteFile(item)
      if (!ok) {
        throw new Error('delete failed')
      }
      return item
    })
    const results = await Promise.allSettled(tasks)
    const removedPaths = results
      .filter((r) => r.status === 'fulfilled')
      .map((r) => (r as any).value as string)
    const failed = results.filter((r) => r.status === 'rejected').length
    const success = results.length - failed
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
      const validTypes = ['root', 'library', 'dir', 'songList']
      return !!(node && validTypes.includes(node.nodeType))
    } catch {
      return false
    }
  })
}
