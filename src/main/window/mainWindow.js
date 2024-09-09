import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import {
  collectFilesWithExtensions,
  executeScript,
  moveOrCopyItemWithCheckIsExist
} from '../utils.js'
import analyseSongFingerprintPyScriptUrl from '../../../resources/pyScript/analyseSongFingerprint/analyseSongFingerprint.exe?commonjs-external&asset&asarUnpack'
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
    mainWindow.webContents.send('progressSet', t('扫描文件中'), 0, 1, true)
    let songFileUrls = []
    const promises = []
    for (let item of folderPath) {
      promises.push(collectFilesWithExtensions(item, store.settingConfig.audioExt))
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
      [folderPath.join('|'), store.settingConfig.audioExt.join(',')],
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
      if (store.songFingerprintList.indexOf(item.md5_hash) === -1) {
        map.set(item.md5_hash, item.md5_hash)
      }
    }
    let removeDuplicatesFingerprintResults = Array.from(map.values())
    store.songFingerprintList = store.songFingerprintList.concat(removeDuplicatesFingerprintResults)
    fs.outputJSON(
      path.join(store.databaseDir, 'songFingerprint', 'songFingerprint.json'),
      store.songFingerprintList
    )
    let contentArr = [
      t('文件夹下共扫描曲目：') + songFileUrls.length,
      t('比对声音指纹去除重复曲目：') +
        (songFileUrls.length -
          removeDuplicatesFingerprintResults.length -
          fingerprintErrorResults.length),
      t('声音指纹库新增：') + removeDuplicatesFingerprintResults.length,
      t('声音指纹库现有：') + store.songFingerprintList.length
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
          if (store.settingConfig.audioExt.includes(ext)) {
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
      promises.push(collectFilesWithExtensions(item, store.settingConfig.audioExt))
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
    let songFingerprintListLengthBefore = store.songFingerprintList.length
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
        let targetPath = path.join(
          store.databaseDir,
          formData.songListPath,
          songFileUrl.match(/[^\\]+$/)[0]
        )
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
        [songFileUrls.join('|'), store.settingConfig.audioExt.join(',')],
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
        if (store.songFingerprintList.indexOf(item.md5_hash) != -1) {
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
          store.songFingerprintList.push(item.md5_hash)
        }
        let targetPath = path.join(
          store.databaseDir,
          formData.songListPath,
          item.path.match(/[^\\]+$/)[0]
        )
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
        fs.outputJSON(
          path.join(store.databaseDir, 'songFingerprint', 'songFingerprint.json'),
          store.songFingerprintList
        )
      }
    } else if (!formData.isComparisonSongFingerprint && formData.isPushSongFingerprintLibrary) {
      //不比对声音指纹，仅加入指纹库
      await analyseSongFingerprint()
      for (let item of fingerprintResults) {
        if (store.songFingerprintList.indexOf(item.md5_hash) == -1) {
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
        fingerprintResults.length !=
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
    mainWindow.webContents.send('importFinished', contentArr, formData.songListUUID)
    return
  })
  ipcMain.on('startImportSongs', async (e, formData, songListUUID) => {
    formData.songListPath = path.join(store.databaseDir, formData.songListPath)
    mainWindow.webContents.send('progressSet', t('扫描文件中'), 0, 1, true)
    let songFileUrls = []
    const promises = []
    for (let item of formData.folderPath) {
      promises.push(collectFilesWithExtensions(item, store.settingConfig.audioExt))
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
    let songFingerprintListLengthBefore = store.songFingerprintList.length
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
        let targetPath = path.join(formData.songListPath, songFileUrl.match(/[^\\]+$/)[0])
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
        [formData.folderPath.join('|'), store.settingConfig.audioExt.join(',')],
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
        if (store.songFingerprintList.indexOf(item.md5_hash) != -1) {
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
          store.songFingerprintList.push(item.md5_hash)
        }
        let targetPath = path.join(formData.songListPath, item.path.match(/[^\\]+$/)[0])
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
        fs.outputJSON(
          path.join(store.databaseDir, 'songFingerprint', 'songFingerprint.json'),
          store.songFingerprintList
        )
      }
    } else if (!formData.isComparisonSongFingerprint && formData.isPushSongFingerprintLibrary) {
      //不比对声音指纹，仅加入指纹库
      await analyseSongFingerprint()
      for (let item of fingerprintResults) {
        if (store.songFingerprintList.indexOf(item.md5_hash) == -1) {
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
        fingerprintResults.length !=
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
    mainWindow.webContents.send('importFinished', contentArr, songListUUID)
    return
  })
  mainWindow.on('blur', () => {
    mainWindow.webContents.send('mainWindowBlur')
  })
}

export default {
  instance: mainWindow,
  createWindow
}
