import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import {
  updateTargetDirSubdirOrder,
  getLibrary,
  collectFilesWithExtensions,
  getCurrentTimeYYYYMMDDHHMMSSSSS,
  moveOrCopyItemWithCheckIsExist,
  operateHiddenFile
} from './utils'
import { log } from './log'
import url from './url'
import mainWindow from './window/mainWindow'
import databaseInitWindow from './window/databaseInitWindow'
import foundOldVersionDatabaseWindow from './window/foundOldVersionDatabaseWindow'
import { languageDict } from './translate'
import { is } from '@electron-toolkit/utils'
import store from './store'
import foundNewVersionWindow from './window/foundNewVersionWindow'
import updateWindow from './window/updateWindow'
import electronUpdater = require('electron-updater')
import { IDir, ISongInfo } from '../types/globals'
import { v4 as uuidV4 } from 'uuid'
// import AudioFeatureExtractor from './mfccTest'

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
    fastForwardTime: 10,
    fastBackwardTime: -5
  })
}

store.layoutConfig = fs.readJSONSync(url.layoutConfigFileUrl)
store.settingConfig = fs.readJSONSync(url.settingConfigFileUrl)
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
  store.settingConfig.databaseUrl = 'C:\\Users\\Trl\\Desktop\\FRKBDATA\\FRKB_database'
  devInitDatabaseFunction()
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('frkb.coderDjing')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  if (!store.settingConfig.databaseUrl) {
    databaseInitWindow.createWindow()
  } else {
    try {
      let libraryJson = fs.readJSONSync(
        path.join(store.settingConfig.databaseUrl, 'library', '.description.json')
      )
      let filterLibraryJson = fs.readJSONSync(
        path.join(store.settingConfig.databaseUrl, 'library', '精选库', '.description.json')
      )
      let curatedLibraryJson = fs.readJSONSync(
        path.join(store.settingConfig.databaseUrl, 'library', '筛选库', '.description.json')
      )
      let recycleBinJson = fs.readJSONSync(
        path.join(store.settingConfig.databaseUrl, 'library', '回收站', '.description.json')
      )
      if (
        libraryJson.uuid &&
        libraryJson.type === 'root' &&
        filterLibraryJson.uuid &&
        filterLibraryJson.type === 'library' &&
        curatedLibraryJson.uuid &&
        curatedLibraryJson.type === 'library' &&
        recycleBinJson.uuid &&
        recycleBinJson.type === 'library'
      ) {
        if (
          fs.pathExistsSync(
            path.join(store.settingConfig.databaseUrl, 'songFingerprint', 'songFingerprint.json')
          )
        ) {
          foundOldVersionDatabaseWindow.createWindow()
          return
        }

        let songFingerprintListJson = fs.readJSONSync(
          path.join(store.settingConfig.databaseUrl, 'songFingerprint', 'songFingerprintV2.json')
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
      } else {
        databaseInitWindow.createWindow({ needErrorHint: true })
      }
    } catch (error) {
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

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      if (!store.settingConfig.databaseUrl) {
        databaseInitWindow.createWindow()
      } else {
        try {
          let filterLibraryJson = fs.readJSONSync(
            path.join(store.settingConfig.databaseUrl, 'library', '精选库', '.description.json')
          )
          let curatedLibraryJson = fs.readJSONSync(
            path.join(store.settingConfig.databaseUrl, 'library', '筛选库', '.description.json')
          )
          if (
            filterLibraryJson.uuid &&
            filterLibraryJson.type === 'library' &&
            curatedLibraryJson.uuid &&
            curatedLibraryJson.type === 'library'
          ) {
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
          } else {
            databaseInitWindow.createWindow({ needErrorHint: true })
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

ipcMain.handle('getLanguageDict', () => {
  return languageDict
})
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

ipcMain.handle('clearTracksFingerprintLibrary', (e) => {
  store.songFingerprintList = []
  fs.outputJSON(
    path.join(store.databaseDir, 'songFingerprint', 'songFingerprintV2.json'),
    store.songFingerprintList
  )
})

ipcMain.handle('moveInDir', async (e, src, dest, isExist) => {
  const srcFullPath = path.join(store.databaseDir, src)
  const destDir = path.join(store.databaseDir, dest)
  const destFileName = path.basename(srcFullPath)
  const destFullPath = path.join(destDir, destFileName)
  if (isExist) {
    let oldJson = await fs.readJSON(path.join(destDir, '.description.json'))
    await updateTargetDirSubdirOrder(destDir, oldJson.order, 'before', 'plus')
    await fs.move(srcFullPath, destFullPath, { overwrite: true })
    let json = await fs.readJSON(path.join(destFullPath, '.description.json'))
    let originalOrder = json.order
    json.order = 1
    await operateHiddenFile(path.join(destFullPath, '.description.json'), async () => {
      await fs.outputJSON(path.join(destFullPath, '.description.json'), json)
    })
    const srcDir = path.dirname(srcFullPath)
    await updateTargetDirSubdirOrder(srcDir, originalOrder, 'after', 'minus')
  } else {
    await updateTargetDirSubdirOrder(destDir, 0, 'after', 'plus')
    await fs.move(srcFullPath, destFullPath, { overwrite: true })
    let json = await fs.readJSON(path.join(destFullPath, '.description.json'))
    let originalOrder = json.order
    json.order = 1
    await operateHiddenFile(path.join(destFullPath, '.description.json'), async () => {
      await fs.outputJSON(path.join(destFullPath, '.description.json'), json)
    })
    await updateTargetDirSubdirOrder(path.dirname(srcFullPath), originalOrder, 'after', 'minus')
  }
})
ipcMain.on('delSongs', async (e, songFilePaths: string[], dirName: string) => {
  let recycleBinTargetDir = path.join(store.databaseDir, 'library', '回收站', dirName)
  fs.ensureDirSync(recycleBinTargetDir)
  const promises = []
  for (let item of songFilePaths) {
    promises.push(fs.move(item, path.join(recycleBinTargetDir, path.basename(item))))
  }
  await Promise.all(promises)
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
    songInfoArr.push({
      filePath: url,
      cover: cover,
      title: metadata.common?.title,
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

ipcMain.handle('moveToDirSample', async (e, src, dest) => {
  const srcFullPath = path.join(store.databaseDir, src)
  const destDir = path.join(store.databaseDir, dest)
  const destFileName = path.basename(srcFullPath)
  const destFullPath = path.join(destDir, destFileName)
  await fs.move(srcFullPath, destFullPath)
})

ipcMain.handle('reOrderSubDir', async (e, targetPath: string, subDirArrJson: string) => {
  const subDirArr = JSON.parse(subDirArrJson)
  const promises = subDirArr.map(async (item: IDir) => {
    const jsonPath = path.join(store.databaseDir, targetPath, item.dirName, '.description.json')
    const json = await fs.readJSON(jsonPath)
    if (json.order !== item.order) {
      json.order = item.order
      await operateHiddenFile(jsonPath, async () => {
        await fs.outputJSON(jsonPath, json)
      })
    }
  })
  await Promise.all(promises)
})

// 更新目录的 description.json 文件
ipcMain.handle('updateDirDescription', async (e, dirPath: string, descriptionJson: string) => {
  const jsonPath = path.join(store.databaseDir, dirPath, '.description.json')
  await operateHiddenFile(jsonPath, async () => {
    await fs.outputJSON(jsonPath, JSON.parse(descriptionJson))
  })
})

ipcMain.handle('getLibrary', async () => {
  const library = await getLibrary()
  return library
})

ipcMain.handle('renameDir', async (e, newName, dirPath) => {
  await fs.rename(
    path.join(store.databaseDir, dirPath),
    path.join(store.databaseDir, dirPath.slice(0, dirPath.lastIndexOf('/') + 1) + newName)
  )
})
ipcMain.handle('updateOrderAfterNum', async (e, targetPath, order) => {
  await updateTargetDirSubdirOrder(
    path.join(store.databaseDir, targetPath),
    order,
    'after',
    'minus'
  )
})

ipcMain.handle('delDir', async (e, targetPath, dirName: string) => {
  let dirPath = path.join(store.databaseDir, targetPath)
  const recycleBinTargetDir = path.join(store.databaseDir, 'library', '回收站', dirName)

  // 读取目录内容
  const items = await fs.readdir(dirPath)
  const promises = []
  // 遍历并移动文件/文件夹
  for (const item of items) {
    if (item !== '.description.json') {
      const srcPath = path.join(dirPath, item)
      const destPath = path.join(recycleBinTargetDir, item)
      promises.push(fs.move(srcPath, destPath))
    }
  }
  await Promise.all(promises)
  await fs.remove(dirPath)
  if (promises.length > 0) {
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
  }
})

ipcMain.handle('mkDir', async (e, descriptionJson, dirPath) => {
  await updateTargetDirSubdirOrder(path.join(store.databaseDir, dirPath), 0, 'after', 'plus')
  let targetPath = path.join(store.databaseDir, dirPath, descriptionJson.dirName)
  await operateHiddenFile(path.join(targetPath, '.description.json'), async () => {
    descriptionJson.dirName = undefined
    await fs.outputJson(path.join(targetPath, '.description.json'), descriptionJson)
  })
})

ipcMain.handle('updateTargetDirSubdirOrderAdd', async (e, dirPath) => {
  await updateTargetDirSubdirOrder(path.join(store.databaseDir, dirPath), 0, 'after', 'plus')
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
  await fs.copy(
    path.join(store.databaseDir, 'songFingerprint', 'songFingerprintV2.json'),
    folderPath + '\\songFingerprint' + getCurrentTimeYYYYMMDDHHMMSSSSS() + '.json'
  )
})

ipcMain.handle('importSongFingerprint', async (e, filePath: string) => {
  let json: string[] = await fs.readJSON(filePath)
  store.songFingerprintList = store.songFingerprintList.concat(json)
  store.songFingerprintList = Array.from(new Set(store.songFingerprintList))
  fs.outputJSON(
    path.join(store.databaseDir, 'songFingerprint', 'songFingerprintV2.json'),
    store.songFingerprintList
  )
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
  const promises = []
  for (let item of songFileUrls) {
    const matches = item.match(/[^\\]+$/)
    if (Array.isArray(matches) && matches.length > 0) {
      promises.push(
        moveOrCopyItemWithCheckIsExist(item, targetPath + '\\' + matches[0], deleteSongsAfterExport)
      )
    }
  }
  await Promise.all(promises)
  return
})

ipcMain.handle('exportSongsToDir', async (e, folderPathVal, deleteSongsAfterExport, songs) => {
  const promises = []
  for (let item of songs) {
    let targetPath = folderPathVal + '\\' + item.filePath.match(/[^\\]+$/)[0]
    promises.push(moveOrCopyItemWithCheckIsExist(item.filePath, targetPath, deleteSongsAfterExport))
  }
  await Promise.all(promises)
  return
})

ipcMain.handle('moveSongsToDir', async (e, srcs, dest) => {
  const moveSongToDir = async (src: string, dest: string) => {
    const matches = src.match(/[^\\]+$/)
    if (Array.isArray(matches) && matches.length > 0) {
      let targetPath = path.join(store.databaseDir, dest, matches[0])
      await moveOrCopyItemWithCheckIsExist(src, targetPath, true)
    }
  }
  const promises = []
  for (let src of srcs) {
    promises.push(moveSongToDir(src, dest))
  }
  await Promise.all(promises)
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
