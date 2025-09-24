import 'dotenv/config'
import { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } from 'electron'
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
      // 应用启动后，延迟对所有歌单目录做一次全量 sweep（保证重启后也能清理空歌单残留封面）
      try {
        setTimeout(async () => {
          const libRoot = path.join(store.databaseDir, 'library')
          const walk = async (dir: string) => {
            try {
              const entries = await fs.readdir(dir, { withFileTypes: true })
              for (const ent of entries) {
                const full = path.join(dir, ent.name)
                if (ent.isDirectory()) {
                  // 若存在 .frkb_covers，则读取索引，空引用直接清理
                  const coversDir = path.join(full, '.frkb_covers')
                  const indexPath = path.join(coversDir, '.index.json')
                  if (await fs.pathExists(indexPath)) {
                    try {
                      const idx = await fs.readJSON(indexPath)
                      const hashToFiles = idx?.hashToFiles || {}
                      const hashToExt = idx?.hashToExt || {}
                      let removed = 0
                      for (const h of Object.keys(hashToFiles)) {
                        const arr = hashToFiles[h]
                        if (!Array.isArray(arr) || arr.length === 0) {
                          const ext = hashToExt[h] || '.jpg'
                          const p = path.join(coversDir, `${h}${ext}`)
                          try {
                            if (await fs.pathExists(p)) {
                              await fs.remove(p)
                              removed++
                            }
                          } catch {}
                          delete hashToFiles[h]
                          delete hashToExt[h]
                        }
                      }
                      if (removed > 0) {
                        await fs.writeJSON(indexPath, {
                          fileToHash: idx?.fileToHash || {},
                          hashToFiles,
                          hashToExt
                        })
                      }
                    } catch {}
                  }
                  await walk(full)
                }
              }
            } catch {}
          }
          await walk(libRoot)
        }, 2000)
      } catch {}
    } catch (_e) {
      databaseInitWindow.createWindow({ needErrorHint: true })
    }
  }

  const autoUpdater = electronUpdater.autoUpdater
  autoUpdater.autoDownload = false
  const versionString = app.getVersion()
  const isPrerelease = versionString.includes('-')
  // 预发布轨道仅更新到预发布；稳定轨道仅更新到稳定
  try {
    ;(autoUpdater as any).allowPrerelease = isPrerelease
  } catch {}
  // 若为 rc 预发布，固定通道为 rc，对应 CI 已产出 rc.yml / rc-mac.yml
  try {
    if (isPrerelease && /-rc[.-]/i.test(versionString)) {
      ;(autoUpdater as any).channel = 'rc'
    }
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
    // 使用统一封装设置隐藏
    await operateHiddenFile(cacheFile, async () => {})
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

// 新增：返回封面缩略图文件URL（按需生成并缓存到磁盘）。目前不做重采样，仅写入嵌入图原始数据，后续可接入 sharp 生成固定尺寸。
ipcMain.handle(
  'getSongCoverThumb',
  async (_e, filePath: string, size: number = 48, listRootDir?: string | null) => {
    try {
      // Windows: 辅助函数设置隐藏属性
      const setHidden = async (targetPath: string) => {
        try {
          if (process.platform !== 'win32') return
          const { exec } = await import('child_process')
          const { promisify } = await import('util')
          const execAsync = promisify(exec)
          await execAsync(`attrib +h "${targetPath}"`)
        } catch {}
      }
      const mm = await import('music-metadata')
      const { pathToFileURL } = await import('url')
      const crypto = await import('crypto')
      const stat = await fs.stat(filePath)

      // 封面缓存目录：仅允许放在“具体歌单目录/.frkb_covers”下；未提供则不落盘，仅返回 dataUrl
      // 接收来自渲染层的路径，可能是相对路径（以 library 树相对路径表示）
      let resolvedRoot: string | null = null
      if (listRootDir && typeof listRootDir === 'string' && listRootDir.length > 0) {
        let input = listRootDir
        // Windows 平台下，渲染层可能传入以 '/library/...' 开头的“相对库路径”，不能按 OS 绝对路径处理
        if (process.platform === 'win32' && /^\//.test(input)) {
          input = input.replace(/^\/+/, '') // 去掉前导 '/'
        }
        if (path.isAbsolute(input)) {
          // 现在的绝对路径才是真正 OS 级别的绝对路径
          resolvedRoot = input
        } else {
          // 视为库相对路径，映射核心库实际目录名后再拼到数据库根目录
          const mapped = mapRendererPathToFsPath(input)
          resolvedRoot = path.join(store.databaseDir, mapped)
        }
      }
      const isAbs = !!(resolvedRoot && path.isAbsolute(resolvedRoot))
      const exists = isAbs ? await fs.pathExists(resolvedRoot as string) : false
      const useDiskCache = isAbs && exists
      const coversDir = useDiskCache ? path.join(resolvedRoot as string, '.frkb_covers') : null
      if (useDiskCache && coversDir) {
        await fs.ensureDir(coversDir)
        // 使用统一封装，确保目录设置为隐藏
        await operateHiddenFile(coversDir, async () => {})
      }

      // 引入索引：.frkb_covers/.index.json 记录 filePath<->imageHash 与 hash->ext
      type CoverIndex = {
        fileToHash: Record<string, string>
        hashToFiles: Record<string, string[]>
        hashToExt: Record<string, string>
      }
      const indexPath = useDiskCache && coversDir ? path.join(coversDir, '.index.json') : null
      const loadIndex = async (): Promise<CoverIndex> => {
        if (!indexPath) return { fileToHash: {}, hashToFiles: {}, hashToExt: {} }
        try {
          const json = await fs.readJSON(indexPath)
          return {
            fileToHash: json?.fileToHash || {},
            hashToFiles: json?.hashToFiles || {},
            hashToExt: json?.hashToExt || {}
          }
        } catch {
          return { fileToHash: {}, hashToFiles: {}, hashToExt: {} }
        }
      }
      const saveIndex = async (idx: CoverIndex) => {
        if (!indexPath) return
        try {
          await fs.writeJSON(indexPath, idx)
        } catch {}
      }
      const ensureArrHas = (arr: string[], v: string) => {
        if (arr.indexOf(v) === -1) arr.push(v)
        return arr
      }
      const mimeFromExt = (ext: string) =>
        ext === '.png'
          ? 'image/png'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.gif'
              ? 'image/gif'
              : ext === '.bmp'
                ? 'image/bmp'
                : 'image/jpeg'
      const extFromMime = (mime: string) => {
        const lower = (mime || '').toLowerCase()
        if (lower.includes('png')) return '.png'
        if (lower.includes('webp')) return '.webp'
        if (lower.includes('gif')) return '.gif'
        if (lower.includes('bmp')) return '.bmp'
        return '.jpg'
      }

      // 优先命中索引
      if (useDiskCache && coversDir) {
        const idx = await loadIndex()
        const known = idx.fileToHash[filePath]
        if (known) {
          const ext = idx.hashToExt[known] || '.jpg'
          const p = path.join(coversDir, `${known}${ext}`)
          if (await fs.pathExists(p)) {
            const st0 = await fs.stat(p)
            if (st0.size > 0) {
              const data = await fs.readFile(p)
              const mime = mimeFromExt(ext)
              const dataUrl = `data:${mime};base64,${data.toString('base64')}`
              return { format: mime, data, dataUrl }
            }
          }
        }
      }

      // 解析嵌入封面
      let format = 'image/jpeg'
      let data: Buffer | null = null
      try {
        const metadata = await mm.parseFile(filePath)
        const cover = mm.selectCover(metadata.common.picture)
        if (!cover) {
          return null
        }
        format = cover.format || 'image/jpeg'
        // 兼容 Buffer / Uint8Array / Array<number> / TypedArray / DataView
        const raw: any = cover.data as any
        if (Buffer.isBuffer(raw)) {
          data = raw
        } else if (raw instanceof Uint8Array) {
          data = Buffer.from(raw)
        } else if (Array.isArray(raw)) {
          data = Buffer.from(raw)
        } else if (raw && raw.buffer && typeof raw.byteLength === 'number') {
          // 其他 TypedArray / DataView
          try {
            const view = new Uint8Array(raw.buffer, raw.byteOffset || 0, raw.byteLength)
            data = Buffer.from(view)
          } catch {
            data = null
          }
        } else if (raw && raw.data && Array.isArray(raw.data)) {
          data = Buffer.from(raw.data)
        } else {
          data = null
        }
      } catch (_err: any) {
        return null
      }

      if (!data || data.length === 0) {
        return null
      }

      // 基于内容生成哈希，避免增殖
      const imageHash = crypto.createHash('sha1').update(data).digest('hex')
      const ext = extFromMime(format)

      const mime = format || 'image/jpeg'
      const dataUrl = `data:${mime};base64,${data.toString('base64')}`
      // 若允许磁盘缓存，落盘一份；否则仅返回内存 dataUrl
      if (useDiskCache && coversDir) {
        const targetPath = path.join(coversDir, `${imageHash}${ext}`)
        const tmp = `${targetPath}.tmp_${Date.now()}`
        try {
          await fs.writeFile(tmp, data)
          await fs.move(tmp, targetPath, { overwrite: true })
          // 使用统一封装为封面文件设置隐藏
          await operateHiddenFile(targetPath, async () => {})
          const idx = await loadIndex()
          idx.fileToHash[filePath] = imageHash
          idx.hashToFiles[imageHash] = ensureArrHas(idx.hashToFiles[imageHash] || [], filePath)
          idx.hashToExt[imageHash] = ext
          await saveIndex(idx)
        } catch {
        } finally {
          try {
            if (await fs.pathExists(tmp)) await fs.remove(tmp)
          } catch {}
        }
      }
      return { format: mime, data, dataUrl }
    } catch (err: any) {
      return null
    }
  }
)

// 标记清除：根据当前歌单实际曲目引用清理无引用封面
ipcMain.handle(
  'sweepSongListCovers',
  async (_e, listRootDir: string, currentFilePaths: string[]) => {
    try {
      if (!listRootDir || typeof listRootDir !== 'string') return { removed: 0 }
      let input = listRootDir
      if (process.platform === 'win32' && /^\//.test(input)) input = input.replace(/^\/+/, '')
      const mapped = path.isAbsolute(input) ? input : mapRendererPathToFsPath(input)
      const resolvedRoot = path.isAbsolute(mapped) ? mapped : path.join(store.databaseDir, mapped)
      const coversDir = path.join(resolvedRoot, '.frkb_covers')
      // 移除清扫日志
      if (!(await fs.pathExists(coversDir))) return { removed: 0 }

      const indexPath = path.join(coversDir, '.index.json')
      let idx: any = { fileToHash: {}, hashToFiles: {}, hashToExt: {} }
      try {
        const json = await fs.readJSON(indexPath)
        idx.fileToHash = json?.fileToHash || {}
        idx.hashToFiles = json?.hashToFiles || {}
        idx.hashToExt = json?.hashToExt || {}
      } catch {}

      const alive = new Set(currentFilePaths || [])
      // 移除 fileToHash 中不在 alive 的映射，并更新 hashToFiles
      for (const fp of Object.keys(idx.fileToHash)) {
        if (!alive.has(fp)) {
          const h = idx.fileToHash[fp]
          delete idx.fileToHash[fp]
          if (Array.isArray(idx.hashToFiles[h])) {
            idx.hashToFiles[h] = idx.hashToFiles[h].filter((x: string) => x !== fp)
          }
        }
      }
      // 删除无引用的 hash 文件（先按索引，再兜底扫描）
      let removed = 0
      const liveHashes = new Set<string>()
      for (const h of Object.keys(idx.hashToFiles)) {
        const arr = idx.hashToFiles[h]
        if (Array.isArray(arr) && arr.length > 0) liveHashes.add(h)
      }
      for (const h of Object.keys(idx.hashToFiles)) {
        const arr = idx.hashToFiles[h]
        if (!Array.isArray(arr) || arr.length === 0) {
          const ext = idx.hashToExt[h] || '.jpg'
          const p = path.join(coversDir, `${h}${ext}`)
          try {
            if (await fs.pathExists(p)) {
              await fs.remove(p)
              removed++
            }
          } catch {}
          delete idx.hashToFiles[h]
          delete idx.hashToExt[h]
        }
      }
      // 兜底：目录扫描，删除索引外的孤儿文件和遗留 tmp
      try {
        const entries = await fs.readdir(coversDir)
        const imgRegex = /^[a-f0-9]{40}\.(jpg|png|webp|gif|bmp)$/i
        for (const name of entries) {
          const full = path.join(coversDir, name)
          if (name.includes('.tmp_')) {
            try {
              await fs.remove(full)
            } catch {}
            continue
          }
          if (!imgRegex.test(name)) continue
          const hash = name.slice(0, 40).toLowerCase()
          if (!liveHashes.has(hash)) {
            try {
              await fs.remove(full)
              removed++
            } catch {}
          }
        }
      } catch {}

      await fs.writeJSON(indexPath, idx)
      return { removed }
    } catch {
      return { removed: 0 }
    }
  }
)

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
