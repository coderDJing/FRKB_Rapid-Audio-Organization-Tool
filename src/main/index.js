import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, dirname } from 'path'
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
import layoutConfigFileUrl from '../../resources/config/layoutConfig.json?commonjs-external&asset&asarUnpack'
import settingConfigFileUrl from '../../resources/config/settingConfig.json?commonjs-external&asset&asarUnpack'
import analyseSongFingerprintPyScriptUrl from '../../resources/pyScript/analyseSongFingerprint/analyseSongFingerprint.exe?commonjs-external&asset&asarUnpack'
import { v4 as uuidv4 } from 'uuid'
import enUsUrl from '../renderer/src/language/enUS.json?commonjs-external&asset'
import zhCNUrl from '../renderer/src/language/zhCN.json?commonjs-external&asset'

const path = require('path')

let exeDir = ''
if (app.isPackaged) {
  let exePath = app.getPath('exe')
  exeDir = dirname(exePath)
} else {
  exeDir = __dirname
}

const log = require('electron-log')
log.transports.file.level = 'debug' // 设置日志级别
log.transports.file.format = '{y}-{m}-{d} {h}:{i}:{s}.{ms} {text}' // 自定义日志格式
log.transports.file.maxSize = 5 * 1024 * 1024 // 设置日志文件的最大大小，‌例如5MB
log.transports.file.resolvePathFn = () => join(exeDir, 'log.txt') // 指定日志文件的存储路径
process.on('uncaughtException', (error) => {
  log.error(error)
})

process.on('unhandledRejection', (reason, promise) => {
  log.error('Unhandled Rejection at:', promise, 'reason:', reason)
})

const { updateElectronApp } = require('update-electron-app')
updateElectronApp() //todo 自动升级功能待测试

const fs = require('fs-extra')

let layoutConfig = fs.readJSONSync(layoutConfigFileUrl)
let settingConfig = fs.readJSONSync(settingConfigFileUrl)
let enUS = fs.readJSONSync(enUsUrl)
let zhCN = fs.readJSONSync(zhCNUrl)
let languageDict = {
  enUS,
  zhCN
}
function t(str) {
  return languageDict[settingConfig.language][str]
}
let songFingerprintList = []
const libraryInit = async () => {
  let rootDescription = {
    uuid: uuidv4(),
    type: 'root',
    dirName: 'library',
    order: 1
  }
  await fs.outputJson(join(exeDir, 'library', 'description.json'), rootDescription)
  const makeLibrary = async (libraryPath, libraryName, order) => {
    let description = {
      uuid: uuidv4(),
      type: 'library',
      dirName: libraryName,
      order: order
    }
    await fs.outputJson(join(libraryPath, 'description.json'), description)
  }
  await makeLibrary(join(exeDir, 'library/筛选库'), '筛选库', 1)
  await makeLibrary(join(exeDir, 'library/精选库'), '精选库', 2)
  await fs.outputJSON(join(exeDir, 'songFingerprint', 'songFingerprint.json'), [])
}
let isLibraryExist = fs.pathExistsSync(join(exeDir, 'library', 'description.json'))
if (!isLibraryExist) {
  libraryInit()
} else {
  songFingerprintList = fs.readJSONSync(join(exeDir, 'songFingerprint', 'songFingerprint.json'))
}

function createWindow() {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: layoutConfig.mainWindowWidth, //默认应为900
    height: layoutConfig.mainWindowHeight, //默认应为600
    minWidth: 900,
    minHeight: 600,
    frame: false,
    transparent: false,
    show: false,
    backgroundColor: '#181818',

    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  mainWindow.openDevTools() //todo del
  mainWindow.on('ready-to-show', () => {
    if (layoutConfig.isMaxMainWin) {
      mainWindow.maximize()
    }
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.webContents.send('mainWin-max', true)
    } else {
      mainWindow.webContents.send('mainWin-max', false)
    }
    mainWindow.webContents.send('layoutConfigReaded', layoutConfig)
  })

  ipcMain.on('layoutConfigChanged', (e, layoutConfig) => {
    fs.outputJson(layoutConfigFileUrl, JSON.parse(layoutConfig))
  })
  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('mainWin-max', true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('mainWin-max', false)
  })

  let mainWindowWidth = layoutConfig.mainWindowWidth
  let mainWindowHeight = layoutConfig.mainWindowHeight
  mainWindow.on('resized', (e) => {
    let size = mainWindow.getSize()
    mainWindowWidth = size[0]
    mainWindowHeight = size[1]
  })
  ipcMain.on('toggle-maximize', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
  })

  ipcMain.on('toggle-minimize', () => {
    mainWindow.minimize()
  })

  ipcMain.on('toggle-close', async () => {
    let layoutConfig = fs.readJSONSync(layoutConfigFileUrl)
    if (mainWindow.isMaximized()) {
      layoutConfig.isMaxMainWin = true
    } else {
      layoutConfig.isMaxMainWin = false
    }
    layoutConfig.mainWindowWidth = mainWindowWidth
    layoutConfig.mainWindowHeight = mainWindowHeight
    await fs.outputJson(layoutConfigFileUrl, layoutConfig)
    app.exit()
  })
  ipcMain.on('collapseButtonHandleClick', (e, libraryName) => {
    mainWindow.webContents.send('collapseButtonHandleClick', libraryName)
  })

  ipcMain.on('readSongFile', async (e, filePath) => {
    let file = await fs.readFile(filePath)
    mainWindow.webContents.send('readedSongFile', file)
  })
  ipcMain.handle('exportSongFingerprint', async (e, folderPath) => {
    await fs.copy(
      join(exeDir, 'songFingerprint', 'songFingerprint.json'),
      folderPath + '\\songFingerprint' + getCurrentTimeYYYYMMDDHHMMSSSSS() + '.json'
    )
  })
  ipcMain.handle('importSongFingerprint', async (e, filePath) => {
    let json = await fs.readJSON(filePath)
    songFingerprintList = songFingerprintList.concat(json)
    songFingerprintList = [...new Set(songFingerprintList)]
    fs.outputJSON(join(exeDir, 'songFingerprint', 'songFingerprint.json'), songFingerprintList)
    return
  })
  ipcMain.on('addSongFingerprint', async (e, folderPath) => {
    mainWindow.webContents.send('progressSet', t('扫描文件中'), 0, 1, true)
    let songFileUrls = []
    const promises = []
    for (let item of folderPath) {
      promises.push(collectFilesWithExtensions(item, ['.mp3', '.wav', '.flac']))
    }
    let res = await Promise.all(promises)
    songFileUrls = res.flat(1)
    mainWindow.webContents.send('progressSet', t('扫描文件中'), 1, 1, true)
    let processNum = 0
    let fingerprintResults = []
    let fingerprintErrorResults = []
    mainWindow.webContents.send(
      'progressSet',
      t('分析声音指纹初始化'),
      processNum,
      songFileUrls.length
    )
    const endHandle = () => {
      processNum++
      mainWindow.webContents.send(
        'progressSet',
        t('分析声音指纹中'),
        processNum,
        songFileUrls.length
      )
    }
    let { result, errorResult } = await executeScript(
      analyseSongFingerprintPyScriptUrl,
      [folderPath.join('|'), ['.mp3', '.wav', '.flac'].join(',')],
      endHandle
    )
    mainWindow.webContents.send(
      'progressSet',
      t('分析声音指纹中'),
      songFileUrls.length,
      songFileUrls.length
    )
    fingerprintResults = result
    fingerprintErrorResults = errorResult
    let map = new Map()
    for (let item of fingerprintResults) {
      if (songFingerprintList.indexOf(item.md5_hash) === -1) {
        map.set(item.md5_hash, item.md5_hash)
      }
    }
    let removeDuplicatesFingerprintResults = Array.from(map.values())
    songFingerprintList = songFingerprintList.concat(removeDuplicatesFingerprintResults)
    fs.outputJSON(join(exeDir, 'songFingerprint', 'songFingerprint.json'), songFingerprintList)
    let contentArr = [
      t('文件夹下共扫描曲目：') + songFileUrls.length,
      t('比对声音指纹去除重复曲目：') +
        (songFileUrls.length -
          removeDuplicatesFingerprintResults.length -
          fingerprintErrorResults.length),
      t('声音指纹库新增：') + removeDuplicatesFingerprintResults.length,
      t('声音指纹库现有：') + songFingerprintList.length
    ]
    if (fingerprintErrorResults.length) {
      contentArr.splice(
        1,
        0,
        t('尝试分析失败：') +
          fingerprintErrorResults.length +
          t('（通常由于文件内容损坏或传输过程发生错误）')
      )
    }
    mainWindow.webContents.send('addSongFingerprintFinished', contentArr)
  })

  ipcMain.handle(
    'exportSongListToDir',
    async (e, folderPathVal, deleteSongsAfterExport, dirPath) => {
      let scanPath = join(exeDir, dirPath)
      let songFileUrls = await collectFilesWithExtensions(scanPath, ['.mp3', '.wav', '.flac'])
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
    }
  )

  ipcMain.handle('exportSongsToDir', async (e, folderPathVal, deleteSongsAfterExport, songs) => {
    const promises = []
    for (let item of songs) {
      let targetPath = folderPathVal + '\\' + item.filePath.match(/[^\\]+$/)[0]
      promises.push(
        moveOrCopyItemWithCheckIsExist(item.filePath, targetPath, deleteSongsAfterExport)
      )
    }
    await Promise.all(promises)
    return
  })

  ipcMain.handle('getSetting', () => {
    return settingConfig
  })
  ipcMain.handle('setSetting', (e, setting) => {
    settingConfig = setting
    fs.outputJson(settingConfigFileUrl, setting)
  })
  ipcMain.handle('moveSongsToDir', async (e, srcs, dest) => {
    const moveSongToDir = async (src, dest) => {
      let targetPath = join(exeDir, dest, src.match(/[^\\]+$/)[0])
      await moveOrCopyItemWithCheckIsExist(src, targetPath, true)
    }
    const promises = []
    for (let src of srcs) {
      promises.push(moveSongToDir(src, dest))
    }
    await Promise.all(promises)
    return
  })

  ipcMain.on('outputLog', (e, logMsg) => {
    log.error(logMsg)
  })
  ipcMain.on('startImportDragSongs', async (e, formData) => {
    let songFileUrls = []
    let dirArr = []
    mainWindow.webContents.send('progressSet', t('扫描文件中'), 0, 1, true)
    for (const p of formData.filePaths) {
      try {
        const stats = await fs.stat(p)
        if (stats.isDirectory()) {
          dirArr.push(p)
        } else if (stats.isFile()) {
          const ext = path.extname(p).toLowerCase()
          if (['.mp3', '.wav', '.flac'].includes(ext)) {
            songFileUrls.push(p)
          }
        }
      } catch (err) {
        console.error(`Error accessing path: ${p}`, err)
      }
    }
    let audioFiles = []
    const promises = []
    for (let item of dirArr) {
      promises.push(collectFilesWithExtensions(item, ['.mp3', '.wav', '.flac']))
    }
    let res = await Promise.all(promises)
    audioFiles = res.flat(1)
    songFileUrls = songFileUrls.concat(audioFiles)
    mainWindow.webContents.send('progressSet', t('扫描文件中'), 1, 1, true)
    if (songFileUrls.length === 0) {
      mainWindow.webContents.send('importFinished', [t('未扫描到音频文件')], formData.songListUUID)
      return
    }
    let processNum = 0
    let fingerprintResults = []
    let fingerprintErrorResults = []
    let delList = []
    let songFingerprintListLengthBefore = songFingerprintList.length
    let importSongsCount = 0
    async function moveSong() {
      importSongsCount = songFileUrls.length
      processNum = 0
      mainWindow.webContents.send(
        'progressSet',
        formData.isDeleteSourceFile ? t('移动曲目') : t('复制曲目'),
        processNum,
        songFileUrls.length
      )
      for (let songFileUrl of songFileUrls) {
        let targetPath = join(exeDir, formData.songListPath, songFileUrl.match(/[^\\]+$/)[0])
        await moveOrCopyItemWithCheckIsExist(songFileUrl, targetPath, formData.isDeleteSourceFile)
        processNum++
        mainWindow.webContents.send(
          'progressSet',
          formData.isDeleteSourceFile ? t('移动曲目') : t('复制曲目'),
          processNum,
          songFileUrls.length
        )
      }
    }

    async function analyseSongFingerprint() {
      mainWindow.webContents.send(
        'progressSet',
        t('分析声音指纹初始化'),
        processNum,
        songFileUrls.length,
        true
      )
      processNum = 0
      const endHandle = () => {
        processNum++
        mainWindow.webContents.send(
          'progressSet',
          t('分析声音指纹中'),
          processNum,
          songFileUrls.length,
          false
        )
      }
      let { result, errorResult } = await executeScript(
        analyseSongFingerprintPyScriptUrl,
        [songFileUrls.join('|'), ['.mp3', '.wav', '.flac'].join(',')],
        endHandle
      )
      mainWindow.webContents.send(
        'progressSet',
        t('分析声音指纹中'),
        songFileUrls.length,
        songFileUrls.length
      )
      fingerprintResults = result
      fingerprintErrorResults = errorResult
    }

    if (!formData.isComparisonSongFingerprint && !formData.isPushSongFingerprintLibrary) {
      //既不比对，也不加入指纹库
      await moveSong()
    } else if (formData.isComparisonSongFingerprint) {
      //比对声音指纹
      await analyseSongFingerprint()

      let toBeRemoveDuplicates = []
      for (let item of fingerprintResults) {
        if (songFingerprintList.indexOf(item.md5_hash) != -1) {
          delList.push(item.path)
        } else {
          toBeRemoveDuplicates.push(item)
        }
      }
      let map = new Map()
      let duplicates = []
      // 待去重数组（本地导入的曲包内部去重）
      toBeRemoveDuplicates.forEach((item) => {
        if (map.has(item.md5_hash)) {
          duplicates.push(item.path)
        } else {
          map.set(item.md5_hash, item)
        }
      })
      delList = delList.concat(duplicates) //待删数组
      let toBeDealSongs = Array.from(map.values())
      processNum = 0
      mainWindow.webContents.send(
        'progressSet',
        formData.isDeleteSourceFile ? t('移动曲目') : t('复制曲目'),
        processNum,
        toBeDealSongs.length
      )
      importSongsCount = toBeDealSongs.length
      for (let item of toBeDealSongs) {
        if (formData.isPushSongFingerprintLibrary) {
          songFingerprintList.push(item.md5_hash)
        }
        let targetPath = join(exeDir, formData.songListPath, item.path.match(/[^\\]+$/)[0])
        await moveOrCopyItemWithCheckIsExist(item.path, targetPath, formData.isDeleteSourceFile)
        processNum++
        mainWindow.webContents.send(
          'progressSet',
          formData.isDeleteSourceFile ? t('移动曲目') : t('复制曲目'),
          processNum,
          toBeDealSongs.length
        )
      }
      if (formData.isDeleteSourceFile) {
        processNum = 0
        mainWindow.webContents.send('progressSet', t('删除重复曲目'), processNum, delList.length)
        for (let item of delList) {
          fs.remove(item)
          processNum++
          mainWindow.webContents.send('progressSet', t('删除重复曲目'), processNum, delList.length)
        }
      }
      if (formData.isPushSongFingerprintLibrary) {
        fs.outputJSON(join(exeDir, 'songFingerprint', 'songFingerprint.json'), songFingerprintList)
      }
    } else if (!formData.isComparisonSongFingerprint && formData.isPushSongFingerprintLibrary) {
      //不比对声音指纹，仅加入指纹库
      await analyseSongFingerprint()
      for (let item of fingerprintResults) {
        if (songFingerprintList.indexOf(item.md5_hash) == -1) {
          songFingerprintList.push(item.md5_hash)
        }
      }
      fs.outputJSON(join(exeDir, 'songFingerprint', 'songFingerprint.json'), songFingerprintList)
      await moveSong()
    }
    let contentArr = [t('文件夹下共扫描曲目：') + songFileUrls.length]
    if (
      fingerprintErrorResults.length &&
      (formData.isComparisonSongFingerprint || formData.isPushSongFingerprintLibrary)
    ) {
      contentArr.push(
        t('尝试分析失败：') +
          fingerprintErrorResults.length +
          t('（通常由于文件内容损坏或传输过程发生错误）')
      )
    }
    contentArr.push(t('歌单共导入曲目：') + importSongsCount)
    if (formData.isComparisonSongFingerprint) {
      contentArr.push(t('比对声音指纹去除重复曲目：') + delList.length)
    }
    if (formData.isPushSongFingerprintLibrary) {
      contentArr.push(
        t('声音指纹库新增：') + (songFingerprintList.length - songFingerprintListLengthBefore)
      )
      if (
        !formData.isComparisonSongFingerprint &&
        fingerprintResults.length != songFingerprintList.length - songFingerprintListLengthBefore
      ) {
        let notPushFingerprintLibraryCount =
          fingerprintResults.length - (songFingerprintList.length - songFingerprintListLengthBefore)
        contentArr.push(
          t('未添加声音指纹：') + notPushFingerprintLibraryCount + t('（因为已存在于声音指纹库中）')
        )
      }
    }
    contentArr.push(t('声音指纹库现有：') + songFingerprintList.length)
    mainWindow.webContents.send('importFinished', contentArr, formData.songListUUID)
    return
  })
  ipcMain.on('startImportSongs', async (e, formData, songListUUID) => {
    formData.songListPath = join(exeDir, formData.songListPath)
    mainWindow.webContents.send('progressSet', t('扫描文件中'), 0, 1, true)
    let songFileUrls = []
    const promises = []
    for (let item of formData.folderPath) {
      promises.push(collectFilesWithExtensions(item, ['.mp3', '.wav', '.flac']))
    }
    let res = await Promise.all(promises)
    songFileUrls = res.flat(1)
    mainWindow.webContents.send('progressSet', t('扫描文件中'), 1, 1, true)
    if (songFileUrls.length === 0) {
      mainWindow.webContents.send('importFinished', [t('未扫描到音频文件')], songListUUID)
      return
    }
    let processNum = 0
    let fingerprintResults = []
    let fingerprintErrorResults = []
    let delList = []
    let songFingerprintListLengthBefore = songFingerprintList.length
    let importSongsCount = 0
    async function moveSong() {
      importSongsCount = songFileUrls.length
      processNum = 0
      mainWindow.webContents.send(
        'progressSet',
        formData.isDeleteSourceFile ? t('移动曲目') : t('复制曲目'),
        processNum,
        songFileUrls.length
      )
      for (let songFileUrl of songFileUrls) {
        let targetPath = join(formData.songListPath, songFileUrl.match(/[^\\]+$/)[0])
        await moveOrCopyItemWithCheckIsExist(songFileUrl, targetPath, formData.isDeleteSourceFile)
        processNum++
        mainWindow.webContents.send(
          'progressSet',
          formData.isDeleteSourceFile ? t('移动曲目') : t('复制曲目'),
          processNum,
          songFileUrls.length
        )
      }
    }

    async function analyseSongFingerprint() {
      mainWindow.webContents.send(
        'progressSet',
        t('分析声音指纹初始化'),
        processNum,
        songFileUrls.length,
        true
      )
      processNum = 0
      const endHandle = () => {
        processNum++
        mainWindow.webContents.send(
          'progressSet',
          t('分析声音指纹中'),
          processNum,
          songFileUrls.length,
          false
        )
      }
      let { result, errorResult } = await executeScript(
        analyseSongFingerprintPyScriptUrl,
        [formData.folderPath.join('|'), ['.mp3', '.wav', '.flac'].join(',')],
        endHandle
      )
      mainWindow.webContents.send(
        'progressSet',
        t('分析声音指纹中'),
        songFileUrls.length,
        songFileUrls.length
      )
      fingerprintResults = result
      fingerprintErrorResults = errorResult
    }

    if (!formData.isComparisonSongFingerprint && !formData.isPushSongFingerprintLibrary) {
      //既不比对，也不加入指纹库
      await moveSong()
    } else if (formData.isComparisonSongFingerprint) {
      //比对声音指纹
      await analyseSongFingerprint()

      let toBeRemoveDuplicates = []
      for (let item of fingerprintResults) {
        if (songFingerprintList.indexOf(item.md5_hash) != -1) {
          delList.push(item.path)
        } else {
          toBeRemoveDuplicates.push(item)
        }
      }
      let map = new Map()
      let duplicates = []
      // 待去重数组（本地导入的曲包内部去重）
      toBeRemoveDuplicates.forEach((item) => {
        if (map.has(item.md5_hash)) {
          duplicates.push(item.path)
        } else {
          map.set(item.md5_hash, item)
        }
      })
      delList = delList.concat(duplicates) //待删数组
      let toBeDealSongs = Array.from(map.values())
      processNum = 0
      mainWindow.webContents.send(
        'progressSet',
        formData.isDeleteSourceFile ? t('移动曲目') : t('复制曲目'),
        processNum,
        toBeDealSongs.length
      )
      importSongsCount = toBeDealSongs.length
      for (let item of toBeDealSongs) {
        if (formData.isPushSongFingerprintLibrary) {
          songFingerprintList.push(item.md5_hash)
        }
        let targetPath = join(formData.songListPath, item.path.match(/[^\\]+$/)[0])
        await moveOrCopyItemWithCheckIsExist(item.path, targetPath, formData.isDeleteSourceFile)
        processNum++
        mainWindow.webContents.send(
          'progressSet',
          formData.isDeleteSourceFile ? t('移动曲目') : t('复制曲目'),
          processNum,
          toBeDealSongs.length
        )
      }
      if (formData.isDeleteSourceFile) {
        processNum = 0
        mainWindow.webContents.send('progressSet', t('删除重复曲目'), processNum, delList.length)
        for (let item of delList) {
          fs.remove(item)
          processNum++
          mainWindow.webContents.send('progressSet', t('删除重复曲目'), processNum, delList.length)
        }
      }
      if (formData.isPushSongFingerprintLibrary) {
        fs.outputJSON(join(exeDir, 'songFingerprint', 'songFingerprint.json'), songFingerprintList)
      }
    } else if (!formData.isComparisonSongFingerprint && formData.isPushSongFingerprintLibrary) {
      //不比对声音指纹，仅加入指纹库
      await analyseSongFingerprint()
      for (let item of fingerprintResults) {
        if (songFingerprintList.indexOf(item.md5_hash) == -1) {
          songFingerprintList.push(item.md5_hash)
        }
      }
      fs.outputJSON(join(exeDir, 'songFingerprint', 'songFingerprint.json'), songFingerprintList)
      await moveSong()
    }
    let contentArr = [t('文件夹下共扫描曲目：') + songFileUrls.length]
    if (
      fingerprintErrorResults.length &&
      (formData.isComparisonSongFingerprint || formData.isPushSongFingerprintLibrary)
    ) {
      contentArr.push(
        t('尝试分析失败：') +
          fingerprintErrorResults.length +
          t('（通常由于文件内容损坏或传输过程发生错误）')
      )
    }
    contentArr.push(t('歌单共导入曲目：') + importSongsCount)
    if (formData.isComparisonSongFingerprint) {
      contentArr.push(t('比对声音指纹去除重复曲目：') + delList.length)
    }
    if (formData.isPushSongFingerprintLibrary) {
      contentArr.push(
        t('声音指纹库新增：') + (songFingerprintList.length - songFingerprintListLengthBefore)
      )
      if (
        !formData.isComparisonSongFingerprint &&
        fingerprintResults.length != songFingerprintList.length - songFingerprintListLengthBefore
      ) {
        let notPushFingerprintLibraryCount =
          fingerprintResults.length - (songFingerprintList.length - songFingerprintListLengthBefore)
        contentArr.push(
          t('未添加声音指纹：') + notPushFingerprintLibraryCount + t('（因为已存在于声音指纹库中）')
        )
      }
    }
    contentArr.push(t('声音指纹库现有：') + songFingerprintList.length)
    mainWindow.webContents.send('importFinished', contentArr, songListUUID)
    return
  })
  mainWindow.on('blur', () => {
    mainWindow.webContents.send('mainWindowBlur')
  })
}

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

ipcMain.handle('scanSongList', async (e, songListPath, songListUUID) => {
  let scanPath = join(exeDir, songListPath)
  const mm = await import('music-metadata')
  let songInfoArr = []
  let songFileUrls = await collectFilesWithExtensions(scanPath, ['.mp3', '.wav', '.flac'])

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
  let subDirArr = JSON.parse(subDirArrJson)
  const promises = []
  const changeOrder = async (item) => {
    let jsonPath = join(exeDir, targetPath, item.dirName, 'description.json')
    let json = await fs.readJSON(jsonPath)
    if (json.order != item.order) {
      json.order = item.order
      await fs.outputJSON(jsonPath, json)
    }
  }
  for (let item of subDirArr) {
    promises.push(changeOrder(item))
  }
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
    let json = await fs.readJSON(result.filePaths[0])
    if (Array.isArray(json)) {
      for (let item of json) {
        if (typeof item !== 'string') {
          return 'error'
        }
      }
      return result.filePaths
    } else {
      return 'error'
    }
  } catch (error) {
    return 'error'
  }
})
// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  console.log('window-all-closed')
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app"s specific main process
// code. You can also put them in separate files and require them here.
