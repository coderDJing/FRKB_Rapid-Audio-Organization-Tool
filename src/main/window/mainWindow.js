import { app, shell, BrowserWindow, ipcMain, globalShortcut } from 'electron'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import {
  collectFilesWithExtensions,
  moveOrCopyItemWithCheckIsExist,
  getSongsAnalyseResult
} from '../utils.js'
import { t } from '../translate.js'
import store from '../store.js'
import url from '../url.js'
import updateWindow from './updateWindow.js'
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
    mainWindow?.close()
  })

  ipcMain.on('readSongFile', async (e, filePath) => {
    let file = await fs.readFile(filePath)
    const uint8Buffer = Uint8Array.from(file)
    mainWindow.webContents.send('readedSongFile', uint8Buffer)
  })
  const sendProgress = (message, current, total, isInitial = false) => {
    mainWindow?.webContents.send('progressSet', t(message), current, total, isInitial)
  }
  ipcMain.on('addSongFingerprint', async (e, folderPath) => {
    // 扫描文件
    sendProgress('扫描文件中', 0, 1, true)
    const songFileUrls = (
      await Promise.all(
        folderPath.map((item) => collectFilesWithExtensions(item, store.settingConfig.audioExt))
      )
    ).flat()
    sendProgress('扫描文件中', 1, 1)
    if (songFileUrls.length === 0) {
      mainWindow.webContents.send('noAudioFileWasScanned')
      return
    }
    // 分析声音指纹

    sendProgress('分析声音指纹初始化', 0, songFileUrls.length)
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
    let beforeSongFingerprintListLength = store.songFingerprintList.length
    store.songFingerprintList = [
      ...new Set([...store.songFingerprintList, ...removeDuplicatesFingerprintResults])
    ]

    // 保存结果
    fs.outputJSON(
      path.join(store.databaseDir, 'songFingerprint', 'songFingerprint.json'),
      store.songFingerprintList
    )

    // 构建反馈信息
    const contentArr = [
      `${t('文件夹下共扫描曲目：')} ${songFileUrls.length}`,
      `${t('比对声音指纹去除重复曲目：')} ${songFileUrls.length - (store.songFingerprintList.length - beforeSongFingerprintListLength) - errorSongsAnalyseResult.length}`,
      `${t('声音指纹库新增：')} ${store.songFingerprintList.length - beforeSongFingerprintListLength}`,
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

  ipcMain.on('startImportSongs', async (e, formData) => {
    sendProgress('扫描文件中', 0, 1, true)
    const filePaths = formData.filePaths || formData.folderPath
    let songFileUrls = (
      await Promise.all(
        filePaths.map((item) => collectFilesWithExtensions(item, store.settingConfig.audioExt))
      )
    ).flat()
    sendProgress('扫描文件中', 1, 1, true)
    if (songFileUrls.length === 0) {
      mainWindow.webContents.send('noAudioFileWasScanned')
      return
    }

    songFileUrls = [...new Set(songFileUrls)]
    let { isComparisonSongFingerprint, isPushSongFingerprintLibrary, isDeleteSourceFile } = formData
    let songFingerprintListLengthBefore = store.songFingerprintList.length
    let toBeDealSongs = []
    let delList = []
    let songsAnalyseResult = []
    let errorSongsAnalyseResult = []
    let alreadyExistInSongFingerprintList = new Set()
    if (isComparisonSongFingerprint || isPushSongFingerprintLibrary) {
      sendProgress('分析声音指纹初始化', 0, songFileUrls.length)

      let analyseResult = await getSongsAnalyseResult(songFileUrls, (resultLength) =>
        sendProgress('分析声音指纹中', resultLength, songFileUrls.length)
      )
      songsAnalyseResult = analyseResult.songsAnalyseResult
      errorSongsAnalyseResult = analyseResult.errorSongsAnalyseResult
      sendProgress('分析声音指纹中', songFileUrls.length, songFileUrls.length)

      if (isComparisonSongFingerprint) {
        const uniqueSongs = new Map()
        delList = songsAnalyseResult
          .filter((song) => {
            if (store.songFingerprintList.includes(song.md5_hash)) {
              alreadyExistInSongFingerprintList.add(song.md5_hash)
              return true
            }
            return false
          })
          .map((song) => song.file_path)
        let duplicates = []
        songsAnalyseResult
          .filter((song) => !delList.includes(song.file_path))
          .forEach((song) => {
            if (uniqueSongs.has(song.md5_hash)) {
              duplicates.push(song.file_path)
            } else {
              uniqueSongs.set(song.md5_hash, song)
            }
          })
        delList = delList.concat(duplicates)
        if (isDeleteSourceFile) {
          sendProgress(t('删除重复曲目'), 0, delList.length)
          delList.forEach((item, index) => {
            fs.remove(item)
            sendProgress(t('删除重复曲目'), index + 1, delList.length)
          })
        }

        toBeDealSongs = [...uniqueSongs.values()]
      } else if (isPushSongFingerprintLibrary) {
        toBeDealSongs = songsAnalyseResult
      }
    } else {
      toBeDealSongs = songFileUrls
    }
    toBeDealSongs.forEach(async (item, index) => {
      if (isPushSongFingerprintLibrary && !store.songFingerprintList.includes(item.md5_hash)) {
        store.songFingerprintList.push(item.md5_hash)
      }

      const targetPath = path.join(
        store.databaseDir,
        formData.songListPath,
        item.file_path ? item.file_path.match(/[^\\]+$/)[0] : item.match(/[^\\]+$/)[0]
      )
      await moveOrCopyItemWithCheckIsExist(
        item.file_path ? item.file_path : item,
        targetPath,
        isDeleteSourceFile
      )
      sendProgress(
        isDeleteSourceFile ? t('移动曲目') : t('复制曲目'),
        index + 1,
        toBeDealSongs.length
      )
    })

    if (isPushSongFingerprintLibrary) {
      fs.outputJSON(
        path.join(store.databaseDir, 'songFingerprint', 'songFingerprint.json'),
        store.songFingerprintList
      )
    }
    const contentArr = [
      t('文件夹下共扫描曲目：') + songFileUrls.length,
      ...(errorSongsAnalyseResult.length
        ? [
            t('尝试分析失败：') +
              errorSongsAnalyseResult.length +
              t('（通常由于文件内容损坏或传输过程发生错误）')
          ]
        : []),
      t('歌单共导入曲目：') + toBeDealSongs.length,
      ...(isComparisonSongFingerprint ? [t('比对声音指纹去除重复曲目：') + delList.length] : []),
      ...(isPushSongFingerprintLibrary
        ? [
            t('声音指纹库新增：') +
              (store.songFingerprintList.length - songFingerprintListLengthBefore),
            ...(alreadyExistInSongFingerprintList.size > 0
              ? [
                  t('未添加声音指纹：') +
                    alreadyExistInSongFingerprintList.size +
                    t('（因为已存在于声音指纹库中）')
                ]
              : [])
          ]
        : []),
      t('声音指纹库现有：') + store.songFingerprintList.length
    ]

    mainWindow.webContents.send('importFinished', contentArr, formData.songListUUID)
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

  mainWindow.on('closed', () => {
    ipcMain.removeHandler('toggle-maximize')
    ipcMain.removeHandler('toggle-minimize')
    ipcMain.removeHandler('toggle-close')
    ipcMain.removeHandler('readSongFile')
    ipcMain.removeHandler('addSongFingerprint')
    ipcMain.removeHandler('startImportSongs')
    ipcMain.removeHandler('changeGlobalShortcut')
    ipcMain.removeHandler('checkForUpdates')
    ipcMain.removeHandler('openFileExplorer')
    globalShortcut.unregister(store.settingConfig.globalCallShortcut)
    updateWindow?.instance?.close()
    mainWindow = null
  })
}

export default {
  get instance() {
    return mainWindow
  },
  createWindow
}
