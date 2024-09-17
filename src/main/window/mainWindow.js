import { app, shell, BrowserWindow, ipcMain, globalShortcut } from 'electron'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import {
  collectFilesWithExtensions,
  executeScript,
  moveOrCopyItemWithCheckIsExist,
  getSongsAnalyseResult
} from '../utils.js'
// import analyseSongFingerprintPyScriptUrl from '../../../resources/pyScript/analyseSongFingerprint/analyseSongFingerprint.exe?commonjs-external&asset&asarUnpack'
import { t } from '../translate.js'
import store from '../store.js'
import url from '../url.js'

const path = require('path')
const fs = require('fs-extra')

let mainWindow = null
function createWindow() {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: store.layoutConfig.mainWindowWidth, //默认应为900
    height: store.layoutConfig.mainWindowHeight, //默认应为600
    minWidth: 900,
    minHeight: 600,
    frame: false,
    transparent: false,
    show: false,
    backgroundColor: '#181818',

    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  if (!app.isPackaged) {
    mainWindow.openDevTools()
  }

  mainWindow.on('ready-to-show', () => {
    if (store.layoutConfig.isMaxMainWin) {
      mainWindow.maximize()
    }
    mainWindow.show()
    globalShortcut.register(store.settingConfig.globalCallShortcut, () => {
      if (!mainWindow.isFocused()) {
        if (mainWindow.isMinimized()) {
          mainWindow.restore()
        }
        mainWindow.focus()
      } else {
        mainWindow.minimize()
      }
    })
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
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.webContents.send('mainWin-max', true)
    } else {
      mainWindow.webContents.send('mainWin-max', false)
    }
    mainWindow.webContents.send('layoutConfigReaded', store.layoutConfig)
  })

  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('mainWin-max', true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('mainWin-max', false)
  })

  let mainWindowWidth = store.layoutConfig.mainWindowWidth
  let mainWindowHeight = store.layoutConfig.mainWindowHeight
  mainWindow.on('resized', (e) => {
    let size = mainWindow.getSize()
    mainWindowWidth = size[0]
    mainWindowHeight = size[1]
  })

  mainWindow.on('blur', () => {
    mainWindow.webContents.send('mainWindowBlur')
  })
  mainWindow.on('closed', () => {
    ipcMain.removeHandler('toggle-maximize')
    ipcMain.removeHandler('toggle-minimize')
    ipcMain.removeHandler('toggle-close')
    ipcMain.removeHandler('collapseButtonHandleClick')
    ipcMain.removeHandler('readSongFile')
    ipcMain.removeHandler('addSongFingerprint')
    ipcMain.removeHandler('startImportDragSongs')
    ipcMain.removeHandler('startImportSongs')
    ipcMain.removeHandler('changeGlobalShortcut')
    globalShortcut.unregister(store.settingConfig.globalCallShortcut)
    mainWindow = null
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
    let layoutConfig = fs.readJSONSync(url.layoutConfigFileUrl)
    if (mainWindow.isMaximized()) {
      layoutConfig.isMaxMainWin = true
    } else {
      layoutConfig.isMaxMainWin = false
    }
    layoutConfig.mainWindowWidth = mainWindowWidth
    layoutConfig.mainWindowHeight = mainWindowHeight
    await fs.outputJson(url.layoutConfigFileUrl, layoutConfig)
    app.exit()
  })
  ipcMain.on('collapseButtonHandleClick', (e, libraryName) => {
    mainWindow.webContents.send('collapseButtonHandleClick', libraryName)
  })

  ipcMain.on('readSongFile', async (e, filePath) => {
    let file = await fs.readFile(filePath)
    mainWindow.webContents.send('readedSongFile', file)
  })

  ipcMain.on('addSongFingerprint', async (e, folderPath) => {
    const sendProgress = (message, current, total, isInitial = false) => {
      mainWindow.webContents.send('progressSet', t(message), current, total, isInitial)
    }

    // 扫描文件
    sendProgress('扫描文件中', 0, 1, true)
    const songFileUrls = (
      await Promise.all(
        folderPath.map((item) => collectFilesWithExtensions(item, store.settingConfig.audioExt))
      )
    ).flat()
    sendProgress('扫描文件中', 1, 1)

    // 分析声音指纹
    let processNum = 0
    sendProgress('分析声音指纹初始化', processNum, songFileUrls.length)
    const { songsAnalyseResult, errorSongsAnalyseResult } = await getSongsAnalyseResult(
      songFileUrls,
      (resultLength) => {
        sendProgress('分析声音指纹中', resultLength, songFileUrls.length)
      }
    )
    sendProgress('分析声音指纹中', songFileUrls.length, songFileUrls.length)

    // 去重处理
    const uniqueFingerprints = new Set(songsAnalyseResult.map((item) => item.md5_hash))
    const removeDuplicatesFingerprintResults = [...uniqueFingerprints]
    store.songFingerprintList = [
      ...new Set([...store.songFingerprintList, ...removeDuplicatesFingerprintResults])
    ]

    // 保存结果
    fs.outputJSON(
      path.join(store.databaseDir, 'songFingerprint', 'songFingerprint.json'),
      store.songFingerprintList
    )

    // 构建反馈信息//todo 反馈信息有问题
    const contentArr = [
      `${t('文件夹下共扫描曲目：')} ${songFileUrls.length}`,
      `${t('比对声音指纹去除重复曲目：')} ${songFileUrls.length - removeDuplicatesFingerprintResults.length - errorSongsAnalyseResult.length}`,
      `${t('声音指纹库新增：')} ${removeDuplicatesFingerprintResults.length}`,
      `${t('声音指纹库现有：')} ${store.songFingerprintList.length}`
    ]

    if (errorSongsAnalyseResult.length) {
      contentArr.splice(
        1,
        0,
        `${t('尝试分析失败：')} ${errorSongsAnalyseResult.length} ${t('（通常由于文件内容损坏或传输过程发生错误）')}`
      )
    }

    mainWindow.webContents.send('addSongFingerprintFinished', contentArr)
  })

  async function importSongsHandler(event, formData, songListUUID) {
    const sendProgress = (message, current, total, isInitial = false) => {
      mainWindow.webContents.send('progressSet', message, current, total, isInitial)
    }
    let songFileUrls = []
    let dirArr = []
    sendProgress(t('扫描文件中'), 0, 1, true)
    // 根据不同的事件类型获取文件路径
    const filePaths = formData.filePaths || formData.folderPath
    for (const p of filePaths) {
      try {
        const stats = await fs.stat(p)
        if (stats.isDirectory()) {
          dirArr.push(p)
        } else if (stats.isFile()) {
          const ext = path.extname(p).toLowerCase()
          if (store.settingConfig.audioExt.includes(ext)) {
            songFileUrls.push(p)
          }
        }
      } catch (err) {
        console.error(`Error accessing path: ${p}`, err)
      }
    }
    let audioFiles = []
    const promises = dirArr.map((item) =>
      collectFilesWithExtensions(item, store.settingConfig.audioExt)
    )
    audioFiles = (await Promise.all(promises)).flat(1)
    songFileUrls = songFileUrls.concat(audioFiles)
    sendProgress(t('扫描文件中'), 1, 1, true)
    if (songFileUrls.length === 0) {
      sendProgress([t('未扫描到音频文件')], songListUUID || formData.songListUUID)
      return
    }
    let processNum = 0
    let fingerprintResults = []
    let fingerprintErrorResults = []
    let delList = []
    let songFingerprintListLengthBefore = store.songFingerprintList.length
    let importSongsCount = 0
    async function moveSong() {
      importSongsCount = songFileUrls.length
      processNum = 0
      sendProgress(
        formData.isDeleteSourceFile ? t('移动曲目') : t('复制曲目'),
        processNum,
        songFileUrls.length
      )
      for (let songFileUrl of songFileUrls) {
        let targetPath = path.join(
          store.databaseDir,
          formData.songListPath,
          songFileUrl.match(/[^\\]+$/)[0]
        )
        await moveOrCopyItemWithCheckIsExist(songFileUrl, targetPath, formData.isDeleteSourceFile)
        processNum++
        sendProgress(
          formData.isDeleteSourceFile ? t('移动曲目') : t('复制曲目'),
          processNum,
          songFileUrls.length
        )
      }
    }
    async function analyseSongFingerprint() {
      sendProgress(t('分析声音指纹初始化'), processNum, songFileUrls.length, true)
      processNum = 0
      const endHandle = () => {
        processNum++
        sendProgress(t('分析声音指纹中'), processNum, songFileUrls.length, false)
      }
      let scriptArgs = formData.filePaths
        ? [songFileUrls.join('|')]
        : [formData.folderPath.join('|')]
      let { result, errorResult } = await executeScript(
        url.analyseSongPyScriptUrl,
        [...scriptArgs, store.settingConfig.audioExt.join(',')],
        endHandle
      )
      sendProgress(t('分析声音指纹中'), songFileUrls.length, songFileUrls.length)
      fingerprintResults = result
      fingerprintErrorResults = errorResult
    }
    if (!formData.isComparisonSongFingerprint && !formData.isPushSongFingerprintLibrary) {
      await moveSong()
    } else if (formData.isComparisonSongFingerprint) {
      await analyseSongFingerprint()
      let toBeRemoveDuplicates = []
      for (let item of fingerprintResults) {
        if (store.songFingerprintList.includes(item.md5_hash)) {
          delList.push(item.path)
        } else {
          toBeRemoveDuplicates.push(item)
        }
      }
      let map = new Map()
      let duplicates = []
      toBeRemoveDuplicates.forEach((item) => {
        if (map.has(item.md5_hash)) {
          duplicates.push(item.path)
        } else {
          map.set(item.md5_hash, item)
        }
      })
      delList = delList.concat(duplicates)
      let toBeDealSongs = Array.from(map.values())
      processNum = 0
      sendProgress(
        formData.isDeleteSourceFile ? t('移动曲目') : t('复制曲目'),
        processNum,
        toBeDealSongs.length
      )
      importSongsCount = toBeDealSongs.length
      for (let item of toBeDealSongs) {
        if (formData.isPushSongFingerprintLibrary) {
          store.songFingerprintList.push(item.md5_hash)
        }
        let targetPath = path.join(
          store.databaseDir,
          formData.songListPath,
          item.path.match(/[^\\]+$/)[0]
        )
        await moveOrCopyItemWithCheckIsExist(item.path, targetPath, formData.isDeleteSourceFile)
        processNum++
        sendProgress(
          formData.isDeleteSourceFile ? t('移动曲目') : t('复制曲目'),
          processNum,
          toBeDealSongs.length
        )
      }
      if (formData.isDeleteSourceFile) {
        processNum = 0
        sendProgress(t('删除重复曲目'), processNum, delList.length)
        for (let item of delList) {
          fs.remove(item)
          processNum++
          sendProgress(t('删除重复曲目'), processNum, delList.length)
        }
      }
      if (formData.isPushSongFingerprintLibrary) {
        fs.outputJSON(
          path.join(store.databaseDir, 'songFingerprint', 'songFingerprint.json'),
          store.songFingerprintList
        )
      }
    } else if (!formData.isComparisonSongFingerprint && formData.isPushSongFingerprintLibrary) {
      await analyseSongFingerprint()
      for (let item of fingerprintResults) {
        if (!store.songFingerprintList.includes(item.md5_hash)) {
          store.songFingerprintList.push(item.md5_hash)
        }
      }
      fs.outputJSON(
        path.join(store.databaseDir, 'songFingerprint', 'songFingerprint.json'),
        store.songFingerprintList
      )
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
        t('声音指纹库新增：') + (store.songFingerprintList.length - songFingerprintListLengthBefore)
      )
      if (
        !formData.isComparisonSongFingerprint &&
        fingerprintResults.length !==
          store.songFingerprintList.length - songFingerprintListLengthBefore
      ) {
        let notPushFingerprintLibraryCount =
          fingerprintResults.length -
          (store.songFingerprintList.length - songFingerprintListLengthBefore)
        contentArr.push(
          t('未添加声音指纹：') + notPushFingerprintLibraryCount + t('（因为已存在于声音指纹库中）')
        )
      }
    }
    contentArr.push(t('声音指纹库现有：') + store.songFingerprintList.length)
    mainWindow.webContents.send('importFinished', contentArr, songListUUID || formData.songListUUID)
  }

  ipcMain.on('startImportDragSongs', async (e, formData) => {
    await importSongsHandler(e, formData)
  })

  ipcMain.on('startImportSongs', async (e, formData, songListUUID) => {
    await importSongsHandler(e, formData, songListUUID)
  })

  ipcMain.handle('changeGlobalShortcut', (e, shortCutValue) => {
    let ret = globalShortcut.register(shortCutValue, () => {
      if (!mainWindow.isFocused()) {
        if (mainWindow.isMinimized()) {
          mainWindow.restore()
        }
        mainWindow.focus()
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
}

export default {
  instance: mainWindow,
  createWindow
}
