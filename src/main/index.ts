import 'dotenv/config'
import { app, BrowserWindow, ipcMain, shell, nativeTheme } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { log } from './log'
import './cloudSync'
import errorReport from './errorReport'
import url from './url'
import { saveList } from './fingerprintStore'
import { initDatabaseStructure } from './initDatabase'
import mainWindow from './window/mainWindow'
import databaseInitWindow from './window/databaseInitWindow'
import { is } from '@electron-toolkit/utils'
import store from './store'
import { setupMacMenus } from './menu/macMenu'
import { prepareAndOpenMainWindow } from './bootstrap/prepareDatabase'
import { setupAutoUpdate } from './bootstrap/autoUpdate'
import {
  applyThemeFromSettings,
  broadcastSystemThemeIfNeeded,
  loadInitialSettings
} from './bootstrap/settings'
import {
  ensureWindowsContextMenu,
  hasWindowsContextMenu,
  removeWindowsContextMenu
} from './platform/windowsContextMenu'
import { resolveBundledFfmpegPath, ensureExecutableOnMac } from './ffmpeg'
import { resolveBundledFpcalcPath, ensureFpcalcExecutable } from './chromaprint'
import { processExternalOpenQueue, queueExternalAudioFiles } from './services/externalOpenQueue'
import { registerSettingsHandlers } from './ipc/settingsHandlers'
import { registerLibraryMaintenanceHandlers } from './ipc/libraryMaintenanceHandlers'
import { registerPlaylistHandlers } from './ipc/playlistHandlers'
import { registerMediaMetadataHandlers } from './ipc/mediaMetadataHandlers'
import { registerCacheHandlers } from './ipc/cacheHandlers'
import { registerFilesystemHandlers } from './ipc/filesystemHandlers'
import { registerExportHandlers } from './ipc/exportHandlers'
import { registerKeyAnalysisHandlers } from './ipc/keyAnalysisHandlers'
import { maybeShowWhatsNew, registerWhatsNewHandlers } from './services/whatsNew'
import * as LibraryCacheDb from './libraryCacheDb'
import { keyAnalysisEvents, startKeyAnalysisBackground } from './services/keyAnalysisQueue'
// import AudioFeatureExtractor from './mfccTest'

const initDevDatabase = false
const dev_DB = 'C:\\Users\\renlu\\Desktop\\FRKB_database'
const my_real_DB = 'D:\\FRKB_database'
// 需要切换时，将下一行改为 my_real_DB
let devDatabase = dev_DB

// 主题：默认按设置文件（首次为 system），不再强制日间模式

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, _commandLine, _workingDirectory) => {
    queueExternalAudioFiles(_commandLine)
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
app.on('open-file', (event, openedPath) => {
  event.preventDefault()
  queueExternalAudioFiles([openedPath])
})

import path = require('path')
import fs = require('fs-extra')
const platform = process.platform
const ffmpegPath = resolveBundledFfmpegPath()
process.env.FRKB_FFMPEG_PATH = ffmpegPath
void ensureExecutableOnMac(ffmpegPath)
const fpcalcPath = resolveBundledFpcalcPath()
process.env.FRKB_FPCALC_PATH = fpcalcPath
void ensureFpcalcExecutable(fpcalcPath)
// 不再使用 Tray，改用应用菜单
if (!fs.pathExistsSync(url.layoutConfigFileUrl)) {
  fs.outputJsonSync(url.layoutConfigFileUrl, {
    libraryAreaWidth: 175,
    isMaxMainWin: false,
    mainWindowWidth: 900,
    mainWindowHeight: 600
  })
}

store.layoutConfig = fs.readJSONSync(url.layoutConfigFileUrl)
loadInitialSettings({ getWindowsContextMenuStatus: hasWindowsContextMenu })
errorReport.setup()
registerWhatsNewHandlers()
registerSettingsHandlers({
  loadFingerprintList: async (mode) => {
    const FingerprintStore = require('./fingerprintStore')
    const list = await FingerprintStore.loadList(mode)
    return Array.isArray(list) ? list : []
  }
})
registerLibraryMaintenanceHandlers()
registerPlaylistHandlers()
registerMediaMetadataHandlers()
registerCacheHandlers()
registerFilesystemHandlers()
registerExportHandlers()
registerKeyAnalysisHandlers()

keyAnalysisEvents.on('key-updated', (payload) => {
  if (mainWindow.instance) {
    try {
      mainWindow.instance.webContents.send('song-key-updated', payload)
    } catch {}
  }
})

keyAnalysisEvents.on('bpm-updated', (payload) => {
  if (mainWindow.instance) {
    try {
      mainWindow.instance.webContents.send('song-bpm-updated', payload)
    } catch {}
  }
})

keyAnalysisEvents.on('waveform-updated', (payload) => {
  if (mainWindow.instance) {
    try {
      mainWindow.instance.webContents.send('song-waveform-updated', payload)
    } catch {}
  }
})

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
  // 设置应用显示名称为 FRKB（影响菜单栏左上角 App 菜单标题）
  try {
    app.setName('FRKB')
  } catch {}
  // 启动即按设置应用主题
  applyThemeFromSettings()
  // 处理启动时通过文件关联传入的音频文件
  queueExternalAudioFiles(process.argv.slice(1))
  if (process.platform === 'win32') {
    if ((store as any).settingConfig.enableExplorerContextMenu !== false) {
      await ensureWindowsContextMenu()
    } else {
      await removeWindowsContextMenu()
    }
  }
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
    void processExternalOpenQueue()
  })
  // macOS：交由模块化方法统一处理菜单
  if (process.platform === 'darwin') {
    setupMacMenus()
  }
  // 数据库准备与主窗口：统一调用幂等流程
  await prepareAndOpenMainWindow()
  startKeyAnalysisBackground()
  await processExternalOpenQueue()
  setTimeout(() => {
    maybeShowWhatsNew().catch((error) => {
      log.error('[whatsNew] maybeShowWhatsNew 异常', error)
    })
  }, 1500)
  // 初次创建窗口后，若为跟随系统，广播一次当前主题
  broadcastSystemThemeIfNeeded()
  setupAutoUpdate()
  // 在系统主题变化时（仅 system 模式关注）广播更新
  try {
    nativeTheme.on('updated', () => {
      broadcastSystemThemeIfNeeded()
    })
  } catch {}
  // 应用启动后，延迟对所有歌单目录做一次全量 sweep（保证重启后也能清理空歌单残留封面）
  try {
    setTimeout(async () => {
      if (!store.databaseDir) return
      const libRoot = path.join(store.databaseDir, 'library')
      const walk = async (dir: string) => {
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true })
          for (const ent of entries) {
            const full = path.join(dir, ent.name)
            if (ent.isDirectory()) {
              const coversDir = path.join(full, '.frkb_covers')
              if (await fs.pathExists(coversDir)) {
                const dbEntries = await LibraryCacheDb.loadCoverIndexEntries(full)
                if (dbEntries) {
                  const liveHashes = new Set(dbEntries.map((item) => item.hash))
                  try {
                    const entries = await fs.readdir(coversDir)
                    const imgRegex = /^[a-f0-9]{40}\.(jpg|png|webp|gif|bmp)$/i
                    for (const name of entries) {
                      const fullPath = path.join(coversDir, name)
                      if (name.includes('.tmp_')) {
                        try {
                          await fs.remove(fullPath)
                        } catch {}
                        continue
                      }
                      if (!imgRegex.test(name)) continue
                      const hash = name.slice(0, 40).toLowerCase()
                      if (!liveHashes.has(hash)) {
                        try {
                          await fs.remove(fullPath)
                        } catch {}
                      }
                    }
                  } catch {}
                }
              }
              await walk(full)
            }
          }
        } catch {}
      }
      await walk(libRoot)
    }, 2000)
  } catch {}

  app.on('activate', async function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      await prepareAndOpenMainWindow()
      await processExternalOpenQueue()
    }
  })
})

app.on('window-all-closed', async () => {
  ipcMain.removeAllListeners()
  app.quit()
})

// 语言字典将不再通过主进程下发，渲染进程使用 vue-i18n 自行管理
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
