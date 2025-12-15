import { ipcMain, type BrowserWindow } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import { v4 as uuidV4 } from 'uuid'
import store from '../../store'
import FingerprintStore from '../../fingerprintStore'
import {
  collectFilesWithExtensions,
  getSongsAnalyseResult,
  runWithConcurrency,
  waitForUserDecision,
  getCoreFsDirName,
  moveOrCopyItemWithCheckIsExist,
  operateHiddenFile
} from '../../utils'
import type { IImportSongsFormData, md5 } from '../../../types/globals'
import type { SendProgress } from './progress'

export function registerImportHandlers(
  sendProgress: SendProgress,
  getWindow: () => BrowserWindow | null
) {
  ipcMain.on('startImportSongs', async (_e, formData: IImportSongsFormData) => {
    const importStartAt = Date.now()
    const progressId = `import_${Date.now()}`
    sendProgress('fingerprints.scanningFiles', 0, 1, true, progressId)
    let filePaths = formData.selectedPaths || formData.filePaths || formData.folderPath
    if (filePaths === undefined) {
      filePaths = []
    }
    let songFileUrls: string[] = []
    for (const filePath of filePaths) {
      const stats = await fs.stat(filePath)
      if (stats.isFile()) {
        const ext = path.extname(filePath).toLowerCase()
        if (store.settingConfig.audioExt.includes(ext)) {
          songFileUrls.push(filePath)
        }
      } else if (stats.isDirectory()) {
        const files = await collectFilesWithExtensions(filePath, store.settingConfig.audioExt)
        songFileUrls = songFileUrls.concat(files)
      }
    }
    sendProgress('fingerprints.scanningFiles', 1, 1, true, progressId)
    if (songFileUrls.length === 0) {
      getWindow()?.webContents.send('noAudioFileWasScanned', progressId)
      return
    }
    songFileUrls = Array.from(new Set(songFileUrls))
    let { isComparisonSongFingerprint, isPushSongFingerprintLibrary, isDeleteSourceFile } = formData
    const incomingDedupMode = (formData as any).deduplicateMode as
      | 'library'
      | 'batch'
      | 'none'
      | undefined
    const dedupMode: 'library' | 'batch' | 'none' =
      incomingDedupMode ?? (isComparisonSongFingerprint ? 'library' : 'none')
    const needAnalyze = dedupMode !== 'none' || isPushSongFingerprintLibrary
    const songFingerprintListLengthBefore = store.songFingerprintList.length
    let toBeDealSongs: (md5 | string)[] = []
    let delList: string[] = []
    let songsAnalyseResult: md5[] = []
    let errorSongsAnalyseResult: md5[] = []
    let alreadyExistInSongFingerprintList = new Set()
    if (needAnalyze) {
      sendProgress('fingerprints.analyzeInit', 0, songFileUrls.length, false, progressId)
      const analyseResult = await getSongsAnalyseResult(songFileUrls, (resultLength: number) =>
        sendProgress(
          'fingerprints.analyzingFingerprints',
          resultLength,
          songFileUrls.length,
          false,
          progressId
        )
      )
      songsAnalyseResult = analyseResult.songsAnalyseResult
      errorSongsAnalyseResult = analyseResult.errorSongsAnalyseResult
      if (dedupMode === 'library') {
        const uniqueSongs = new Map()
        delList = songsAnalyseResult
          .filter((song) => {
            if (store.songFingerprintList.includes(song.sha256_Hash)) {
              alreadyExistInSongFingerprintList.add(song.sha256_Hash)
              return true
            }
            return false
          })
          .map((song) => song.file_path)
        const duplicates: string[] = []
        songsAnalyseResult
          .filter((song) => !delList.includes(song.file_path))
          .forEach((song) => {
            if (uniqueSongs.has(song.sha256_Hash)) {
              duplicates.push(song.file_path)
            } else {
              uniqueSongs.set(song.sha256_Hash, song)
            }
          })
        delList = delList.concat(duplicates)
        if (isDeleteSourceFile && delList.length > 0) {
          await moveToRecycleBin(delList, progressId, getWindow, sendProgress)
        }
        toBeDealSongs = Array.from(uniqueSongs.values())
      } else if (dedupMode === 'batch') {
        const uniqueSongs = new Map()
        const duplicates: string[] = []
        songsAnalyseResult.forEach((song) => {
          if (uniqueSongs.has(song.sha256_Hash)) {
            duplicates.push(song.file_path)
          } else {
            uniqueSongs.set(song.sha256_Hash, song)
          }
        })
        delList = duplicates
        if (isDeleteSourceFile && delList.length > 0) {
          await moveToRecycleBin(delList, progressId, getWindow, sendProgress)
        }
        toBeDealSongs = Array.from(uniqueSongs.values())
      } else if (isPushSongFingerprintLibrary) {
        toBeDealSongs = songsAnalyseResult
      }
    } else {
      toBeDealSongs = songFileUrls
    }

    const tasks: Array<() => Promise<any>> = []
    const fingerprintsToAdd: string[] = []
    for (const item of toBeDealSongs) {
      const matchResult = (item as any).file_path
        ? (item as any).file_path.match(/[^\\/]+$/)
        : typeof item === 'string'
          ? item.match(/[^\\/]+$/)
          : null
      const filename = matchResult ? matchResult[0] : 'unknown_file'
      const targetPath = path.join(store.databaseDir, formData.songListPath, filename)
      const srcPath = (item as any).file_path ? (item as any).file_path : (item as string)
      const sha = (item as any)?.sha256_Hash as string | undefined
      tasks.push(async () => {
        await moveOrCopyItemWithCheckIsExist(srcPath, targetPath, isDeleteSourceFile)
        if (isPushSongFingerprintLibrary && sha) {
          fingerprintsToAdd.push(sha)
        }
      })
    }

    const batchId = `import_${Date.now()}`
    const { success, failed, hasENOSPC, skipped } = await runWithConcurrency(tasks, {
      concurrency: 16,
      onProgress: (done, total) =>
        sendProgress(
          isDeleteSourceFile ? 'tracks.movingTracks' : 'tracks.copyingTracks',
          done,
          total,
          false,
          progressId
        ),
      stopOnENOSPC: true,
      onInterrupted: async (payload) =>
        waitForUserDecision(getWindow(), batchId, 'importSongs', payload)
    })

    sendProgress(
      isDeleteSourceFile ? 'tracks.movingTracks' : 'tracks.copyingTracks',
      tasks.length,
      tasks.length,
      false,
      progressId
    )

    if (isPushSongFingerprintLibrary && fingerprintsToAdd.length > 0) {
      const uniqueToAdd = Array.from(new Set(fingerprintsToAdd))
      const beforeLen = store.songFingerprintList.length
      store.songFingerprintList = Array.from(
        new Set([...store.songFingerprintList, ...uniqueToAdd])
      )
      if (store.songFingerprintList.length !== beforeLen) {
        await FingerprintStore.saveList(
          store.songFingerprintList,
          ((store as any).settingConfig?.fingerprintMode as 'pcm' | 'file') || 'pcm'
        )
      }
    }

    const importEndAt = Date.now()
    const attemptedUniqueToAdd = isPushSongFingerprintLibrary
      ? Array.from(new Set(fingerprintsToAdd)).length
      : 0
    const actualAddedCount = isPushSongFingerprintLibrary
      ? Math.max(0, store.songFingerprintList.length - songFingerprintListLengthBefore)
      : 0
    const alreadyExistingCount = isPushSongFingerprintLibrary
      ? Math.max(0, attemptedUniqueToAdd - actualAddedCount)
      : 0

    const importSummary = {
      startAt: new Date(importStartAt).toISOString(),
      endAt: new Date(importEndAt).toISOString(),
      durationMs: importEndAt - importStartAt,
      scannedCount: songFileUrls.length,
      analyzeFailedCount: errorSongsAnalyseResult.length,
      importedToPlaylistCount: success,
      duplicatesRemovedCount: dedupMode !== 'none' ? delList.length : 0,
      fingerprintAddedCount: actualAddedCount,
      fingerprintAlreadyExistingCount: alreadyExistingCount,
      fingerprintTotalBefore: songFingerprintListLengthBefore,
      fingerprintTotalAfter: store.songFingerprintList.length,
      isComparisonSongFingerprint: dedupMode !== 'none',
      isPushSongFingerprintLibrary,
      fingerprintMode: ((store as any).settingConfig?.fingerprintMode as 'pcm' | 'file') || 'pcm'
    }

    getWindow()?.webContents.send(
      'importFinished',
      formData.songListUUID,
      importSummary,
      progressId
    )
    if (hasENOSPC) {
      getWindow()?.webContents.send('file-batch-summary', {
        context: 'importSongs',
        total: tasks.length,
        success,
        failed,
        hasENOSPC,
        skipped,
        errorSamples: []
      })
    }
  })
}

async function moveToRecycleBin(
  delList: string[],
  progressId: string,
  getWindow: () => BrowserWindow | null,
  sendProgress: SendProgress
) {
  const now = new Date()
  const pad2 = (n: number) => (n < 10 ? '0' + n : '' + n)
  const dirName = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}_${pad2(
    now.getHours()
  )}-${pad2(now.getMinutes())}`
  const recycleBinTargetDir = path.join(
    store.databaseDir,
    'library',
    getCoreFsDirName('RecycleBin'),
    dirName
  )
  fs.ensureDirSync(recycleBinTargetDir)
  const tasks: Array<() => Promise<any>> = []
  for (const srcPath of delList) {
    const dest = path.join(recycleBinTargetDir, path.basename(srcPath))
    tasks.push(() => fs.move(srcPath, dest))
  }
  const batchId = `import_recycle_duplicates_${Date.now()}`
  const { success, failed, hasENOSPC, skipped } = await runWithConcurrency(tasks, {
    concurrency: 16,
    onProgress: (done, total) =>
      sendProgress('tracks.recyclingDuplicates', done, total, false, progressId),
    stopOnENOSPC: true,
    onInterrupted: async (payload) =>
      waitForUserDecision(getWindow(), batchId, 'recycleDuplicatesOnImport', payload)
  })
  const descriptionJson = {
    uuid: uuidV4(),
    type: 'songList',
    order: Date.now()
  }
  await operateHiddenFile(path.join(recycleBinTargetDir, '.description.json'), async () => {
    if (!(await fs.pathExists(path.join(recycleBinTargetDir, '.description.json')))) {
      await fs.outputJSON(path.join(recycleBinTargetDir, '.description.json'), descriptionJson)
    }
  })
  const targetWindow = getWindow()
  if (targetWindow) {
    targetWindow.webContents.send('delSongsSuccess', {
      dirName,
      ...descriptionJson
    })
    if (hasENOSPC) {
      targetWindow.webContents.send('file-batch-summary', {
        context: 'recycleDuplicatesOnImport',
        total: tasks.length,
        success,
        failed,
        hasENOSPC,
        skipped,
        errorSamples: []
      })
    }
  }
}
