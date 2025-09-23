import 'dotenv/config'
import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  IpcMainInvokeEvent,
  Menu,
  nativeImage,
  nativeTheme
} from 'electron'
import zhCNLocale from '../renderer/src/i18n/locales/zh-CN.json'
import enUSLocale from '../renderer/src/i18n/locales/en-US.json'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import {
  getLibrary,
  collectFilesWithExtensions,
  getCurrentTimeYYYYMMDDHHMMSSSSS,
  moveOrCopyItemWithCheckIsExist,
  operateHiddenFile,
  runWithConcurrency,
  waitForUserDecision,
  getCoreFsDirName,
  mapRendererPathToFsPath
} from './utils'
import { log } from './log'
import './cloudSync'
import errorReport from './errorReport'
import url from './url'
import { initDatabaseStructure } from './initDatabase'
import {
  healAndPrepare,
  loadList,
  saveList,
  exportSnapshot,
  importFromJsonFile
} from './fingerprintStore'
import mainWindow from './window/mainWindow'
import databaseInitWindow from './window/databaseInitWindow'
import { is } from '@electron-toolkit/utils'
import store from './store'
import foundNewVersionWindow from './window/foundNewVersionWindow'
import updateWindow from './window/updateWindow'
import electronUpdater = require('electron-updater')
import {
  readManifestFile,
  getManifestPath,
  MANIFEST_FILE_NAME,
  looksLikeLegacyStructure,
  ensureManifestForLegacy,
  writeManifest
} from './databaseManifest'
import { execFile } from 'child_process'
import { ISongInfo } from '../types/globals'
import { v4 as uuidV4 } from 'uuid'
// import AudioFeatureExtractor from './mfccTest'

const initDevDatabase = false
const dev_DB = 'C:\\Users\\renlu\\Desktop\\FRKB_database'
const my_real_DB = 'D:\\FRKB_database'
// 需要切换时，将下一行改为 my_real_DB
let devDatabase = dev_DB

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, _commandLine, _workingDirectory) => {
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
// 不再使用 Tray，改用应用菜单
if (!fs.pathExistsSync(url.layoutConfigFileUrl)) {
  fs.outputJsonSync(url.layoutConfigFileUrl, {
    libraryAreaWidth: 175,
    isMaxMainWin: false,
    mainWindowWidth: 900,
    mainWindowHeight: 600
  })
  fs.outputJsonSync(url.settingConfigFileUrl, {
    platform: platform,
    language: is.dev ? 'zhCN' : '',
    audioExt: ['.mp3', '.wav', '.flac', '.aif', '.aiff'],
    databaseUrl: '',
    globalCallShortcut:
      platform === 'win32' ? 'Ctrl+Alt+F' : platform === 'darwin' ? 'Command+Option+F' : '',
    hiddenPlayControlArea: false,
    autoPlayNextSong: false,
    startPlayPercent: 0,
    endPlayPercent: 100,
    fastForwardTime: 10,
    fastBackwardTime: -5,
    autoScrollToCurrentSong: true,
    enablePlaybackRange: false,
    recentDialogSelectedSongListMaxCount: 10,
    persistSongFilters: false
  })
}

// 定义默认设置结构
const defaultSettings = {
  platform: (platform === 'darwin' ? 'darwin' : 'win32') as 'darwin' | 'win32',
  language: (is.dev ? 'zhCN' : '') as '' | 'enUS' | 'zhCN',
  audioExt: ['.mp3', '.wav', '.flac', '.aif', '.aiff'],
  databaseUrl: '',
  globalCallShortcut:
    platform === 'win32' ? 'Ctrl+Alt+F' : platform === 'darwin' ? 'Command+Option+F' : '',
  hiddenPlayControlArea: false,
  autoPlayNextSong: false,
  startPlayPercent: 0,
  endPlayPercent: 100,
  fastForwardTime: 10,
  fastBackwardTime: -5,
  autoScrollToCurrentSong: true,
  enablePlaybackRange: false,
  recentDialogSelectedSongListMaxCount: 10,
  persistSongFilters: false,
  nextCheckUpdateTime: '',
  // 错误日志上报默认配置
  enableErrorReport: true,
  errorReportUsageMsSinceLastSuccess: 0,
  errorReportRetryMsSinceLastFailure: -1
}

store.layoutConfig = fs.readJSONSync(url.layoutConfigFileUrl)

// 加载并合并设置
let loadedSettings = {}
if (fs.pathExistsSync(url.settingConfigFileUrl)) {
  try {
    loadedSettings = fs.readJSONSync(url.settingConfigFileUrl)
  } catch (error) {
    log.error('读取设置文件错误，将使用默认设置:', error)
    // 处理潜在的 JSON 解析错误，回退到默认值
    loadedSettings = {} // 或者你可以选择保留 defaultSettings
  }
} else {
  // 如果文件不存在（虽然前面的逻辑会创建它，但为了健壮性加上）
  fs.outputJsonSync(url.settingConfigFileUrl, defaultSettings) // 确保写入
  loadedSettings = defaultSettings // 使用默认设置继续
}

// 合并默认设置与加载的设置，确保所有键都存在
// 加载的设置会覆盖默认值（如果存在）
const finalSettings = { ...defaultSettings, ...loadedSettings }

// 一次性迁移：默认勾选 .aif / .aiff（升级老版本时补齐），并写入迁移标记
try {
  const migrated = (loadedSettings as any)?.migratedAudioExtAiffAif === true
  if (!migrated) {
    const arr = Array.isArray((finalSettings as any).audioExt)
      ? ((finalSettings as any).audioExt as string[])
      : []
    const set = new Set(arr.map((e) => String(e || '').toLowerCase()))
    let changed = false
    if (!set.has('.aif')) {
      arr.push('.aif')
      changed = true
    }
    if (!set.has('.aiff')) {
      arr.push('.aiff')
      changed = true
    }
    ;(finalSettings as any).audioExt = arr
    ;(finalSettings as any).migratedAudioExtAiffAif = true
  }
} catch (_e) {
  // 忽略迁移异常，保持既有行为
}

// 更新 store
store.settingConfig = finalSettings

// 将可能更新的设置持久化回文件
// 确保即使文件最初不存在，或者读取出错时，最终也会写入一个有效的配置文件
fs.outputJsonSync(url.settingConfigFileUrl, finalSettings)

// 初始化错误日志上报调度
try {
  errorReport.setup()
} catch (e) {
  log.error('初始化错误日志上报失败', e)
}

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
  if (process.platform === 'darwin') {
    nativeTheme.themeSource = 'dark'
  }
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  // macOS：构建两套菜单，并根据聚焦窗口切换
  if (process.platform === 'darwin') {
    try {
      const MESSAGES: Record<'zh-CN' | 'en-US', any> = {
        'zh-CN': zhCNLocale as any,
        'en-US': enUSLocale as any
      }
      const getCurrentLocaleId = (): 'zh-CN' | 'en-US' =>
        (store.settingConfig as any)?.language === 'enUS' ? 'en-US' : 'zh-CN'
      const tMenu = (key: string): string => {
        const localeId = getCurrentLocaleId()
        const parts = key.split('.')
        let cur: any = MESSAGES[localeId]
        for (const p of parts) {
          if (cur && typeof cur === 'object' && p in cur) cur = cur[p]
          else return key
        }
        return typeof cur === 'string' ? cur : key
      }
      const sanitizeLabelForMac = (label: string): string => {
        if (process.platform !== 'darwin') return label
        // 移除尾部的 (F)/(H)/(C) 或全角（F）等助记符
        return label.replace(/\s*(\([A-Za-z]\)|（[A-Za-z]）)/g, '')
      }
      const labelImportTo = (libraryKey: 'library.filter' | 'library.curated') => {
        const tpl = tMenu('library.importNewTracks')
        const lib = tMenu(libraryKey)
        return tpl.replace('{libraryType}', lib)
      }
      const buildAppOnlyMenu = () =>
        Menu.buildFromTemplate([
          {
            label: 'FRKB',
            submenu: [
              { role: 'hide', label: '隐藏 FRKB' },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '显示全部' },
              { type: 'separator' },
              { role: 'quit', label: '退出 FRKB' }
            ]
          }
        ])
      const buildFullMenu = () =>
        Menu.buildFromTemplate([
          // 顶栏
          {
            label: 'FRKB',
            submenu: [
              { role: 'hide', label: '隐藏 FRKB' },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '显示全部' },
              { type: 'separator' },
              { role: 'quit', label: '退出 FRKB' }
            ]
          },
          {
            label: sanitizeLabelForMac(tMenu('menu.file')),
            submenu: [
              {
                label: labelImportTo('library.filter'),
                click: () =>
                  mainWindow.instance?.webContents.send('tray-action', 'import-new-filter')
              },
              {
                label: labelImportTo('library.curated'),
                click: () =>
                  mainWindow.instance?.webContents.send('tray-action', 'import-new-curated')
              },
              { type: 'separator' },
              {
                label: tMenu('fingerprints.manualAdd'),
                click: () =>
                  mainWindow.instance?.webContents.send(
                    'openDialogFromTray',
                    'fingerprints.manualAdd'
                  )
              }
            ]
          },
          {
            label: sanitizeLabelForMac(tMenu('menu.migration')),
            submenu: [
              {
                label: tMenu('fingerprints.exportDatabase'),
                click: () =>
                  mainWindow.instance?.webContents.send(
                    'openDialogFromTray',
                    'fingerprints.exportDatabase'
                  )
              },
              {
                label: tMenu('fingerprints.importDatabase'),
                click: () =>
                  mainWindow.instance?.webContents.send(
                    'openDialogFromTray',
                    'fingerprints.importDatabase'
                  )
              }
            ]
          },
          {
            label: sanitizeLabelForMac(tMenu('menu.cloudSync')),
            submenu: [
              {
                label: tMenu('cloudSync.syncFingerprints'),
                click: () =>
                  mainWindow.instance?.webContents.send(
                    'openDialogFromTray',
                    'cloudSync.syncFingerprints'
                  )
              },
              {
                label: tMenu('cloudSync.settings'),
                click: () =>
                  mainWindow.instance?.webContents.send('openDialogFromTray', 'cloudSync.settings')
              }
            ]
          },
          {
            label: sanitizeLabelForMac(tMenu('menu.help')),
            submenu: [
              {
                label: tMenu('menu.visitGithub'),
                click: () =>
                  mainWindow.instance?.webContents.send('openDialogFromTray', 'menu.visitGithub')
              },
              {
                label: tMenu('menu.checkUpdate'),
                click: () =>
                  mainWindow.instance?.webContents.send('openDialogFromTray', 'menu.checkUpdate')
              },
              {
                label: tMenu('menu.about'),
                click: () =>
                  mainWindow.instance?.webContents.send('openDialogFromTray', 'menu.about')
              }
            ]
          }
        ])
      // 初始：非主窗口可能先出现（数据库初始化），仅显示 FRKB
      Menu.setApplicationMenu(buildAppOnlyMenu())
      app.on('browser-window-focus', (_e, win) => {
        if (win && mainWindow.instance && win.id === mainWindow.instance.id) {
          Menu.setApplicationMenu(buildFullMenu())
        } else {
          Menu.setApplicationMenu(buildAppOnlyMenu())
        }
      })
    } catch {}
  }
  if (!store.settingConfig.databaseUrl) {
    databaseInitWindow.createWindow()
  } else {
    // 若数据库根路径不存在，则视为“数据库不存在”，直接进入初始化界面并提示
    try {
      const exists = fs.pathExistsSync(store.settingConfig.databaseUrl)
      if (!exists) {
        databaseInitWindow.createWindow({ needErrorHint: true })
        return
      }
    } catch (_e) {
      databaseInitWindow.createWindow({ needErrorHint: true })
      return
    }
    try {
      // 统一复用初始化（幂等）：创建/修复库结构
      await initDatabaseStructure(store.settingConfig.databaseUrl, { createSamples: false })
      // 补齐/验证声明文件（旧库静默生成）
      try {
        const legacy = await ensureManifestForLegacy(
          store.settingConfig.databaseUrl,
          app.getVersion()
        )
        if (!legacy) {
          await writeManifest(store.settingConfig.databaseUrl, app.getVersion())
        }
      } catch {}
      // 指纹：前置修复并加载（多版本+指针）
      await healAndPrepare()
      const list = await loadList()
      store.databaseDir = store.settingConfig.databaseUrl
      store.songFingerprintList = Array.isArray(list) ? list : []
      mainWindow.createWindow()
    } catch (_e) {
      databaseInitWindow.createWindow({ needErrorHint: true })
    }
  }

  const autoUpdater = electronUpdater.autoUpdater
  autoUpdater.autoDownload = false
  const isPrerelease = app.getVersion().includes('-')
  // 预发布轨道仅更新到预发布；稳定轨道仅更新到稳定
  try {
    ;(autoUpdater as any).allowPrerelease = isPrerelease
  } catch {}

  if (store.settingConfig.nextCheckUpdateTime) {
    if (new Date() > new Date(store.settingConfig.nextCheckUpdateTime)) {
      autoUpdater.checkForUpdates()
    }
  } else {
    autoUpdater.checkForUpdates()
  }

  autoUpdater.on('update-available', (info) => {
    const currentIsPrerelease = app.getVersion().includes('-')
    const remoteIsPrerelease = !!(
      info &&
      typeof (info as any).version === 'string' &&
      (info as any).version.includes('-')
    )
    // 只允许同轨道更新：预发布→预发布；稳定→稳定
    if (currentIsPrerelease !== remoteIsPrerelease) {
      return
    }
    if (updateWindow.instance === null) {
      foundNewVersionWindow.createWindow()
    }
  })

  app.on('activate', async function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      if (!store.settingConfig.databaseUrl) {
        databaseInitWindow.createWindow()
      } else {
        // 若数据库根路径不存在，则进入初始化界面并提示
        try {
          const exists = fs.pathExistsSync(store.settingConfig.databaseUrl)
          if (!exists) {
            databaseInitWindow.createWindow({ needErrorHint: true })
            return
          }
        } catch (_e) {
          databaseInitWindow.createWindow({ needErrorHint: true })
          return
        }
        try {
          await initDatabaseStructure(store.settingConfig.databaseUrl, { createSamples: false })
          // 补齐/验证声明文件（旧库静默生成）
          try {
            const legacy = await ensureManifestForLegacy(
              store.settingConfig.databaseUrl,
              app.getVersion()
            )
            if (!legacy) {
              await writeManifest(store.settingConfig.databaseUrl, app.getVersion())
            }
          } catch {}
          await healAndPrepare()
          const list = await loadList()
          store.databaseDir = store.settingConfig.databaseUrl
          store.songFingerprintList = Array.isArray(list) ? list : []
          mainWindow.createWindow()
        } catch (_e) {
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

// 语言字典将不再通过主进程下发，渲染进程使用 vue-i18n 自行管理
ipcMain.handle('getSetting', () => {
  return store.settingConfig
})
ipcMain.handle('setSetting', (e, setting) => {
  store.settingConfig = setting
  fs.outputJson(url.settingConfigFileUrl, setting)
  // 语言切换时（macOS）重建菜单
  if (process.platform === 'darwin') {
    try {
      const MESSAGES: Record<'zh-CN' | 'en-US', any> = {
        'zh-CN': zhCNLocale as any,
        'en-US': enUSLocale as any
      }
      const getCurrentLocaleId = (): 'zh-CN' | 'en-US' =>
        (store.settingConfig as any)?.language === 'enUS' ? 'en-US' : 'zh-CN'
      const tMenu = (key: string): string => {
        const localeId = getCurrentLocaleId()
        const parts = key.split('.')
        let cur: any = MESSAGES[localeId]
        for (const p of parts) {
          if (cur && typeof cur === 'object' && p in cur) cur = cur[p]
          else return key
        }
        return typeof cur === 'string' ? cur : key
      }
      const sanitizeLabelForMac = (label: string): string => {
        // 去除 (F)/(H)/(C) 或全角（F）等助记符
        return label.replace(/\s*(\([A-Za-z]\)|（[A-Za-z]）)/g, '')
      }
      const labelImportTo = (libraryKey: 'library.filter' | 'library.curated') => {
        const tpl = tMenu('library.importNewTracks')
        const lib = tMenu(libraryKey)
        return tpl.replace('{libraryType}', lib)
      }
      const buildAppOnlyMenu = () =>
        Menu.buildFromTemplate([
          {
            label: 'FRKB',
            submenu: [
              { role: 'hide', label: getCurrentLocaleId() === 'en-US' ? 'Hide FRKB' : '隐藏 FRKB' },
              {
                role: 'hideOthers',
                label: getCurrentLocaleId() === 'en-US' ? 'Hide Others' : '隐藏其他'
              },
              { role: 'unhide', label: getCurrentLocaleId() === 'en-US' ? 'Show All' : '显示全部' },
              { type: 'separator' },
              { role: 'quit', label: getCurrentLocaleId() === 'en-US' ? 'Quit FRKB' : '退出 FRKB' }
            ]
          }
        ])
      const buildFullMenu = () =>
        Menu.buildFromTemplate([
          {
            label: 'FRKB',
            submenu: [
              { role: 'hide', label: getCurrentLocaleId() === 'en-US' ? 'Hide FRKB' : '隐藏 FRKB' },
              {
                role: 'hideOthers',
                label: getCurrentLocaleId() === 'en-US' ? 'Hide Others' : '隐藏其他'
              },
              { role: 'unhide', label: getCurrentLocaleId() === 'en-US' ? 'Show All' : '显示全部' },
              { type: 'separator' },
              { role: 'quit', label: getCurrentLocaleId() === 'en-US' ? 'Quit FRKB' : '退出 FRKB' }
            ]
          },
          {
            label: sanitizeLabelForMac(tMenu('menu.file')),
            submenu: [
              {
                label: labelImportTo('library.filter'),
                click: () =>
                  mainWindow.instance?.webContents.send('tray-action', 'import-new-filter')
              },
              {
                label: labelImportTo('library.curated'),
                click: () =>
                  mainWindow.instance?.webContents.send('tray-action', 'import-new-curated')
              },
              { type: 'separator' },
              {
                label: tMenu('fingerprints.manualAdd'),
                click: () =>
                  mainWindow.instance?.webContents.send(
                    'openDialogFromTray',
                    'fingerprints.manualAdd'
                  )
              }
            ]
          },
          {
            label: sanitizeLabelForMac(tMenu('menu.migration')),
            submenu: [
              {
                label: tMenu('fingerprints.exportDatabase'),
                click: () =>
                  mainWindow.instance?.webContents.send(
                    'openDialogFromTray',
                    'fingerprints.exportDatabase'
                  )
              },
              {
                label: tMenu('fingerprints.importDatabase'),
                click: () =>
                  mainWindow.instance?.webContents.send(
                    'openDialogFromTray',
                    'fingerprints.importDatabase'
                  )
              }
            ]
          },
          {
            label: sanitizeLabelForMac(tMenu('menu.cloudSync')),
            submenu: [
              {
                label: tMenu('cloudSync.syncFingerprints'),
                click: () =>
                  mainWindow.instance?.webContents.send(
                    'openDialogFromTray',
                    'cloudSync.syncFingerprints'
                  )
              },
              {
                label: tMenu('cloudSync.settings'),
                click: () =>
                  mainWindow.instance?.webContents.send('openDialogFromTray', 'cloudSync.settings')
              }
            ]
          },
          {
            label: sanitizeLabelForMac(tMenu('menu.help')),
            submenu: [
              {
                label: tMenu('menu.visitGithub'),
                click: () =>
                  mainWindow.instance?.webContents.send('openDialogFromTray', 'menu.visitGithub')
              },
              {
                label: tMenu('menu.checkUpdate'),
                click: () =>
                  mainWindow.instance?.webContents.send('openDialogFromTray', 'menu.checkUpdate')
              },
              {
                label: tMenu('menu.about'),
                click: () =>
                  mainWindow.instance?.webContents.send('openDialogFromTray', 'menu.about')
              }
            ]
          }
        ])
      const focused = BrowserWindow.getFocusedWindow()
      if (focused && mainWindow.instance && focused.id === mainWindow.instance.id) {
        Menu.setApplicationMenu(buildFullMenu())
      } else {
        Menu.setApplicationMenu(buildAppOnlyMenu())
      }
    } catch {}
  }
})
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

ipcMain.on('delSongs', async (e, songFilePaths: string[], dirName: string) => {
  let recycleBinTargetDir = path.join(
    store.databaseDir,
    'library',
    getCoreFsDirName('RecycleBin'),
    dirName
  )
  fs.ensureDirSync(recycleBinTargetDir)
  const tasks: Array<() => Promise<any>> = []
  for (let item of songFilePaths) {
    const dest = path.join(recycleBinTargetDir, path.basename(item))
    tasks.push(() => fs.move(item, dest))
  }
  const batchId = `delSongs_${Date.now()}`
  const { success, failed, hasENOSPC, skipped, results } = await runWithConcurrency(tasks, {
    concurrency: 16,
    stopOnENOSPC: true,
    onInterrupted: async (payload) =>
      waitForUserDecision(mainWindow.instance ?? null, batchId, 'delSongs', payload)
  })
  if (hasENOSPC && mainWindow.instance) {
    mainWindow.instance.webContents.send('file-batch-summary', {
      context: 'delSongs',
      total: tasks.length,
      success,
      failed,
      hasENOSPC,
      skipped,
      errorSamples: results
        .map((r, i) =>
          r instanceof Error ? { code: (r as any).code, message: r.message, index: i } : null
        )
        .filter(Boolean)
        .slice(0, 3)
    })
  }
  if (failed > 0) {
    throw new Error('delSongs failed')
  }
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
    const filePath = path.join(
      store.databaseDir,
      mapRendererPathToFsPath(targetPath),
      '.description.json'
    )
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
  const perfAllStart = Date.now()
  let scanPath = path.join(store.databaseDir, mapRendererPathToFsPath(songListPath))
  const perfListStart = Date.now()
  const mm = await import('music-metadata')
  let songInfoArr: ISongInfo[] = []
  let songFileUrls = await collectFilesWithExtensions(scanPath, store.settingConfig.audioExt)
  const perfListEnd = Date.now()

  // --- 缓存：.songs.cache.json 按文件 size/mtime 命中 ---
  type CacheEntry = {
    size: number
    mtimeMs: number
    info: ISongInfo
  }
  const cacheFile = path.join(scanPath, '.songs.cache.json')
  let cacheMap = new Map<string, CacheEntry>()
  try {
    if (await fs.pathExists(cacheFile)) {
      const json = await fs.readJSON(cacheFile)
      if (json && typeof json === 'object') {
        const entries = (json.entries || {}) as Record<string, CacheEntry>
        for (const [k, v] of Object.entries(entries)) {
          if (v && typeof v.size === 'number' && typeof v.mtimeMs === 'number' && v.info) {
            cacheMap.set(k, v)
          }
        }
      }
    }
  } catch {}

  const perfCacheCheckStart = Date.now()
  const filesStatList: Array<{ file: string; size: number; mtimeMs: number }> = []
  for (const file of songFileUrls) {
    try {
      const st = await fs.stat(file)
      filesStatList.push({ file, size: st.size, mtimeMs: st.mtimeMs })
    } catch {
      // ignore stat error
    }
  }
  const cachedInfos: ISongInfo[] = []
  const filesToParse: string[] = []
  for (const it of filesStatList) {
    const c = cacheMap.get(it.file)
    if (c && c.size === it.size && Math.abs(c.mtimeMs - it.mtimeMs) < 1) {
      cachedInfos.push(c.info)
    } else {
      filesToParse.push(it.file)
    }
  }
  const perfCacheCheckEnd = Date.now()

  function convertSecondsToMinutesSeconds(seconds: number) {
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = seconds % 60
    const minutesStr = minutes.toString().padStart(2, '0')
    const secondsStr = remainingSeconds.toString().padStart(2, '0')
    return `${minutesStr}:${secondsStr}`
  }

  const perfParseStart = Date.now()
  const tasks: Array<() => Promise<any>> = filesToParse.map((url) => async () => {
    try {
      const metadata = await mm.parseFile(url)
      const title =
        metadata.common?.title && metadata.common.title.trim() !== ''
          ? metadata.common.title
          : path.basename(url)
      return {
        filePath: url,
        cover: null,
        title,
        artist: metadata.common?.artist,
        album: metadata.common?.album,
        duration: convertSecondsToMinutesSeconds(
          metadata.format.duration === undefined ? 0 : Math.round(metadata.format.duration)
        ),
        genre: metadata.common?.genre?.[0],
        label: metadata.common?.label?.[0],
        bitrate: metadata.format?.bitrate,
        container: metadata.format?.container
      } as ISongInfo
    } catch (_e) {
      // 单文件失败：跳过
      return new Error('parse-failed')
    }
  })
  const { results, success, failed } = await runWithConcurrency(tasks, { concurrency: 8 })
  const parsedInfos: ISongInfo[] = results.filter((r) => r && !(r instanceof Error))
  songInfoArr = [...cachedInfos, ...parsedInfos]
  const perfParseEnd = Date.now()

  // 回写缓存：仅包含当前存在的文件
  try {
    const newEntries: Record<string, CacheEntry> = {}
    const infoMap = new Map<string, ISongInfo>()
    for (const info of songInfoArr) infoMap.set(info.filePath, info)
    for (const st of filesStatList) {
      const info = infoMap.get(st.file)
      if (info) newEntries[st.file] = { size: st.size, mtimeMs: st.mtimeMs, info }
    }
    await fs.writeJSON(cacheFile, { entries: newEntries })
  } catch {}

  const perfAllEnd = Date.now()
  // 移除冗余性能日志输出
  return {
    scanData: songInfoArr,
    songListUUID,
    perf: {
      listFilesMs: perfListEnd - perfListStart,
      cacheCheckMs: perfCacheCheckEnd - perfCacheCheckStart,
      parseMetadataMs: perfParseEnd - perfParseStart,
      totalMs: perfAllEnd - perfAllStart,
      filesCount: songFileUrls.length,
      successCount: success,
      failedCount: failed,
      cacheHits: cachedInfos.length,
      parsedCount: parsedInfos.length
    }
  }
})

// 新增：按需获取单曲封面（在播放时调用）
ipcMain.handle('getSongCover', async (_e, filePath: string) => {
  try {
    const mm = await import('music-metadata')
    const metadata = await mm.parseFile(filePath)
    const cover = mm.selectCover(metadata.common.picture)
    if (!cover) return null
    return { format: cover.format, data: Buffer.from(cover.data) }
  } catch (err) {
    return null
  }
})

ipcMain.handle('getLibrary', async () => {
  const library = await getLibrary()
  return library
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

ipcMain.handle('select-existing-database-file', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'FRKB.database', extensions: ['frkbdb'] }]
  })
  if (result.canceled) return null
  const filePath = result.filePaths[0]
  try {
    if (path.basename(filePath) !== MANIFEST_FILE_NAME) {
      return 'error'
    }
    await readManifestFile(filePath)
    return { filePath, rootDir: path.dirname(filePath), fileName: MANIFEST_FILE_NAME }
  } catch (_e) {
    return 'error'
  }
})

ipcMain.handle('check-database-manifest-exists', async (_e, dirPath: string) => {
  try {
    const target = path.join(dirPath, MANIFEST_FILE_NAME)
    return await fs.pathExists(target)
  } catch (_e) {
    return false
  }
})

ipcMain.handle('probe-database-dir', async (_e, dirPath: string) => {
  try {
    const manifestPath = path.join(dirPath, MANIFEST_FILE_NAME)
    const hasManifest = await fs.pathExists(manifestPath)
    let isEmpty = false
    const exists = await fs.pathExists(dirPath)
    if (!exists) {
      return { hasManifest: false, isLegacy: false, isEmpty: true }
    }
    try {
      const items = await fs.readdir(dirPath)
      isEmpty = items.length === 0
    } catch {}
    const isLegacy = hasManifest ? false : await looksLikeLegacyStructure(dirPath)
    return { hasManifest, isLegacy, isEmpty }
  } catch (_e) {
    return { hasManifest: false, isLegacy: false, isEmpty: false }
  }
})

ipcMain.handle('find-db-root-upwards', async (_e, startDir: string) => {
  try {
    let current = startDir
    // 保护：最多向上 30 层，避免死循环
    for (let i = 0; i < 30; i++) {
      const manifestPath = path.join(current, MANIFEST_FILE_NAME)
      if (await fs.pathExists(manifestPath)) {
        return current
      }
      const parent = path.dirname(current)
      if (!parent || parent === current) break
      current = parent
    }
    return null
  } catch (_e) {
    return null
  }
})

ipcMain.handle('get-windows-hide-ext', async () => {
  if (process.platform !== 'win32') return false
  return await new Promise<boolean>((resolve) => {
    execFile(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced',
        '/v',
        'HideFileExt'
      ],
      { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(false)
        const match = stdout.match(/HideFileExt\s+REG_DWORD\s+0x([0-9a-fA-F]+)/)
        if (!match) return resolve(false)
        const val = parseInt(match[1], 16)
        resolve(val === 1)
      }
    )
  })
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
  const toPath = path.join(
    folderPath,
    'songFingerprint' + getCurrentTimeYYYYMMDDHHMMSSSSS() + '.json'
  )
  await exportSnapshot(toPath, store.songFingerprintList || [])
})

ipcMain.handle('importSongFingerprint', async (e, filePath: string) => {
  const merged = await importFromJsonFile(filePath)
  store.songFingerprintList = merged
  return
})

ipcMain.handle('exportSongListToDir', async (e, folderPathVal, deleteSongsAfterExport, dirPath) => {
  let scanPath = path.join(store.databaseDir, mapRendererPathToFsPath(dirPath))
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
  const tasks: Array<() => Promise<any>> = []
  for (let item of songFileUrls) {
    const matches = item.match(/[^\\]+$/)
    if (Array.isArray(matches) && matches.length > 0) {
      const dest = targetPath + '\\' + matches[0]
      tasks.push(() => moveOrCopyItemWithCheckIsExist(item, dest, deleteSongsAfterExport))
    }
  }
  const batchId = `exportSongList_${Date.now()}`
  const { success, failed, hasENOSPC, skipped, results } = await runWithConcurrency(tasks, {
    concurrency: 16,
    stopOnENOSPC: true,
    onInterrupted: async (payload) =>
      waitForUserDecision(mainWindow.instance ?? null, batchId, 'exportSongList', payload)
  })
  if (hasENOSPC && mainWindow.instance) {
    mainWindow.instance.webContents.send('file-batch-summary', {
      context: 'exportSongList',
      total: tasks.length,
      success,
      failed,
      hasENOSPC,
      skipped,
      errorSamples: results
        .map((r, i) =>
          r instanceof Error ? { code: (r as any).code, message: r.message, index: i } : null
        )
        .filter(Boolean)
        .slice(0, 3)
    })
  }
  // 推满进度，避免 UI 悬挂
  if (mainWindow.instance) {
    mainWindow.instance.webContents.send(
      'progressSet',
      'tracks.copyingTracks',
      tasks.length,
      tasks.length,
      false
    )
  }
  if (failed > 0) {
    throw new Error('exportSongListToDir failed')
  }
  return
})

ipcMain.handle('exportSongsToDir', async (e, folderPathVal, deleteSongsAfterExport, songs) => {
  const tasks: Array<() => Promise<any>> = []
  for (let item of songs) {
    let targetPath = folderPathVal + '\\' + item.filePath.match(/[^\\]+$/)[0]
    tasks.push(() =>
      moveOrCopyItemWithCheckIsExist(item.filePath, targetPath, deleteSongsAfterExport)
    )
  }
  const batchId = `exportSongs_${Date.now()}`
  const { success, failed, hasENOSPC, skipped, results } = await runWithConcurrency(tasks, {
    concurrency: 16,
    stopOnENOSPC: true,
    onInterrupted: async (payload) =>
      waitForUserDecision(mainWindow.instance ?? null, batchId, 'exportSongs', payload)
  })
  if (hasENOSPC && mainWindow.instance) {
    mainWindow.instance.webContents.send('file-batch-summary', {
      context: 'exportSongs',
      total: tasks.length,
      success,
      failed,
      hasENOSPC,
      skipped,
      errorSamples: results
        .map((r, i) =>
          r instanceof Error ? { code: (r as any).code, message: r.message, index: i } : null
        )
        .filter(Boolean)
        .slice(0, 3)
    })
  }
  if (mainWindow.instance) {
    mainWindow.instance.webContents.send(
      'progressSet',
      'tracks.copyingTracks',
      tasks.length,
      tasks.length,
      false
    )
  }
  if (failed > 0) {
    throw new Error('exportSongsToDir failed')
  }
  return
})

ipcMain.handle('moveSongsToDir', async (e, srcs, dest) => {
  const tasks: Array<() => Promise<any>> = []
  for (let src of srcs) {
    const matches = src.match(/[^\\]+$/)
    if (Array.isArray(matches) && matches.length > 0) {
      const targetPath = path.join(store.databaseDir, mapRendererPathToFsPath(dest), matches[0])
      tasks.push(() => moveOrCopyItemWithCheckIsExist(src, targetPath, true))
    }
  }
  const batchId = `moveSongs_${Date.now()}`
  const { success, failed, hasENOSPC, skipped, results } = await runWithConcurrency(tasks, {
    concurrency: 16,
    stopOnENOSPC: true,
    onInterrupted: async (payload) =>
      waitForUserDecision(mainWindow.instance ?? null, batchId, 'moveSongs', payload)
  })
  if (hasENOSPC && mainWindow.instance) {
    mainWindow.instance.webContents.send('file-batch-summary', {
      context: 'moveSongs',
      total: tasks.length,
      success,
      failed,
      hasENOSPC,
      skipped,
      errorSamples: results
        .map((r, i) =>
          r instanceof Error ? { code: (r as any).code, message: r.message, index: i } : null
        )
        .filter(Boolean)
        .slice(0, 3)
    })
  }
  if (mainWindow.instance) {
    mainWindow.instance.webContents.send(
      'progressSet',
      'tracks.movingTracks',
      tasks.length,
      tasks.length,
      false
    )
  }
  if (failed > 0) {
    throw new Error('moveSongsToDir failed')
  }
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
