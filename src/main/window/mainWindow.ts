import { app, shell, BrowserWindow, ipcMain, globalShortcut } from 'electron'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import {
  collectFilesWithExtensions,
  moveOrCopyItemWithCheckIsExist,
  getSongsAnalyseResult,
  runWithConcurrency,
  waitForUserDecision,
  getCoreFsDirName,
  mapRendererPathToFsPath,
  getCurrentTimeYYYYMMDDHHMMSSSSS
} from '../utils'
import store from '../store'
import url from '../url'
import updateWindow from './updateWindow'
import databaseInitWindow from './databaseInitWindow'
import path = require('path')
import fs = require('fs-extra')
import FingerprintStore from '../fingerprintStore'
import { IImportSongsFormData, md5 } from '../../types/globals'
import { v4 as uuidV4 } from 'uuid'
import { operateHiddenFile } from '../utils'
import { FileSystemOperation } from '@renderer/utils/diffLibraryTree'

let mainWindow: BrowserWindow | null = null
function createWindow() {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: store.layoutConfig.mainWindowWidth, //默认应为900
    height: store.layoutConfig.mainWindowHeight, //默认应为600
    minWidth: 900,
    minHeight: 600,
    frame: process.platform === 'darwin' ? true : false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    transparent: false,
    show: false,
    backgroundColor: '#000000',

    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index'),
      sandbox: false,
      backgroundThrottling: false
    }
  })

  // macOS：强制深色标题栏/外观
  if (process.platform === 'darwin') {
    try {
      mainWindow.setVibrancy('under-window')
    } catch {}
  }

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools()
  }

  mainWindow.on('ready-to-show', () => {
    if (store.layoutConfig.isMaxMainWin) {
      mainWindow?.maximize()
    }
    mainWindow?.show()
    globalShortcut.register(store.settingConfig.globalCallShortcut, () => {
      if (!mainWindow?.isFocused()) {
        if (mainWindow?.isMinimized()) {
          mainWindow.restore()
        }
        mainWindow?.focus()
      } else {
        mainWindow.minimize()
      }
    })
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    // 检测 ctrl+w 或 command+w
    if ((input.control || input.meta) && input.key.toLowerCase() === 'w') {
      event.preventDefault()
    }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.webContents.send('mainWin-max', true)
    } else {
      mainWindow?.webContents.send('mainWin-max', false)
    }
    mainWindow?.webContents.send('layoutConfigReaded', store.layoutConfig)
  })

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('mainWin-max', true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('mainWin-max', false)
  })

  let mainWindowWidth = store.layoutConfig.mainWindowWidth
  let mainWindowHeight = store.layoutConfig.mainWindowHeight
  mainWindow.on('resized', () => {
    let size = mainWindow?.getSize()
    if (size) {
      mainWindowWidth = size[0]
      mainWindowHeight = size[1]
    }
  })

  mainWindow.on('blur', () => {
    mainWindow?.webContents.send('mainWindowBlur')
  })

  ipcMain.on('toggle-maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow?.maximize()
    }
  })

  ipcMain.on('toggle-minimize', () => {
    mainWindow?.minimize()
  })

  ipcMain.on('toggle-close', async () => {
    let layoutConfig = fs.readJSONSync(url.layoutConfigFileUrl)
    if (mainWindow?.isMaximized()) {
      layoutConfig.isMaxMainWin = true
    } else {
      layoutConfig.isMaxMainWin = false
    }
    layoutConfig.mainWindowWidth = mainWindowWidth
    layoutConfig.mainWindowHeight = mainWindowHeight
    await fs.outputJson(url.layoutConfigFileUrl, layoutConfig)
    mainWindow?.close()
  })

  ipcMain.on('readSongFile', async (e, filePath, requestId) => {
    try {
      let file = await fs.readFile(filePath)
      const uint8Buffer = Uint8Array.from(file)
      mainWindow?.webContents.send('readedSongFile', uint8Buffer, filePath, requestId)
    } catch (error) {
      console.error(`读取歌曲文件失败 ${filePath}:`, error)
      mainWindow?.webContents.send(
        'readSongFileError',
        filePath,
        (error as Error).message,
        requestId
      )
    }
  })

  // 处理预加载文件请求
  ipcMain.on('readNextSongFile', async (e, filePath, requestId) => {
    try {
      let file = await fs.readFile(filePath)
      const uint8Buffer = Uint8Array.from(file)
      // 使用不同的事件名发送回渲染进程
      mainWindow?.webContents.send('readedNextSongFile', uint8Buffer, filePath, requestId)
    } catch (error) {
      console.error(`读取预加载歌曲文件失败 ${filePath}:`, error)
      mainWindow?.webContents.send(
        'readNextSongFileError',
        filePath,
        (error as Error).message,
        requestId
      )
    }
  })

  const sendProgress = (message: string, current: number, total: number, isInitial = false) => {
    mainWindow?.webContents.send('progressSet', message, current, total, isInitial)
  }
  ipcMain.on('addSongFingerprint', async (e, folderPath: string[]) => {
    const fingerprintStartAt = Date.now()
    // 扫描文件
    sendProgress('fingerprints.scanningFiles', 0, 1, true)
    const songFileUrls = (
      await Promise.all(
        folderPath.map((item) => collectFilesWithExtensions(item, store.settingConfig.audioExt))
      )
    ).flat()
    sendProgress('fingerprints.scanningFiles', 1, 1)
    if (songFileUrls.length === 0) {
      mainWindow?.webContents.send('noAudioFileWasScanned')
      return
    }
    // 分析声音指纹

    sendProgress('fingerprints.analyzeInit', 0, songFileUrls.length)
    const { songsAnalyseResult, errorSongsAnalyseResult } = await getSongsAnalyseResult(
      songFileUrls,
      (resultLength: number) => {
        sendProgress('fingerprints.analyzingFingerprints', resultLength, songFileUrls.length)
      }
    )

    // 开发日志已移除，dev 与 prod 行为一致

    // 去重处理
    const uniqueFingerprints = new Set(songsAnalyseResult.map((item) => item.sha256_Hash))
    const removeDuplicatesFingerprintResults = Array.from(uniqueFingerprints)
    let beforeSongFingerprintListLength = store.songFingerprintList.length
    store.songFingerprintList = Array.from(
      new Set([...store.songFingerprintList, ...removeDuplicatesFingerprintResults])
    )

    // 保存结果（多版本+指针，原子切换）
    await FingerprintStore.saveList(
      store.songFingerprintList,
      ((store as any).settingConfig?.fingerprintMode as 'pcm' | 'file') || 'pcm'
    )

    const fingerprintEndAt = Date.now()

    // 计算去重数量（扫描到的 - 新增的 - 分析失败的 = 去重跳过的）
    const duplicatesRemovedCount =
      songFileUrls.length -
      (store.songFingerprintList.length - beforeSongFingerprintListLength) -
      errorSongsAnalyseResult.length

    // 构建指纹摘要对象
    const fingerprintSummary = {
      startAt: new Date(fingerprintStartAt).toISOString(),
      endAt: new Date(fingerprintEndAt).toISOString(),
      durationMs: fingerprintEndAt - fingerprintStartAt,
      scannedCount: songFileUrls.length,
      analyzeFailedCount: errorSongsAnalyseResult.length,
      duplicatesRemovedCount: duplicatesRemovedCount,
      fingerprintAddedCount: store.songFingerprintList.length - beforeSongFingerprintListLength,
      fingerprintTotalBefore: beforeSongFingerprintListLength,
      fingerprintTotalAfter: store.songFingerprintList.length,
      fingerprintMode: ((store as any).settingConfig?.fingerprintMode as 'pcm' | 'file') || 'pcm'
    }

    mainWindow?.webContents.send('addSongFingerprintFinished', fingerprintSummary)
  })

  ipcMain.on('startImportSongs', async (e, formData: IImportSongsFormData) => {
    const importStartAt = Date.now()
    sendProgress('fingerprints.scanningFiles', 0, 1, true)
    let filePaths = formData.selectedPaths || formData.filePaths || formData.folderPath
    if (filePaths === undefined) {
      filePaths = []
    }
    let songFileUrls: string[] = []

    // 处理混合的文件和文件夹路径
    for (const filePath of filePaths) {
      const stats = await fs.stat(filePath)
      if (stats.isFile()) {
        // 单个文件
        const ext = path.extname(filePath).toLowerCase()
        if (store.settingConfig.audioExt.includes(ext)) {
          songFileUrls.push(filePath)
        }
      } else if (stats.isDirectory()) {
        // 文件夹
        const files = await collectFilesWithExtensions(filePath, store.settingConfig.audioExt)
        songFileUrls = songFileUrls.concat(files)
      }
    }
    sendProgress('fingerprints.scanningFiles', 1, 1, true)
    if (songFileUrls.length === 0) {
      mainWindow?.webContents.send('noAudioFileWasScanned')
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
    let songFingerprintListLengthBefore = store.songFingerprintList.length
    let toBeDealSongs = []
    let delList: string[] = []

    let songsAnalyseResult: md5[] = []
    let errorSongsAnalyseResult: md5[] = []
    let alreadyExistInSongFingerprintList = new Set()
    if (needAnalyze) {
      sendProgress('fingerprints.analyzeInit', 0, songFileUrls.length)

      let analyseResult = await getSongsAnalyseResult(songFileUrls, (resultLength: number) =>
        sendProgress('fingerprints.analyzingFingerprints', resultLength, songFileUrls.length)
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
        let duplicates: string[] = []
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
          // 将重复文件移动到软件内回收站，而不是直接删除
          // 目录名按分钟聚合：YYYY-MM-DD_HH-MM（与渲染层一致）
          const now = new Date()
          const pad2 = (n: number) => (n < 10 ? '0' + n : '' + n)
          const dirName = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(
            now.getDate()
          )}_${pad2(now.getHours())}-${pad2(now.getMinutes())}`
          const recycleBinTargetDir = path.join(
            store.databaseDir,
            'library',
            getCoreFsDirName('RecycleBin'),
            dirName
          )
          fs.ensureDirSync(recycleBinTargetDir)

          const tasks: Array<() => Promise<any>> = []
          for (let srcPath of delList) {
            const dest = path.join(recycleBinTargetDir, path.basename(srcPath))
            tasks.push(() => fs.move(srcPath, dest))
          }

          const batchId = `import_recycle_duplicates_${Date.now()}`
          const { success, failed, hasENOSPC, skipped } = await runWithConcurrency(tasks, {
            concurrency: 16,
            onProgress: (done, total) => sendProgress('tracks.recyclingDuplicates', done, total),
            stopOnENOSPC: true,
            onInterrupted: async (payload) =>
              waitForUserDecision(mainWindow, batchId, 'recycleDuplicatesOnImport', payload)
          })

          // 写入回收站目录描述文件，供 UI 展示
          const descriptionJson = {
            uuid: uuidV4(),
            type: 'songList',
            order: Date.now()
          }
          await operateHiddenFile(path.join(recycleBinTargetDir, '.description.json'), async () => {
            // 若已存在则不重复写入，避免同一分钟多次覆盖 uuid
            if (!(await fs.pathExists(path.join(recycleBinTargetDir, '.description.json')))) {
              await fs.outputJSON(
                path.join(recycleBinTargetDir, '.description.json'),
                descriptionJson
              )
            }
          })

          if (mainWindow) {
            mainWindow.webContents.send('delSongsSuccess', {
              dirName,
              ...descriptionJson
            })
            if (hasENOSPC) {
              mainWindow.webContents.send('file-batch-summary', {
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
          // 将重复文件移动到软件内回收站，而不是直接删除
          const now = new Date()
          const pad2 = (n: number) => (n < 10 ? '0' + n : '' + n)
          const dirName = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(
            now.getDate()
          )}_${pad2(now.getHours())}-${pad2(now.getMinutes())}`
          const recycleBinTargetDir = path.join(
            store.databaseDir,
            'library',
            getCoreFsDirName('RecycleBin'),
            dirName
          )
          fs.ensureDirSync(recycleBinTargetDir)

          const tasks: Array<() => Promise<any>> = []
          for (let srcPath of delList) {
            const dest = path.join(recycleBinTargetDir, path.basename(srcPath))
            tasks.push(() => fs.move(srcPath, dest))
          }

          const batchId = `import_recycle_duplicates_${Date.now()}`
          const { success, failed, hasENOSPC, skipped } = await runWithConcurrency(tasks, {
            concurrency: 16,
            onProgress: (done, total) => sendProgress('tracks.recyclingDuplicates', done, total),
            stopOnENOSPC: true,
            onInterrupted: async (payload) =>
              waitForUserDecision(mainWindow, batchId, 'recycleDuplicatesOnImport', payload)
          })

          const descriptionJson = {
            uuid: uuidV4(),
            type: 'songList',
            order: Date.now()
          }
          await operateHiddenFile(path.join(recycleBinTargetDir, '.description.json'), async () => {
            if (!(await fs.pathExists(path.join(recycleBinTargetDir, '.description.json')))) {
              await fs.outputJSON(
                path.join(recycleBinTargetDir, '.description.json'),
                descriptionJson
              )
            }
          })

          if (mainWindow) {
            mainWindow.webContents.send('delSongsSuccess', {
              dirName,
              ...descriptionJson
            })
            if (hasENOSPC) {
              mainWindow.webContents.send('file-batch-summary', {
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
      const matchResult = item.file_path
        ? item.file_path.match(/[^\\/]+$/)
        : typeof item === 'string'
          ? item.match(/[^\\/]+$/)
          : null
      const filename = matchResult ? matchResult[0] : 'unknown_file'
      const targetPath = path.join(store.databaseDir, formData.songListPath, filename)
      const srcPath = item.file_path ? item.file_path : (item as unknown as string)
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
          total
        ),
      stopOnENOSPC: true,
      onInterrupted: async (payload) =>
        waitForUserDecision(mainWindow, batchId, 'importSongs', payload)
    })

    // 强制结束时将进度条推满，避免 UI 悬挂
    sendProgress(
      isDeleteSourceFile ? 'tracks.movingTracks' : 'tracks.copyingTracks',
      tasks.length,
      tasks.length
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

    // 构建导入结果摘要对象
    const importSummary = {
      startAt: new Date(importStartAt).toISOString(),
      endAt: new Date(importEndAt).toISOString(),
      durationMs: importEndAt - importStartAt,
      scannedCount: songFileUrls.length,
      analyzeFailedCount: errorSongsAnalyseResult.length,
      importedToPlaylistCount: success,
      duplicatesRemovedCount: dedupMode !== 'none' ? delList.length : 0,
      fingerprintAddedCount: isPushSongFingerprintLibrary ? fingerprintsToAdd.length : 0,
      fingerprintAlreadyExistingCount: isPushSongFingerprintLibrary
        ? alreadyExistInSongFingerprintList.size
        : 0,
      fingerprintTotalBefore: songFingerprintListLengthBefore,
      fingerprintTotalAfter: store.songFingerprintList.length,
      isComparisonSongFingerprint: dedupMode !== 'none',
      isPushSongFingerprintLibrary,
      fingerprintMode: ((store as any).settingConfig?.fingerprintMode as 'pcm' | 'file') || 'pcm'
    }

    mainWindow?.webContents.send('importFinished', formData.songListUUID, importSummary)
    if (hasENOSPC) {
      mainWindow?.webContents.send('file-batch-summary', {
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
  ipcMain.handle('changeGlobalShortcut', (e, shortCutValue) => {
    let ret = globalShortcut.register(shortCutValue, () => {
      if (!mainWindow?.isFocused()) {
        if (mainWindow?.isMinimized()) {
          mainWindow.restore()
        }
        mainWindow?.focus()
      } else {
        mainWindow.minimize()
      }
    })
    if (!ret) {
      return false
    }
    globalShortcut.unregister(store.settingConfig.globalCallShortcut)
    store.settingConfig.globalCallShortcut = shortCutValue
    fs.outputJson(url.settingConfigFileUrl, store.settingConfig)
    return true
  })

  ipcMain.on('checkForUpdates', () => {
    if (updateWindow.instance === null) {
      updateWindow.createWindow()
    } else {
      if (updateWindow.instance.isMinimized()) {
        updateWindow.instance.restore()
      }
      updateWindow.instance.focus()
    }
  })

  ipcMain.on('openFileExplorer', (e, targetPath) => {
    shell.openPath(path.join(store.databaseDir, targetPath))
  })

  ipcMain.handle('reSelectLibrary', async (e) => {
    databaseInitWindow.createWindow()
    let layoutConfig = fs.readJSONSync(url.layoutConfigFileUrl)
    if (mainWindow?.isMaximized()) {
      layoutConfig.isMaxMainWin = true
    } else {
      layoutConfig.isMaxMainWin = false
    }
    layoutConfig.mainWindowWidth = mainWindowWidth
    layoutConfig.mainWindowHeight = mainWindowHeight
    await fs.outputJson(url.layoutConfigFileUrl, layoutConfig)
    mainWindow?.close()
  })

  ipcMain.handle('emptyDir', async (e, targetPath: string, dirName: string) => {
    const recycleBinTargetDir = path.join(
      store.databaseDir,
      'library',
      getCoreFsDirName('RecycleBin'),
      dirName
    )

    let songFileUrls = await collectFilesWithExtensions(
      path.join(store.databaseDir, mapRendererPathToFsPath(targetPath)),
      store.settingConfig.audioExt
    )

    if (songFileUrls.length > 0) {
      const tasks: Array<() => Promise<any>> = songFileUrls.map((srcPath) => {
        const destPath = path.join(recycleBinTargetDir, path.basename(srcPath))
        return () => fs.move(srcPath, destPath)
      })

      const batchId = `emptyDir_${Date.now()}`
      const { success, failed, hasENOSPC, skipped } = await runWithConcurrency(tasks, {
        concurrency: 16,
        stopOnENOSPC: true,
        onInterrupted: async (payload) =>
          waitForUserDecision(mainWindow, batchId, 'emptyDir', payload)
      })

      let descriptionJson = {
        uuid: uuidV4(),
        type: 'songList',
        order: Date.now()
      }

      await operateHiddenFile(path.join(recycleBinTargetDir, '.description.json'), async () => {
        fs.outputJSON(path.join(recycleBinTargetDir, '.description.json'), descriptionJson)
      })

      if (mainWindow) {
        mainWindow.webContents.send('delSongsSuccess', {
          dirName,
          ...descriptionJson
        })
        if (hasENOSPC) {
          mainWindow.webContents.send('file-batch-summary', {
            context: 'emptyDir',
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
  })

  ipcMain.handle('emptyRecycleBin', async (_e) => {
    let recycleBinPath = path.join(store.databaseDir, 'library', getCoreFsDirName('RecycleBin'))
    try {
      const recycleBinDirs = await fs.readdir(recycleBinPath)

      const deletePromises = recycleBinDirs.map(async (dir) => {
        const dirPath = path.join(recycleBinPath, dir)
        const stat = await fs.stat(dirPath)

        if (stat.isDirectory()) {
          return fs.remove(dirPath)
        }
      })
      await Promise.all(deletePromises)
    } catch (error) {
      console.error('清空回收站失败:', error)
    }
  })

  // 辅助函数：检查目录是否有效为空（递归检查是否包含音频文件）
  async function isDirectoryEffectivelyEmpty(
    dirPath: string,
    audioExtensions: string[]
  ): Promise<boolean> {
    try {
      // 首先检查路径是否存在
      if (!(await fs.pathExists(dirPath))) {
        return true // 不存在的目录视为空
      }
      const items = await fs.readdir(dirPath, { withFileTypes: true })
      for (const item of items) {
        const fullPath = path.join(dirPath, item.name)
        if (item.isFile()) {
          // 检查是否为音频文件
          const lowerExt = path.extname(item.name).toLowerCase()
          if (audioExtensions.includes(lowerExt)) {
            return false // 发现音频文件，非空
          }
          // 忽略 .description.json 和其他非音频文件
        } else if (item.isDirectory()) {
          // 递归检查子目录
          if (!(await isDirectoryEffectivelyEmpty(fullPath, audioExtensions))) {
            return false // 在子目录中发现音频文件
          }
        }
      }
      return true // 未发现音频文件
    } catch (error) {
      console.error(`Error checking directory emptiness for ${dirPath}:`, error)
      // 如果发生错误（例如权限问题），保守地认为它非空
      // 但如果是 ENOENT（文件不存在），则视为空
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return true
      }
      return false
    }
  }

  ipcMain.handle('operateFileSystemChange', async (e, operateArray: FileSystemOperation[]) => {
    const results = []
    try {
      for (let item of operateArray) {
        let operationStatus = 'processed' // Default status
        let recycleBinInfo = null

        if (item.type === 'create') {
          const createPath = path.join(store.databaseDir, item.path)
          await operateHiddenFile(path.join(createPath, '.description.json'), async () => {
            await fs.ensureDir(path.dirname(createPath))
            await fs.ensureDir(createPath)
            await fs.outputJSON(path.join(createPath, '.description.json'), {
              uuid: item.uuid,
              type: item.nodeType,
              order: item.order
            })
          })
          operationStatus = 'created'
        } else if (item.type === 'reorder') {
          await operateHiddenFile(
            path.join(store.databaseDir, item.path, '.description.json'),
            async () => {
              let existingData = {}
              try {
                existingData = await fs.readJson(
                  path.join(store.databaseDir, item.path, '.description.json')
                )
              } catch (readError) {
                console.warn(
                  `Could not read existing description for reorder: ${item.path}`,
                  readError
                )
              }
              await fs.outputJSON(path.join(store.databaseDir, item.path, '.description.json'), {
                ...existingData,
                uuid: item.uuid,
                type: item.nodeType,
                order: item.order
              })
            }
          )
          operationStatus = 'reordered'
        } else if (item.type === 'rename') {
          const oldFullPath = path.join(store.databaseDir, item.path)
          const newFullPath = path.join(
            store.databaseDir,
            item.path.slice(0, item.path.lastIndexOf('/') + 1) + item.newName
          )
          if (await fs.pathExists(oldFullPath)) {
            await fs.rename(oldFullPath, newFullPath)
            operationStatus = 'renamed'
          } else {
            console.warn(`Rename source path not found: ${oldFullPath}`)
            operationStatus = 'rename_failed_source_not_found'
          }
        } else if (item.type === 'delete' && item.recycleBinDir) {
          let dirPath = path.join(store.databaseDir, item.path)
          const recycleBinTargetDir = path.join(
            store.databaseDir,
            'library',
            getCoreFsDirName('RecycleBin'),
            item.recycleBinDir.dirName
          )

          // 检查目录是否有效为空
          const isEmpty = await isDirectoryEffectivelyEmpty(dirPath, store.settingConfig.audioExt)

          if (isEmpty) {
            // 目录为空，直接永久删除
            await fs.remove(dirPath)
            operationStatus = 'removed'
          } else {
            // 目录非空，移动到回收站
            try {
              // 确保回收站目标目录存在
              await fs.ensureDir(recycleBinTargetDir)
              // 读取源目录所有内容
              const itemsToMove = await fs.readdir(dirPath)
              const tasks: Array<() => Promise<any>> = []
              for (const dirItem of itemsToMove) {
                // 不移动根目录下的 .description.json 文件本身
                if (dirItem !== '.description.json') {
                  const srcPath = path.join(dirPath, dirItem)
                  const destPath = path.join(recycleBinTargetDir, dirItem)
                  // 移动文件或文件夹，允许覆盖
                  tasks.push(() => fs.move(srcPath, destPath, { overwrite: true }))
                }
              }
              // 等待所有移动操作完成
              const batchId = `recycleMove_${Date.now()}`
              const { success, failed, hasENOSPC, skipped } = await runWithConcurrency(tasks, {
                concurrency: 16,
                stopOnENOSPC: true,
                onInterrupted: async (payload) =>
                  waitForUserDecision(mainWindow, batchId, 'recycleMove', payload)
              })
              // 移动完成后删除空的源目录（此时应该只剩 .description.json 或完全为空）
              if (failed === 0) {
                await fs.remove(dirPath)
              }

              // 创建回收站描述文件 (.description.json)
              let descriptionJson = {
                uuid: item.recycleBinDir.uuid,
                type: item.recycleBinDir.type, // 应为 'songList'
                order: item.recycleBinDir.order
              }
              await operateHiddenFile(
                path.join(recycleBinTargetDir, '.description.json'),
                async () => {
                  await fs.outputJSON(
                    path.join(recycleBinTargetDir, '.description.json'),
                    descriptionJson
                  )
                }
              )
              operationStatus = 'recycled'
              recycleBinInfo = item.recycleBinDir // 存储回收站信息以返回
              if (hasENOSPC && mainWindow) {
                mainWindow.webContents.send('file-batch-summary', {
                  context: 'recycleMove',
                  total: tasks.length,
                  success,
                  failed,
                  hasENOSPC,
                  skipped,
                  errorSamples: []
                })
              }
            } catch (moveError) {
              console.error(`Error moving ${item.path} to recycle bin:`, moveError)
              // 尝试清理：如果移动失败，仍然尝试删除原始目录
              await fs.remove(dirPath).catch((cleanupError) => {
                console.error(
                  `Failed to cleanup original directory ${dirPath} after move error:`,
                  cleanupError
                )
              })
              operationStatus = 'recycle_failed'
            }
          }
        } else if (item.type === 'permanentlyDelete') {
          await fs.remove(path.join(store.databaseDir, item.path))
          operationStatus = 'permanently_deleted'
        } else if (item.type === 'move') {
          const srcFullPath = path.join(store.databaseDir, item.path)
          const destFullPath = path.join(store.databaseDir, item.newPath as string)

          if (await fs.pathExists(srcFullPath)) {
            await fs.ensureDir(path.dirname(destFullPath))
            await fs.move(srcFullPath, destFullPath, { overwrite: true })
            await operateHiddenFile(path.join(destFullPath, '.description.json'), async () => {
              let existingData = {}
              try {
                existingData = await fs.readJson(path.join(destFullPath, '.description.json'))
              } catch (readError) {
                console.warn(
                  `Could not read existing description for move dest: ${destFullPath}`,
                  readError
                )
              }
              await fs.outputJSON(path.join(destFullPath, '.description.json'), {
                ...existingData,
                uuid: item.uuid,
                type: item.nodeType,
                order: item.order
              })
            })
            operationStatus = 'moved'
          } else {
            console.warn(`Move source path not found: ${srcFullPath}`)
            operationStatus = 'move_failed_source_not_found'
          }
        }

        results.push({ uuid: item.uuid, status: operationStatus, recycleBinDir: recycleBinInfo })
      }
      return { success: true, details: results }
    } catch (error) {
      console.error('operateFileSystemChange error:', error)
      return { success: false, error: (error as Error).message, details: results }
    }
  })

  ipcMain.on('show-item-in-folder', (e, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  mainWindow.on('closed', () => {
    // 使用 ipcMain.on 注册的事件
    ipcMain.removeAllListeners('toggle-maximize')
    ipcMain.removeAllListeners('toggle-minimize')
    ipcMain.removeAllListeners('toggle-close')
    ipcMain.removeAllListeners('readSongFile')
    ipcMain.removeAllListeners('readNextSongFile') // 清理新的 listener
    ipcMain.removeAllListeners('addSongFingerprint')
    ipcMain.removeAllListeners('startImportSongs')
    ipcMain.removeAllListeners('checkForUpdates')
    ipcMain.removeAllListeners('openFileExplorer')
    ipcMain.removeAllListeners('show-item-in-folder')

    // 使用 ipcMain.handle 注册的事件
    ipcMain.removeHandler('changeGlobalShortcut')
    ipcMain.removeHandler('reSelectLibrary')
    ipcMain.removeHandler('emptyDir')
    ipcMain.removeHandler('emptyRecycleBin')
    ipcMain.removeHandler('operateFileSystemChange')

    globalShortcut.unregister(store.settingConfig.globalCallShortcut)
    mainWindow = null
  })
}

export default {
  get instance() {
    return mainWindow
  },
  createWindow
}
