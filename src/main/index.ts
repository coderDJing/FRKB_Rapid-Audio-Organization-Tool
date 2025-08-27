import { app, BrowserWindow, ipcMain, dialog, shell, IpcMainInvokeEvent } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import {
  getLibrary,
  collectFilesWithExtensions,
  getCurrentTimeYYYYMMDDHHMMSSSSS,
  moveOrCopyItemWithCheckIsExist,
  operateHiddenFile,
  runWithConcurrency,
  waitForUserDecision,
  getCoreFsDirName,
  mapRendererPathToFsPath
} from './utils'
import { log } from './log'
import './cloudSync'
import errorReport from './errorReport'
import url from './url'
import { initDatabaseStructure } from './initDatabase'
import {
  healAndPrepare,
  loadList,
  saveList,
  exportSnapshot,
  importFromJsonFile
} from './fingerprintStore'
import mainWindow from './window/mainWindow'
import databaseInitWindow from './window/databaseInitWindow'
import { is } from '@electron-toolkit/utils'
import store from './store'
import foundNewVersionWindow from './window/foundNewVersionWindow'
import updateWindow from './window/updateWindow'
import electronUpdater = require('electron-updater')
import {
  readManifestFile,
  getManifestPath,
  MANIFEST_FILE_NAME,
  looksLikeLegacyStructure
} from './databaseManifest'
import { execFile } from 'child_process'
import { ISongInfo } from '../types/globals'
import { v4 as uuidV4 } from 'uuid'
// import AudioFeatureExtractor from './mfccTest'

const initDevDatabase = false
const dev_DB = 'C:\\Users\\renlu\\Desktop\\FRKB_database'
const my_real_DB = 'D:\\FRKB_database'
// 需要切换时，将下一行改为 my_real_DB
let devDatabase = dev_DB

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, _commandLine, _workingDirectory) => {
    if (databaseInitWindow.instance) {
      if (databaseInitWindow.instance.isMinimized()) {
        databaseInitWindow.instance.restore()
      }
      databaseInitWindow.instance.focus()
    } else if (mainWindow.instance) {
      if (mainWindow.instance.isMinimized()) {
        mainWindow.instance.restore()
      }
      mainWindow.instance.focus()
    }
  })
}

import path = require('path')
import fs = require('fs-extra')
const platform = process.platform
if (!fs.pathExistsSync(url.layoutConfigFileUrl)) {
  fs.outputJsonSync(url.layoutConfigFileUrl, {
    libraryAreaWidth: 175,
    isMaxMainWin: false,
    mainWindowWidth: 900,
    mainWindowHeight: 600
  })
  fs.outputJsonSync(url.settingConfigFileUrl, {
    platform: platform,
    language: is.dev ? 'zhCN' : '',
    audioExt: ['.mp3', '.wav', '.flac'],
    databaseUrl: '',
    globalCallShortcut:
      platform === 'win32' ? 'Ctrl+Alt+F' : platform === 'darwin' ? 'Command+Option+F' : '',
    hiddenPlayControlArea: false,
    autoPlayNextSong: false,
    startPlayPercent: 0,
    endPlayPercent: 100,
    fastForwardTime: 10,
    fastBackwardTime: -5,
    autoScrollToCurrentSong: true,
    enablePlaybackRange: false,
    recentDialogSelectedSongListMaxCount: 10
  })
}

// 定义默认设置结构
const defaultSettings = {
  platform: (platform === 'darwin' ? 'darwin' : 'win32') as 'darwin' | 'win32',
  language: (is.dev ? 'zhCN' : '') as '' | 'enUS' | 'zhCN',
  audioExt: ['.mp3', '.wav', '.flac'],
  databaseUrl: '',
  globalCallShortcut:
    platform === 'win32' ? 'Ctrl+Alt+F' : platform === 'darwin' ? 'Command+Option+F' : '',
  hiddenPlayControlArea: false,
  autoPlayNextSong: false,
  startPlayPercent: 0,
  endPlayPercent: 100,
  fastForwardTime: 10,
  fastBackwardTime: -5,
  autoScrollToCurrentSong: true,
  enablePlaybackRange: false,
  recentDialogSelectedSongListMaxCount: 10,
  nextCheckUpdateTime: '',
  // 错误日志上报默认配置
  enableErrorReport: true,
  errorReportUsageMsSinceLastSuccess: 0,
  errorReportRetryMsSinceLastFailure: -1
}

store.layoutConfig = fs.readJSONSync(url.layoutConfigFileUrl)

// 加载并合并设置
let loadedSettings = {}
if (fs.pathExistsSync(url.settingConfigFileUrl)) {
  try {
    loadedSettings = fs.readJSONSync(url.settingConfigFileUrl)
  } catch (error) {
    log.error('读取设置文件错误，将使用默认设置:', error)
    // 处理潜在的 JSON 解析错误，回退到默认值
    loadedSettings = {} // 或者你可以选择保留 defaultSettings
  }
} else {
  // 如果文件不存在（虽然前面的逻辑会创建它，但为了健壮性加上）
  fs.outputJsonSync(url.settingConfigFileUrl, defaultSettings) // 确保写入
  loadedSettings = defaultSettings // 使用默认设置继续
}

// 合并默认设置与加载的设置，确保所有键都存在
// 加载的设置会覆盖默认值（如果存在）
const finalSettings = { ...defaultSettings, ...loadedSettings }

// 更新 store
store.settingConfig = finalSettings

// 将可能更新的设置持久化回文件
// 确保即使文件最初不存在，或者读取出错时，最终也会写入一个有效的配置文件
fs.outputJsonSync(url.settingConfigFileUrl, finalSettings)

// 初始化错误日志上报调度
try {
  errorReport.setup()
} catch (e) {
  log.error('初始化错误日志上报失败', e)
}

let devInitDatabaseFunction = async () => {
  if (!fs.pathExistsSync(store.settingConfig.databaseUrl)) {
    return
  }
  // 在 dev 环境下每次启动时重新初始化数据库
  if (fs.pathExistsSync(store.settingConfig.databaseUrl)) {
    fs.removeSync(store.settingConfig.databaseUrl)
  }
  await initDatabaseStructure(store.settingConfig.databaseUrl)
  // 指纹列表使用新方案初始化为空版本
  store.databaseDir = store.settingConfig.databaseUrl
  store.songFingerprintList = []
  await saveList([])
  console.log('devInitDatabase (new scheme)')
}
if (is.dev && platform === 'win32') {
  // store.settingConfig.databaseUrl = devDatabase
  // if (initDevDatabase) {
  //   if (devDatabase !== my_real_DB) {
  //     // 做一个保险，防止误操作把我真实数据库删了
  //     void devInitDatabaseFunction()
  //   }
  // }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('frkb.coderDjing')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  if (!store.settingConfig.databaseUrl) {
    databaseInitWindow.createWindow()
  } else {
    // 若数据库根路径不存在，则视为“数据库不存在”，直接进入初始化界面并提示
    try {
      const exists = fs.pathExistsSync(store.settingConfig.databaseUrl)
      if (!exists) {
        databaseInitWindow.createWindow({ needErrorHint: true })
        return
      }
    } catch (_e) {
      databaseInitWindow.createWindow({ needErrorHint: true })
      return
    }
    try {
      // 统一复用初始化（幂等）：创建/修复库结构
      await initDatabaseStructure(store.settingConfig.databaseUrl, { createSamples: false })
      // 指纹：前置修复并加载（多版本+指针）
      await healAndPrepare()
      const list = await loadList()
      store.databaseDir = store.settingConfig.databaseUrl
      store.songFingerprintList = Array.isArray(list) ? list : []
      mainWindow.createWindow()
    } catch (_e) {
      databaseInitWindow.createWindow({ needErrorHint: true })
    }
  }

  const autoUpdater = electronUpdater.autoUpdater
  autoUpdater.autoDownload = false
  if (store.settingConfig.nextCheckUpdateTime) {
    if (new Date() > new Date(store.settingConfig.nextCheckUpdateTime)) {
      autoUpdater.checkForUpdates()
    }
  } else {
    autoUpdater.checkForUpdates()
  }
  autoUpdater.on('update-available', (info) => {
    if (updateWindow.instance === null) {
      foundNewVersionWindow.createWindow()
    }
  })

  app.on('activate', async function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      if (!store.settingConfig.databaseUrl) {
        databaseInitWindow.createWindow()
      } else {
        // 若数据库根路径不存在，则进入初始化界面并提示
        try {
          const exists = fs.pathExistsSync(store.settingConfig.databaseUrl)
          if (!exists) {
            databaseInitWindow.createWindow({ needErrorHint: true })
            return
          }
        } catch (_e) {
          databaseInitWindow.createWindow({ needErrorHint: true })
          return
        }
        try {
          await initDatabaseStructure(store.settingConfig.databaseUrl, { createSamples: false })
          await healAndPrepare()
          const list = await loadList()
          store.databaseDir = store.settingConfig.databaseUrl
          store.songFingerprintList = Array.isArray(list) ? list : []
          mainWindow.createWindow()
        } catch (_e) {
          databaseInitWindow.createWindow({ needErrorHint: true })
        }
      }
    }
  })
})

app.on('window-all-closed', async () => {
  ipcMain.removeAllListeners()
  app.quit()
})

// 语言字典将不再通过主进程下发，渲染进程使用 vue-i18n 自行管理
ipcMain.handle('getSetting', () => {
  return store.settingConfig
})
ipcMain.handle('setSetting', (e, setting) => {
  store.settingConfig = setting
  fs.outputJson(url.settingConfigFileUrl, setting)
})
ipcMain.on('outputLog', (e, logMsg) => {
  log.error(logMsg)
})

ipcMain.on('openLocalBrowser', (e, url) => {
  shell.openExternal(url)
})

ipcMain.handle('clearTracksFingerprintLibrary', async (_e) => {
  try {
    if (!store.databaseDir) {
      return { success: false, message: '尚未配置数据库位置' }
    }
    store.songFingerprintList = []
    await saveList(store.songFingerprintList)
    return { success: true }
  } catch (error: any) {
    log.error('clearTracksFingerprintLibrary failed', error)
    return { success: false, message: String(error?.message || error) }
  }
})

ipcMain.handle('getSongFingerprintListLength', () => {
  return store.songFingerprintList.length
})

ipcMain.on('delSongs', async (e, songFilePaths: string[], dirName: string) => {
  let recycleBinTargetDir = path.join(
    store.databaseDir,
    'library',
    getCoreFsDirName('RecycleBin'),
    dirName
  )
  fs.ensureDirSync(recycleBinTargetDir)
  const tasks: Array<() => Promise<any>> = []
  for (let item of songFilePaths) {
    const dest = path.join(recycleBinTargetDir, path.basename(item))
    tasks.push(() => fs.move(item, dest))
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
  let descriptionJson = {
    uuid: uuidV4(),
    type: 'songList',
    order: Date.now()
  }
  await operateHiddenFile(path.join(recycleBinTargetDir, '.description.json'), async () => {
    fs.outputJSON(path.join(recycleBinTargetDir, '.description.json'), descriptionJson)
  })
  if (mainWindow.instance) {
    mainWindow.instance.webContents.send('delSongsSuccess', {
      dirName,
      ...descriptionJson
    })
  }
})
ipcMain.handle('permanentlyDelSongs', async (e, songFilePaths: string[]) => {
  const promises = []
  for (let item of songFilePaths) {
    promises.push(fs.remove(item))
  }
  await Promise.all(promises)
})

ipcMain.handle('dirPathExists', async (e, targetPath: string) => {
  try {
    const filePath = path.join(
      store.databaseDir,
      mapRendererPathToFsPath(targetPath),
      '.description.json'
    )
    const descriptionJson = await fs.readJSON(filePath)
    const validTypes = ['root', 'library', 'dir', 'songList']
    return !!(
      descriptionJson.uuid &&
      descriptionJson.type &&
      validTypes.includes(descriptionJson.type)
    )
  } catch {
    return false
  }
})

ipcMain.handle('scanSongList', async (e, songListPath: string, songListUUID: string) => {
  let scanPath = path.join(store.databaseDir, mapRendererPathToFsPath(songListPath))
  const mm = await import('music-metadata')
  let songInfoArr: ISongInfo[] = []
  let songFileUrls = await collectFilesWithExtensions(scanPath, store.settingConfig.audioExt)

  function convertSecondsToMinutesSeconds(seconds: number) {
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = seconds % 60

    // 使用 padStart 方法确保分钟和秒数都是两位数
    const minutesStr = minutes.toString().padStart(2, '0')
    const secondsStr = remainingSeconds.toString().padStart(2, '0')

    // 返回格式为 "MM:SS" 的字符串
    return `${minutesStr}:${secondsStr}`
  }
  for (let url of songFileUrls) {
    let metadata = await mm.parseFile(url)
    let cover = mm.selectCover(metadata.common.picture)
    // 如果title为空或空字符串，使用文件名（包含扩展名）作为标题
    const title =
      metadata.common?.title && metadata.common.title.trim() !== ''
        ? metadata.common.title
        : path.basename(url)

    songInfoArr.push({
      filePath: url,
      cover: cover,
      title: title,
      artist: metadata.common?.artist,
      album: metadata.common?.album,
      duration: convertSecondsToMinutesSeconds(
        metadata.format.duration === undefined ? 0 : Math.round(metadata.format.duration)
      ), //时长
      genre: metadata.common?.genre?.[0],
      label: metadata.common?.label?.[0],
      bitrate: metadata.format?.bitrate, //比特率
      container: metadata.format?.container //编码格式
    })
  }
  return { scanData: songInfoArr, songListUUID }
})

ipcMain.handle('getLibrary', async () => {
  const library = await getLibrary()
  return library
})

ipcMain.handle('select-folder', async (event, multiSelections: boolean = true) => {
  const result = await dialog.showOpenDialog({
    properties: multiSelections ? ['openDirectory', 'multiSelections'] : ['openDirectory']
  })
  if (result.canceled) {
    return null
  }
  return result.filePaths
})

ipcMain.handle('select-existing-database-file', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'FRKB.database', extensions: ['frkbdb'] }]
  })
  if (result.canceled) return null
  const filePath = result.filePaths[0]
  try {
    if (path.basename(filePath) !== MANIFEST_FILE_NAME) {
      return 'error'
    }
    await readManifestFile(filePath)
    return { filePath, rootDir: path.dirname(filePath), fileName: MANIFEST_FILE_NAME }
  } catch (_e) {
    return 'error'
  }
})

ipcMain.handle('check-database-manifest-exists', async (_e, dirPath: string) => {
  try {
    const target = path.join(dirPath, MANIFEST_FILE_NAME)
    return await fs.pathExists(target)
  } catch (_e) {
    return false
  }
})

ipcMain.handle('probe-database-dir', async (_e, dirPath: string) => {
  try {
    const manifestPath = path.join(dirPath, MANIFEST_FILE_NAME)
    const hasManifest = await fs.pathExists(manifestPath)
    let isEmpty = false
    const exists = await fs.pathExists(dirPath)
    if (!exists) {
      return { hasManifest: false, isLegacy: false, isEmpty: true }
    }
    try {
      const items = await fs.readdir(dirPath)
      isEmpty = items.length === 0
    } catch {}
    const isLegacy = hasManifest ? false : await looksLikeLegacyStructure(dirPath)
    return { hasManifest, isLegacy, isEmpty }
  } catch (_e) {
    return { hasManifest: false, isLegacy: false, isEmpty: false }
  }
})

ipcMain.handle('find-db-root-upwards', async (_e, startDir: string) => {
  try {
    let current = startDir
    // 保护：最多向上 30 层，避免死循环
    for (let i = 0; i < 30; i++) {
      const manifestPath = path.join(current, MANIFEST_FILE_NAME)
      if (await fs.pathExists(manifestPath)) {
        return current
      }
      const parent = path.dirname(current)
      if (!parent || parent === current) break
      current = parent
    }
    return null
  } catch (_e) {
    return null
  }
})

ipcMain.handle('get-windows-hide-ext', async () => {
  if (process.platform !== 'win32') return false
  return await new Promise<boolean>((resolve) => {
    execFile(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced',
        '/v',
        'HideFileExt'
      ],
      { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(false)
        const match = stdout.match(/HideFileExt\s+REG_DWORD\s+0x([0-9a-fA-F]+)/)
        if (!match) return resolve(false)
        const val = parseInt(match[1], 16)
        resolve(val === 1)
      }
    )
  })
})

ipcMain.handle('select-songFingerprintFile', async (event) => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (result.canceled) {
    return null
  }
  try {
    const filePath = result.filePaths[0]
    const json = await fs.readJSON(filePath)
    if (Array.isArray(json) && json.every((item) => typeof item === 'string')) {
      return [filePath]
    }
    return 'error'
  } catch (error) {
    return 'error'
  }
})

ipcMain.on('layoutConfigChanged', (e, layoutConfig) => {
  fs.outputJson(url.layoutConfigFileUrl, JSON.parse(layoutConfig))
})

ipcMain.handle('exportSongFingerprint', async (e, folderPath) => {
  const toPath = path.join(
    folderPath,
    'songFingerprint' + getCurrentTimeYYYYMMDDHHMMSSSSS() + '.json'
  )
  await exportSnapshot(toPath, store.songFingerprintList || [])
})

ipcMain.handle('importSongFingerprint', async (e, filePath: string) => {
  const merged = await importFromJsonFile(filePath)
  store.songFingerprintList = merged
  return
})

ipcMain.handle('exportSongListToDir', async (e, folderPathVal, deleteSongsAfterExport, dirPath) => {
  let scanPath = path.join(store.databaseDir, mapRendererPathToFsPath(dirPath))
  let songFileUrls = await collectFilesWithExtensions(scanPath, store.settingConfig.audioExt)
  let folderName = dirPath.split('/')[dirPath.split('/').length - 1]
  async function findUniqueFolder(inputFolderPath: string) {
    let parts = path.parse(inputFolderPath)
    // 获取不包含文件名的路径部分
    let dirPath = parts.dir
    // 获取文件夹名（不包含路径分隔符）
    let folderName = parts.name
    // 构造基础检查路径
    let baseCheckPath = path.join(dirPath, folderName)
    if (await fs.pathExists(baseCheckPath)) {
      let count = 1
      let newFolderPath
      do {
        newFolderPath = path.join(dirPath, `${folderName}(${count})`)
        count++
      } while (await fs.pathExists(newFolderPath))
      return newFolderPath
    }
    return inputFolderPath
  }
  let targetPath = await findUniqueFolder(folderPathVal + '\\' + folderName)
  await fs.ensureDir(targetPath)
  const tasks: Array<() => Promise<any>> = []
  for (let item of songFileUrls) {
    const matches = item.match(/[^\\]+$/)
    if (Array.isArray(matches) && matches.length > 0) {
      const dest = targetPath + '\\' + matches[0]
      tasks.push(() => moveOrCopyItemWithCheckIsExist(item, dest, deleteSongsAfterExport))
    }
  }
  const batchId = `exportSongList_${Date.now()}`
  const { success, failed, hasENOSPC, skipped, results } = await runWithConcurrency(tasks, {
    concurrency: 16,
    stopOnENOSPC: true,
    onInterrupted: async (payload) =>
      waitForUserDecision(mainWindow.instance ?? null, batchId, 'exportSongList', payload)
  })
  if (hasENOSPC && mainWindow.instance) {
    mainWindow.instance.webContents.send('file-batch-summary', {
      context: 'exportSongList',
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
  // 推满进度，避免 UI 悬挂
  if (mainWindow.instance) {
    mainWindow.instance.webContents.send(
      'progressSet',
      'tracks.copyingTracks',
      tasks.length,
      tasks.length,
      false
    )
  }
  if (failed > 0) {
    throw new Error('exportSongListToDir failed')
  }
  return
})

ipcMain.handle('exportSongsToDir', async (e, folderPathVal, deleteSongsAfterExport, songs) => {
  const tasks: Array<() => Promise<any>> = []
  for (let item of songs) {
    let targetPath = folderPathVal + '\\' + item.filePath.match(/[^\\]+$/)[0]
    tasks.push(() =>
      moveOrCopyItemWithCheckIsExist(item.filePath, targetPath, deleteSongsAfterExport)
    )
  }
  const batchId = `exportSongs_${Date.now()}`
  const { success, failed, hasENOSPC, skipped, results } = await runWithConcurrency(tasks, {
    concurrency: 16,
    stopOnENOSPC: true,
    onInterrupted: async (payload) =>
      waitForUserDecision(mainWindow.instance ?? null, batchId, 'exportSongs', payload)
  })
  if (hasENOSPC && mainWindow.instance) {
    mainWindow.instance.webContents.send('file-batch-summary', {
      context: 'exportSongs',
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
    mainWindow.instance.webContents.send(
      'progressSet',
      'tracks.copyingTracks',
      tasks.length,
      tasks.length,
      false
    )
  }
  if (failed > 0) {
    throw new Error('exportSongsToDir failed')
  }
  return
})

ipcMain.handle('moveSongsToDir', async (e, srcs, dest) => {
  const tasks: Array<() => Promise<any>> = []
  for (let src of srcs) {
    const matches = src.match(/[^\\]+$/)
    if (Array.isArray(matches) && matches.length > 0) {
      const targetPath = path.join(store.databaseDir, mapRendererPathToFsPath(dest), matches[0])
      tasks.push(() => moveOrCopyItemWithCheckIsExist(src, targetPath, true))
    }
  }
  const batchId = `moveSongs_${Date.now()}`
  const { success, failed, hasENOSPC, skipped, results } = await runWithConcurrency(tasks, {
    concurrency: 16,
    stopOnENOSPC: true,
    onInterrupted: async (payload) =>
      waitForUserDecision(mainWindow.instance ?? null, batchId, 'moveSongs', payload)
  })
  if (hasENOSPC && mainWindow.instance) {
    mainWindow.instance.webContents.send('file-batch-summary', {
      context: 'moveSongs',
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
    mainWindow.instance.webContents.send(
      'progressSet',
      'tracks.movingTracks',
      tasks.length,
      tasks.length,
      false
    )
  }
  if (failed > 0) {
    throw new Error('moveSongsToDir failed')
  }
  return
})

// async function mainTest() {
//   const extractor = new AudioFeatureExtractor({
//     windowSize: 2048,
//     hopSize: 1024,
//     numberOfMFCCCoefficients: 13
//   });

//   try {
//     // 测试不同格式
//     const files = [
//       'E:\\test.mp3'
//       // 'path/to/audio.wav',
//       // 'path/to/audio.flac'
//     ];

//     for (const file of files) {
//       const result = await extractor.extractMFCC(file);
//       // console.log(result)
//       // 计算统计特征
//       const statistics = extractor.calculate_MFCC_Statistics(result.mfcc);

//       // 输出结果
//       console.log('MFCC statistics:', statistics);
//     }

//   } catch (error) {
//     console.error('Error in main:', error);
//   }
// }

// mainTest()
