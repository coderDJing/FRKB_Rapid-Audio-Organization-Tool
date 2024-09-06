import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { updateTargetDirSubdirOrder, getLibrary, collectFilesWithExtensions } from './utils.js'

import { log } from './log.js'
import url from './url.js'
import mainWindow from './window/mainWindow.js'
import databaseInitWindow from './window/databaseInitWindow.js'
import { languageDict } from './translate.js'
import store from './store.js'
const path = require('path')
const fs = require('fs-extra')
if (!fs.pathExistsSync(url.layoutConfigFileUrl)) {
  fs.outputJsonSync(url.layoutConfigFileUrl, {
    libraryAreaWidth: 175,
    isMaxMainWin: false,
    mainWindowWidth: 900,
    mainWindowHeight: 600
  })
  fs.outputJsonSync(url.settingConfigFileUrl, {
    language: 'zhCN', //todo 初始为空
    audioExt: ['.mp3', '.wav', '.flac'],
    databaseUrl: 'D:\\FRKB\\FRKB_database' //todo 初始为空
  })
}

store.layoutConfig = fs.readJSONSync(url.layoutConfigFileUrl)
store.settingConfig = fs.readJSONSync(url.settingConfigFileUrl)
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

app.whenReady().then(() => {
  electronApp.setAppUserModelId('frkb.coderDjing')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  if (!store.settingConfig.databaseUrl || !fs.pathExistsSync(store.settingConfig.databaseUrl)) {
    databaseInitWindow.createWindow()
  } else {
    store.databaseDir = store.settingConfig.databaseUrl
    store.songFingerprintList = fs.readJSONSync(
      path.join(store.databaseDir, 'songFingerprint', 'songFingerprint.json')
    )
    mainWindow.createWindow()
  }

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      if (!store.settingConfig.databaseUrl || !fs.pathExistsSync(store.settingConfig.databaseUrl)) {
        databaseInitWindow.createWindow()
      } else {
        store.databaseDir = store.settingConfig.databaseUrl
        store.songFingerprintList = fs.readJSONSync(
          path.join(store.databaseDir, 'songFingerprint', 'songFingerprint.json')
        )
        mainWindow.createWindow()
      }
    }
  })
})

app.on('window-all-closed', () => {
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

ipcMain.handle('clearTracksFingerprintLibrary', (e) => {
  store.songFingerprintList = []
  fs.outputJSON(
    path.join(store.databaseDir, 'songFingerprint', 'songFingerprint.json'),
    store.songFingerprintList
  )
})

ipcMain.handle('moveInDir', async (e, src, dest, isExist) => {
  const srcFullPath = path.join(store.databaseDir, src)
  const destDir = path.join(store.databaseDir, dest)
  const destFileName = path.basename(srcFullPath)
  const destFullPath = path.join(destDir, destFileName)
  if (isExist) {
    let oldJson = await fs.readJSON(path.join(destDir, 'description.json'))
    await updateTargetDirSubdirOrder(destDir, oldJson.order, 'before', 'plus')
    await fs.move(srcFullPath, destFullPath, { overwrite: true })
    let json = await fs.readJSON(path.join(destFullPath, 'description.json'))
    let originalOrder = json.order
    json.order = 1
    await fs.outputJSON(path.join(destFullPath, 'description.json'), json)
    const srcDir = path.dirname(srcFullPath)
    await updateTargetDirSubdirOrder(srcDir, originalOrder, 'after', 'minus')
  } else {
    await updateTargetDirSubdirOrder(destDir, 0, 'after', 'plus')
    await fs.move(srcFullPath, destFullPath, { overwrite: true })
    let json = await fs.readJSON(path.join(destFullPath, 'description.json'))
    let originalOrder = json.order
    json.order = 1
    await fs.outputJSON(path.join(destFullPath, 'description.json'), json)
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

ipcMain.handle('scanSongList', async (e, songListPath, songListUUID) => {
  let scanPath = path.join(store.databaseDir, songListPath)
  const mm = await import('music-metadata')
  let songInfoArr = []
  let songFileUrls = await collectFilesWithExtensions(scanPath, store.settingConfig.audioExt)

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
  const srcFullPath = path.join(store.databaseDir, src)
  const destDir = path.join(store.databaseDir, dest)
  const destFileName = path.basename(srcFullPath)
  const destFullPath = path.join(destDir, destFileName)
  await fs.move(srcFullPath, destFullPath)
})

ipcMain.handle('reOrderSubDir', async (e, targetPath, subDirArrJson) => {
  const subDirArr = JSON.parse(subDirArrJson)
  const promises = subDirArr.map(async (item) => {
    const jsonPath = path.join(store.databaseDir, targetPath, item.dirName, 'description.json')
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
  let descriptionPath = path.join(store.databaseDir, path.join(dirPath, 'description.json'))
  let descriptionJson = await fs.readJSON(descriptionPath)
  descriptionJson.dirName = newName
  await fs.outputJson(descriptionPath, descriptionJson)
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

ipcMain.handle('delDir', async (e, targetPath) => {
  await fs.remove(path.join(store.databaseDir, targetPath))
})

ipcMain.handle('mkDir', async (e, descriptionJson, dirPath) => {
  await updateTargetDirSubdirOrder(path.join(store.databaseDir, dirPath), 0, 'after', 'plus')
  let targetPath = path.join(store.databaseDir, dirPath, descriptionJson.dirName)
  await fs.outputJson(path.join(targetPath, 'description.json'), descriptionJson)
})

ipcMain.handle('updateTargetDirSubdirOrderAdd', async (e, dirPath) => {
  await updateTargetDirSubdirOrder(path.join(store.databaseDir, dirPath), 0, 'after', 'plus')
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
