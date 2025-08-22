import { app, BrowserWindow, ipcMain, dialog, shell, IpcMainInvokeEvent } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import {
  getLibrary,
  collectFilesWithExtensions,
  getCurrentTimeYYYYMMDDHHMMSSSSS,
  moveOrCopyItemWithCheckIsExist,
  operateHiddenFile,
  runWithConcurrency,
  waitForUserDecision
} from './utils'
import { log } from './log'
import './cloudSync'
import errorReport from './errorReport'
import url from './url'
import mainWindow from './window/mainWindow'
import databaseInitWindow from './window/databaseInitWindow'
import foundOldVersionDatabaseWindow from './window/foundOldVersionDatabaseWindow'
import { is } from '@electron-toolkit/utils'
import store from './store'
import foundNewVersionWindow from './window/foundNewVersionWindow'
import updateWindow from './window/updateWindow'
import electronUpdater = require('electron-updater')
import { ISongInfo } from '../types/globals'
import { v4 as uuidV4 } from 'uuid'
// import AudioFeatureExtractor from './mfccTest'

const initDevDatabase = true
const dev_DB = 'C:\\Users\\renlu\\Desktop\\FRKB_database'
const my_real_DB = 'D:\\FRKB_database'
// 需要切换时，将下一行改为 my_real_DB
let devDatabase = dev_DB

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
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
    language: is.dev ? 'enUS' : '',
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
  language: (is.dev ? 'enUS' : '') as '' | 'enUS' | 'zhCN',
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

let devInitDatabaseFunction = () => {
  if (!fs.pathExistsSync(store.settingConfig.databaseUrl)) {
    return
  }
  // 在dev环境下每次启动时重新初始化数据库
  if (fs.pathExistsSync(store.settingConfig.databaseUrl)) {
    fs.removeSync(store.settingConfig.databaseUrl)
  }
  // 使用databaseInitWindow中的初始化逻辑
  let rootDescription = {
    uuid: uuidV4(),
    type: 'root',
    order: 1
  }
  fs.ensureDirSync(path.join(store.settingConfig.databaseUrl, 'library'))
  fs.outputJsonSync(
    path.join(store.settingConfig.databaseUrl, 'library', '.description.json'),
    rootDescription
  )

  const makeLibrary = async (libraryPath: string, order: number) => {
    let description = {
      uuid: uuidV4(),
      type: 'library',
      order: order
    }
    fs.ensureDirSync(libraryPath)
    fs.outputJsonSync(path.join(libraryPath, '.description.json'), description)
  }

  let filterLibraryPath = path.join(store.settingConfig.databaseUrl, 'library/筛选库')
  let curatedLibraryPath = path.join(store.settingConfig.databaseUrl, 'library/精选库')
  let recycleBinPath = path.join(store.settingConfig.databaseUrl, 'library/回收站')

  makeLibrary(filterLibraryPath, 1)
  makeLibrary(curatedLibraryPath, 2)
  makeLibrary(recycleBinPath, 3)

  // 创建示例歌单和歌曲
  fs.ensureDirSync(path.join(filterLibraryPath, 'House'))
  fs.outputJsonSync(path.join(filterLibraryPath, 'House', '.description.json'), {
    uuid: 'filterLibrarySonglistDemo1',
    type: 'songList',
    order: 1
  })

  const filterLibrarySonglistSongDemo1 = path
    .join(
      __dirname,
      '../../resources/demoMusic/Oden & Fatzo, Poppy Baskcomb - Tell Me What You Want (Extended Mix).mp3'
    )
    .replace('app.asar', 'app.asar.unpacked')
  const filterLibrarySonglistSongDemo2 = path
    .join(__dirname, '../../resources/demoMusic/War - Low Rider (Kyle Watson Remix).mp3')
    .replace('app.asar', 'app.asar.unpacked')

  if (fs.pathExistsSync(filterLibrarySonglistSongDemo1)) {
    fs.copySync(
      filterLibrarySonglistSongDemo1,
      path.join(
        filterLibraryPath,
        'House',
        'Oden & Fatzo, Poppy Baskcomb - Tell Me What You Want (Extended Mix).mp3'
      )
    )
  }
  if (fs.pathExistsSync(filterLibrarySonglistSongDemo2)) {
    fs.copySync(
      filterLibrarySonglistSongDemo2,
      path.join(filterLibraryPath, 'House', 'War - Low Rider (Kyle Watson Remix).mp3')
    )
  }

  fs.ensureDirSync(path.join(curatedLibraryPath, 'House Nice'))
  fs.outputJsonSync(path.join(curatedLibraryPath, 'House Nice', '.description.json'), {
    uuid: 'curatedLibrarySonglistDemo1',
    type: 'songList',
    order: 1
  })

  const curatedLibrarySonglistSongDemo1 = path
    .join(
      __dirname,
      '../../resources/demoMusic/Armand Van Helden - I Want Your Soul (AVH Rework).mp3'
    )
    .replace('app.asar', 'app.asar.unpacked')

  if (fs.pathExistsSync(curatedLibrarySonglistSongDemo1)) {
    fs.copySync(
      curatedLibrarySonglistSongDemo1,
      path.join(
        curatedLibraryPath,
        'House Nice',
        'Armand Van Helden - I Want Your Soul (AVH Rework).mp3'
      )
    )
  }

  // 初始化指纹数据
  fs.ensureDirSync(path.join(store.settingConfig.databaseUrl, 'songFingerprint'))
  fs.outputJsonSync(
    path.join(store.settingConfig.databaseUrl, 'songFingerprint', 'songFingerprintV2.json'),
    []
  )

  // 更新store
  store.databaseDir = store.settingConfig.databaseUrl
  store.songFingerprintList = []
  console.log('devInitDatabase')
}
if (is.dev && platform === 'win32') {
  // store.settingConfig.databaseUrl = devDatabase
  // if (initDevDatabase) {
  //   if (devDatabase !== my_real_DB) {
  //     // 做一个保险，防止误操作把我真实数据库删了
  //     devInitDatabaseFunction()
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
    try {
      // 检查核心库描述文件
      let libraryJson = fs.readJSONSync(
        path.join(store.settingConfig.databaseUrl, 'library', '.description.json')
      )
      let filterLibraryJson = fs.readJSONSync(
        path.join(store.settingConfig.databaseUrl, 'library', '精选库', '.description.json')
      )
      let curatedLibraryJson = fs.readJSONSync(
        path.join(store.settingConfig.databaseUrl, 'library', '筛选库', '.description.json')
      )

      if (
        !(libraryJson.uuid && libraryJson.type === 'root') ||
        !(filterLibraryJson.uuid && filterLibraryJson.type === 'library') ||
        !(curatedLibraryJson.uuid && curatedLibraryJson.type === 'library')
      ) {
        // 核心库有问题，显示初始化窗口并提示错误
        databaseInitWindow.createWindow({ needErrorHint: true })
      } else {
        // 核心库正常，检查回收站
        try {
          let recycleBinJson = fs.readJSONSync(
            path.join(store.settingConfig.databaseUrl, 'library', '回收站', '.description.json')
          )
          if (!(recycleBinJson.uuid && recycleBinJson.type === 'library')) {
            throw new Error('Invalid recycle bin description') // 抛出错误以触发创建
          }
        } catch (recycleBinError) {
          // 回收站有问题或不存在，静默创建
          const recycleBinPath = path.join(store.settingConfig.databaseUrl, 'library/回收站')
          const description = {
            uuid: uuidV4(),
            type: 'library',
            order: 3 // 默认顺序为3
          }
          await fs.ensureDir(recycleBinPath) // 确保目录存在
          // 使用 operateHiddenFile 写入隐藏文件，如果项目中有此模式
          await operateHiddenFile(path.join(recycleBinPath, '.description.json'), async () => {
            await fs.outputJson(path.join(recycleBinPath, '.description.json'), description)
          })
        }

        // 检查旧版本数据库标识
        if (
          fs.pathExistsSync(
            path.join(store.settingConfig.databaseUrl, 'songFingerprint', 'songFingerprint.json')
          )
        ) {
          foundOldVersionDatabaseWindow.createWindow()
          return
        }

        // 检查并加载指纹数据
        let songFingerprintListJson = fs.readJSONSync(
          path.join(store.settingConfig.databaseUrl, 'songFingerprint', 'songFingerprintV2.json')
        )
        if (
          !Array.isArray(songFingerprintListJson) ||
          songFingerprintListJson.some((item) => typeof item !== 'string')
        ) {
          // 指纹文件格式错误，也显示初始化窗口
          databaseInitWindow.createWindow({ needErrorHint: true })
        } else {
          // 一切正常，加载主窗口
          store.databaseDir = store.settingConfig.databaseUrl
          store.songFingerprintList = songFingerprintListJson
          mainWindow.createWindow()
        }
      }
    } catch (error) {
      // 捕获读取核心库文件时的错误
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
        try {
          // 检查核心库描述文件 (与 whenReady 逻辑类似)
          let libraryJson = fs.readJSONSync(
            path.join(store.settingConfig.databaseUrl, 'library', '.description.json')
          )
          let filterLibraryJson = fs.readJSONSync(
            path.join(store.settingConfig.databaseUrl, 'library', '精选库', '.description.json')
          )
          let curatedLibraryJson = fs.readJSONSync(
            path.join(store.settingConfig.databaseUrl, 'library', '筛选库', '.description.json')
          )

          if (
            !(libraryJson.uuid && libraryJson.type === 'root') ||
            !(filterLibraryJson.uuid && filterLibraryJson.type === 'library') ||
            !(curatedLibraryJson.uuid && curatedLibraryJson.type === 'library')
          ) {
            databaseInitWindow.createWindow({ needErrorHint: true })
          } else {
            // 核心库正常，检查回收站 (与 whenReady 逻辑类似)
            try {
              let recycleBinJson = fs.readJSONSync(
                path.join(store.settingConfig.databaseUrl, 'library', '回收站', '.description.json')
              )
              if (!(recycleBinJson.uuid && recycleBinJson.type === 'library')) {
                throw new Error('Invalid recycle bin description')
              }
            } catch (recycleBinError) {
              const recycleBinPath = path.join(store.settingConfig.databaseUrl, 'library/回收站')
              const description = {
                uuid: uuidV4(),
                type: 'library',
                order: 3
              }
              await fs.ensureDir(recycleBinPath)
              await operateHiddenFile(path.join(recycleBinPath, '.description.json'), async () => {
                await fs.outputJson(path.join(recycleBinPath, '.description.json'), description)
              })
            }

            // 检查旧版本数据库标识 (与 whenReady 逻辑类似)
            if (
              fs.pathExistsSync(
                path.join(
                  store.settingConfig.databaseUrl,
                  'songFingerprint',
                  'songFingerprint.json'
                )
              )
            ) {
              foundOldVersionDatabaseWindow.createWindow()
              return
            }

            // 检查并加载指纹数据 (与 whenReady 逻辑类似)
            let songFingerprintListJson = fs.readJSONSync(
              path.join(
                store.settingConfig.databaseUrl,
                'songFingerprint',
                'songFingerprintV2.json'
              )
            )
            if (
              !Array.isArray(songFingerprintListJson) ||
              songFingerprintListJson.some((item) => typeof item !== 'string')
            ) {
              databaseInitWindow.createWindow({ needErrorHint: true })
            } else {
              store.databaseDir = store.settingConfig.databaseUrl
              store.songFingerprintList = songFingerprintListJson
              mainWindow.createWindow()
            }
          }
        } catch (error) {
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
    const dir = path.join(store.databaseDir, 'songFingerprint')
    const file = path.join(dir, 'songFingerprintV2.json')
    await fs.ensureDir(dir)
    store.songFingerprintList = []
    if (await fs.pathExists(file)) {
      await operateHiddenFile(file, async () => {
        await fs.outputJSON(file, store.songFingerprintList)
      })
    } else {
      await fs.outputJSON(file, store.songFingerprintList)
    }
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
  let recycleBinTargetDir = path.join(store.databaseDir, 'library', '回收站', dirName)
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
    const filePath = path.join(store.databaseDir, targetPath, '.description.json')
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
  let scanPath = path.join(store.databaseDir, songListPath)
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
  const file = path.join(store.databaseDir, 'songFingerprint', 'songFingerprintV2.json')
  await fs.copy(
    file,
    folderPath + '\\songFingerprint' + getCurrentTimeYYYYMMDDHHMMSSSSS() + '.json'
  )
})

ipcMain.handle('importSongFingerprint', async (e, filePath: string) => {
  let json: string[] = await fs.readJSON(filePath)
  store.songFingerprintList = store.songFingerprintList.concat(json)
  store.songFingerprintList = Array.from(new Set(store.songFingerprintList))
  const dir = path.join(store.databaseDir, 'songFingerprint')
  const file = path.join(dir, 'songFingerprintV2.json')
  await fs.ensureDir(dir)
  if (await fs.pathExists(file)) {
    await operateHiddenFile(file, async () => {
      await fs.outputJSON(file, store.songFingerprintList)
    })
  } else {
    await fs.outputJSON(file, store.songFingerprintList)
  }
  return
})

ipcMain.handle('exportSongListToDir', async (e, folderPathVal, deleteSongsAfterExport, dirPath) => {
  let scanPath = path.join(store.databaseDir, dirPath)
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
      const targetPath = path.join(store.databaseDir, dest, matches[0])
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
