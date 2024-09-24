import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import {
  updateTargetDirSubdirOrder,
  getLibrary,
  collectFilesWithExtensions,
  getCurrentTimeYYYYMMDDHHMMSSSSS
} from './utils.js'
import { log } from './log.js'
import url from './url.js'
import mainWindow from './window/mainWindow.js'
import databaseInitWindow from './window/databaseInitWindow.js'
import { languageDict } from './translate.js'
import { is } from '@electron-toolkit/utils'
import store from './store.js'
import './update.js'

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  process.kill(child.pid)
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
//todo 主进程退出 子进程没有正常退出 待解决
const { spawn } = require('child_process')
const child = spawn(url.analyseSongPyScriptUrl, {
  stdio: ['inherit', 'pipe', 'pipe'], // 继承stdin，pipe stdout和stderr到Node.js
  windowsHide: true
})

child.stdout.on('data', (data) => {
  try {
    const parsedData = JSON.parse(data.toString())
    if (parsedData.port) {
      store.analyseSongPort = parsedData.port
    } else {
      log.error(data.toString())
    }
  } catch (error) {
    log.error(data.toString())
  }
})

child.stderr.on('data', (data) => {
  log.error(data.toString())
})

child.on('error', (err) => {
  log.error(err)
})

child.on('close', (code) => {
  log.error(code)
})

const path = require('path')
const fs = require('fs-extra')
const platform = process.platform
if (!fs.pathExistsSync(url.layoutConfigFileUrl)) {
  fs.outputJsonSync(url.layoutConfigFileUrl, {
    libraryAreaWidth: 175,
    isMaxMainWin: false,
    mainWindowWidth: 900,
    mainWindowHeight: 600
  })
  fs.outputJsonSync(url.settingConfigFileUrl, {
    language: is.dev ? 'zhCN' : '',
    audioExt: ['.mp3', '.wav', '.flac'],
    databaseUrl: is.dev ? 'D:\\FRKB\\FRKB_database' : '',
    globalCallShortcut:
      platform === 'win32' ? 'Ctrl+Alt+F' : platform === 'darwin' ? 'Command+Option+F' : ''
  })
}

store.layoutConfig = fs.readJSONSync(url.layoutConfigFileUrl)
store.settingConfig = fs.readJSONSync(url.settingConfigFileUrl)


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
  console.log(111)
  process.kill(child.pid)
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

ipcMain.on('layoutConfigChanged', (e, layoutConfig) => {
  fs.outputJson(url.layoutConfigFileUrl, JSON.parse(layoutConfig))
})

ipcMain.handle('exportSongFingerprint', async (e, folderPath) => {
  await fs.copy(
    path.join(store.databaseDir, 'songFingerprint', 'songFingerprint.json'),
    folderPath + '\\songFingerprint' + getCurrentTimeYYYYMMDDHHMMSSSSS() + '.json'
  )
})

ipcMain.handle('importSongFingerprint', async (e, filePath) => {
  let json = await fs.readJSON(filePath)
  store.songFingerprintList = store.songFingerprintList.concat(json)
  store.songFingerprintList = [...new Set(store.songFingerprintList)]
  fs.outputJSON(
    path.join(store.databaseDir, 'songFingerprint', 'songFingerprint.json'),
    store.songFingerprintList
  )
  return
})

ipcMain.handle('exportSongListToDir', async (e, folderPathVal, deleteSongsAfterExport, dirPath) => {
  let scanPath = join(store.databaseDir, dirPath)
  let songFileUrls = await collectFilesWithExtensions(scanPath, store.settingConfig.audioExt)
  let folderName = dirPath.split('/')[dirPath.split('/').length - 1]
  async function findUniqueFolder(inputFolderPath) {
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
    promises.push(
      moveOrCopyItemWithCheckIsExist(
        item,
        targetPath + '\\' + item.match(/[^\\]+$/)[0],
        deleteSongsAfterExport
      )
    )
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
  const moveSongToDir = async (src, dest) => {
    let targetPath = path.join(store.databaseDir, dest, src.match(/[^\\]+$/)[0])
    await moveOrCopyItemWithCheckIsExist(src, targetPath, true)
  }
  const promises = []
  for (let src of srcs) {
    promises.push(moveSongToDir(src, dest))
  }
  await Promise.all(promises)
  return
})
