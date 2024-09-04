import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import {
  updateTargetDirSubdirOrder,
  getLibrary,
  collectFilesWithExtensions,
  executeScript,
  moveOrCopyItemWithCheckIsExist,
  getCurrentTimeYYYYMMDDHHMMSSSSS
} from './utils.js'

import { v4 as uuidv4 } from 'uuid'
import { log, logInit } from './log.js'
import url from './url.js'
import mainWindow from './mainWindow.js'
import databaseInitWindow from './databaseInitWindow.js'

logInit()

const fs = require('fs-extra')
if (!fs.pathExistsSync(url.layoutConfigFileUrl)) {
  fs.outputJsonSync(url.layoutConfigFileUrl, {
    libraryAreaWidth: 175,
    isMaxMainWin: false,
    mainWindowWidth: 900,
    mainWindowHeight: 600
  })
  fs.outputJsonSync(url.settingConfigFileUrl, {
    language: '',
    audioExt: ['.mp3', '.wav', '.flac']
  })
}

// let layoutConfig = fs.readJSONSync(url.layoutConfigFileUrl)
let settingConfig = fs.readJSONSync(url.settingConfigFileUrl)
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    if (databaseInitWindow.instance) {
      if (databaseInitWindow.instance.isMinimized()) mainWindow.instance.restore()
      databaseInitWindow.instance.focus()
    } else if (mainWindow.instance) {
      if (mainWindow.instance.isMinimized()) mainWindow.instance.restore()
      mainWindow.instance.focus()
    }
  })
}
let enUS = fs.readJSONSync(url.enUsUrl)
let zhCN = fs.readJSONSync(url.zhCNUrl)
let languageDict = {
  enUS,
  zhCN
}
app.whenReady().then(() => {
  electronApp.setAppUserModelId('frkb.coderDjing')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  console.log(settingConfig)
  databaseInitWindow.createWindow()
  // app.on('activate', function () {
  //   // On macOS it's common to re-create a window in the app when the
  //   // dock icon is clicked and there are no other windows open.
  //   if (BrowserWindow.getAllWindows().length === 0) createWindow()
  // })
})

app.on('window-all-closed', () => {
  app.quit()
})

ipcMain.handle('getSetting', () => {
  return settingConfig
})
ipcMain.handle('setSetting', (e, setting) => {
  settingConfig = setting
  fs.outputJson(url.settingConfigFileUrl, setting)
})
ipcMain.on('outputLog', (e, logMsg) => {
  log.error(logMsg)
})

// // In this file you can include the rest of your app"s specific main process
// // code. You can also put them in separate files and require them here.

// //todo 用户数据的文件夹不应该在本地，应该是用户自行设置，在本地的话会导致重新安装或者升级新版本导致卸载旧版本的时候用户数据被删掉
// let exeDir = ''
// if (app.isPackaged) {
//   let exePath = app.getPath('exe')
//   exeDir = dirname(exePath)
// } else {
//   exeDir = __dirname
// }

// function t(str) {
//   return languageDict[settingConfig.language][str]
// }
// let songFingerprintList = []
// const libraryInit = async () => {
//   let rootDescription = {
//     uuid: uuidv4(),
//     type: 'root',
//     dirName: 'library',
//     order: 1
//   }
//   await fs.outputJson(join(exeDir, 'library', 'description.json'), rootDescription)
//   const makeLibrary = async (libraryPath, libraryName, order) => {
//     let description = {
//       uuid: uuidv4(),
//       type: 'library',
//       dirName: libraryName,
//       order: order
//     }
//     await fs.outputJson(join(libraryPath, 'description.json'), description)
//   }
//   await makeLibrary(join(exeDir, 'library/筛选库'), '筛选库', 1)
//   await makeLibrary(join(exeDir, 'library/精选库'), '精选库', 2)
//   await fs.outputJSON(join(exeDir, 'songFingerprint', 'songFingerprint.json'), [])
// }
// let isLibraryExist = fs.pathExistsSync(join(exeDir, 'library', 'description.json'))
// if (!isLibraryExist) {
//   libraryInit()
// } else {
//   songFingerprintList = fs.readJSONSync(join(exeDir, 'songFingerprint', 'songFingerprint.json'))
// }

ipcMain.handle('clearTracksFingerprintLibrary', (e) => {
  songFingerprintList = []
  fs.outputJSON(join(exeDir, 'songFingerprint', 'songFingerprint.json'), songFingerprintList)
})

ipcMain.handle('moveInDir', async (e, src, dest, isExist) => {
  const srcFullPath = join(exeDir, src)
  const destDir = join(exeDir, dest)
  const destFileName = path.basename(srcFullPath)
  const destFullPath = join(destDir, destFileName)
  if (isExist) {
    let oldJson = await fs.readJSON(join(destDir, 'description.json'))
    await updateTargetDirSubdirOrder(destDir, oldJson.order, 'before', 'plus')
    await fs.move(srcFullPath, destFullPath, { overwrite: true })
    let json = await fs.readJSON(join(destFullPath, 'description.json'))
    let originalOrder = json.order
    json.order = 1
    await fs.outputJSON(join(destFullPath, 'description.json'), json)
    const srcDir = path.dirname(srcFullPath)
    await updateTargetDirSubdirOrder(srcDir, originalOrder, 'after', 'minus')
  } else {
    await updateTargetDirSubdirOrder(destDir, 0, 'after', 'plus')
    await fs.move(srcFullPath, destFullPath, { overwrite: true })
    let json = await fs.readJSON(join(destFullPath, 'description.json'))
    let originalOrder = json.order
    json.order = 1
    await fs.outputJSON(join(destFullPath, 'description.json'), json)
    await updateTargetDirSubdirOrder(path.dirname(srcFullPath), originalOrder, 'after', 'minus')
  }
})
ipcMain.on('delSongs', async (e, songFilePaths) => {
  const promises = []
  for (let item of songFilePaths) {
    promises.push(fs.remove(item))
  }
  await Promise.all(promises)
})

ipcMain.handle('getLanguageDict', () => {
  return languageDict
})

ipcMain.handle('scanSongList', async (e, songListPath, songListUUID) => {
  let scanPath = join(exeDir, songListPath)
  const mm = await import('music-metadata')
  let songInfoArr = []
  let songFileUrls = await collectFilesWithExtensions(scanPath, settingConfig.audioExt)

  function convertSecondsToMinutesSeconds(seconds) {
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
      duration: convertSecondsToMinutesSeconds(Math.round(metadata.format.duration)), //时长
      genre: metadata.common?.genre?.[0],
      label: metadata.common?.label?.[0],
      bitrate: metadata.format?.bitrate, //比特率
      container: metadata.format?.container //编码格式
    })
  }
  return { scanData: songInfoArr, songListUUID }
})

ipcMain.handle('moveToDirSample', async (e, src, dest) => {
  const srcFullPath = join(exeDir, src)
  const destDir = join(exeDir, dest)
  const destFileName = path.basename(srcFullPath)
  const destFullPath = join(destDir, destFileName)
  await fs.move(srcFullPath, destFullPath)
})

ipcMain.handle('reOrderSubDir', async (e, targetPath, subDirArrJson) => {
  const subDirArr = JSON.parse(subDirArrJson)
  const promises = subDirArr.map(async (item) => {
    const jsonPath = join(exeDir, targetPath, item.dirName, 'description.json')
    const json = await fs.readJSON(jsonPath)
    if (json.order !== item.order) {
      json.order = item.order
      await fs.outputJSON(jsonPath, json)
    }
  })
  await Promise.all(promises)
})

ipcMain.handle('getLibrary', async () => {
  const library = await getLibrary()
  return library
})

ipcMain.handle('renameDir', async (e, newName, dirPath) => {
  let descriptionPath = join(exeDir, join(dirPath, 'description.json'))
  let descriptionJson = await fs.readJSON(descriptionPath)
  descriptionJson.dirName = newName
  await fs.outputJson(descriptionPath, descriptionJson)
  await fs.rename(
    join(exeDir, dirPath),
    join(exeDir, dirPath.slice(0, dirPath.lastIndexOf('/') + 1) + newName)
  )
})
ipcMain.handle('updateOrderAfterNum', async (e, targetPath, order) => {
  await updateTargetDirSubdirOrder(join(exeDir, targetPath), order, 'after', 'minus')
})

ipcMain.handle('delDir', async (e, targetPath) => {
  await fs.remove(join(exeDir, targetPath))
})

ipcMain.handle('mkDir', async (e, descriptionJson, dirPath) => {
  await updateTargetDirSubdirOrder(join(exeDir, dirPath), 0, 'after', 'plus')
  let targetPath = join(exeDir, dirPath, descriptionJson.dirName)
  await fs.outputJson(join(targetPath, 'description.json'), descriptionJson)
})

ipcMain.handle('updateTargetDirSubdirOrderAdd', async (e, dirPath) => {
  await updateTargetDirSubdirOrder(join(exeDir, dirPath), 0, 'after', 'plus')
})

ipcMain.handle('select-folder', async (event, multiSelections = true) => {
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
