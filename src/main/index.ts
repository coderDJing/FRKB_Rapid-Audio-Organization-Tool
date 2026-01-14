import 'dotenv/config'
import { app, BrowserWindow, ipcMain, shell, nativeTheme, protocol } from 'electron'
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
  clearWindowsContextMenuSignature,
  ensureWindowsContextMenuIfNeeded,
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
import { registerClipboardHandlers } from './ipc/clipboardHandlers'
import { registerExportHandlers } from './ipc/exportHandlers'
import { registerKeyAnalysisHandlers } from './ipc/keyAnalysisHandlers'
import { maybeShowWhatsNew, registerWhatsNewHandlers } from './services/whatsNew'
import * as LibraryCacheDb from './libraryCacheDb'
import {
  keyAnalysisEvents,
  startKeyAnalysisBackground,
  type KeyAnalysisBackgroundStatus
} from './services/keyAnalysisQueue'
// import AudioFeatureExtractor from './mfccTest'

const initDevDatabase = false
const dev_DB = 'D:/FRKB_database'
const my_real_DB = 'D:/FRKB_database'
let devDatabase = dev_DB

// 主题：默认按设置文件（首次为 system），不再强制日间模式

const gotTheLock = app.requestSingleInstanceLock()
const PREVIEW_PROTOCOL = 'frkb-preview'
const PREVIEW_MIME_MAP: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.wma': 'audio/x-ms-wma',
  '.ac3': 'audio/ac3',
  '.dts': 'audio/vnd.dts',
  '.mka': 'audio/x-matroska',
  '.webm': 'audio/webm',
  '.ape': 'audio/ape',
  '.tak': 'audio/tak',
  '.tta': 'audio/tta',
  '.wv': 'audio/wavpack'
}

const getPreviewMimeType = (filePath: string) => {
  const ext = path.extname(filePath || '').toLowerCase()
  return PREVIEW_MIME_MAP[ext] || 'application/octet-stream'
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: PREVIEW_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      corsEnabled: true,
      bypassCSP: true,
      allowServiceWorkers: true,
      supportFetchAPI: true,
      stream: true
    }
  }
])

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
registerClipboardHandlers()
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

const keyAnalysisBackgroundProgressId = 'key-analysis.background'
const sendKeyAnalysisBackgroundStatus = (status: KeyAnalysisBackgroundStatus) => {
  if (!mainWindow.instance) return
  if (!status.active) {
    mainWindow.instance.webContents.send('progressSet', {
      id: keyAnalysisBackgroundProgressId,
      dismiss: true
    })
    return
  }
  mainWindow.instance.webContents.send('progressSet', {
    id: keyAnalysisBackgroundProgressId,
    titleKey: 'keyAnalysis.backgroundAnalyzing',
    now: 0,
    total: 0,
    isInitial: true,
    noProgress: true,
    cancelable: true,
    cancelChannel: 'key-analysis:cancel-background'
  })
}
keyAnalysisEvents.on('background-status', sendKeyAnalysisBackgroundStatus)

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
}
if (is.dev && platform === 'win32') {
  store.settingConfig.databaseUrl = devDatabase
  // if (initDevDatabase) {
  //   if (devDatabase !== my_real_DB) {
  //     // 做一个保险，防止误操作把我真实数据库删了
  //     void devInitDatabaseFunction()
  //   }
  // }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('frkb.coderDjing')
  try {
    if (!protocol.isProtocolRegistered(PREVIEW_PROTOCOL)) {
      protocol.registerStreamProtocol(PREVIEW_PROTOCOL, async (request, callback) => {
        try {
          const safeDecode = (value: string) => {
            try {
              return decodeURIComponent(value)
            } catch {
              return value
            }
          }
          let decodedPath = ''
          try {
            const urlObj = new URL(request.url)
            const paramPath = urlObj.searchParams.get('path')
            if (paramPath) {
              decodedPath = paramPath
            } else {
              const host = urlObj.hostname || ''
              const pathname = urlObj.pathname || ''
              if (host && /^[a-zA-Z]$/.test(host) && pathname) {
                decodedPath = `${host}:${safeDecode(pathname)}`
              } else if (host && host !== 'local') {
                decodedPath = safeDecode(`${host}${pathname}`)
              } else {
                const rawPath = pathname.startsWith('/') ? pathname.slice(1) : pathname
                decodedPath = safeDecode(rawPath)
              }
            }
          } catch {
            const rawUrl = request.url || ''
            const match = rawUrl.match(/[?&]path=([^&]+)/i)
            if (match) {
              decodedPath = safeDecode(match[1])
            } else {
              const encodedPath = rawUrl.slice(`${PREVIEW_PROTOCOL}://`.length)
              const cleanedPath = (encodedPath || '').replace(/^\/+/, '')
              decodedPath = safeDecode(cleanedPath || '')
            }
          }

          if (decodedPath.startsWith('/') && /^[a-zA-Z]:\//.test(decodedPath.slice(1))) {
            decodedPath = decodedPath.slice(1)
          }
          if (!decodedPath) {
            callback({ statusCode: 400 })
            return
          }
          const stat = await fs.stat(decodedPath)
          const size = stat.size
          const rangeHeader = request.headers?.range || request.headers?.Range
          const mimeType = getPreviewMimeType(decodedPath)

          if (typeof rangeHeader === 'string' && rangeHeader.startsWith('bytes=')) {
            const range = rangeHeader.replace('bytes=', '').split('-')
            const start = Math.max(0, parseInt(range[0] || '0', 10))
            const end = range[1] ? Math.min(parseInt(range[1], 10), size - 1) : size - 1
            if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
              callback({ statusCode: 416 })
              return
            }
            const stream = fs.createReadStream(decodedPath, { start, end })
            callback({
              statusCode: 206,
              data: stream,
              mimeType,
              headers: {
                'Content-Range': `bytes ${start}-${end}/${size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': String(end - start + 1)
              }
            })
            return
          }

          const stream = fs.createReadStream(decodedPath)
          callback({
            statusCode: 200,
            data: stream,
            mimeType,
            headers: {
              'Accept-Ranges': 'bytes',
              'Content-Length': String(size)
            }
          })
        } catch (error) {
          callback({ statusCode: 404 })
        }
      })
    }
  } catch (error) {
    log.error('[previewProtocol] register failed', error)
  }
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
      void ensureWindowsContextMenuIfNeeded().catch(() => {})
    } else {
      void removeWindowsContextMenu()
        .then(() => clearWindowsContextMenuSignature())
        .catch(() => {})
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
