import 'dotenv/config'
import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } from 'electron'
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
import { saveList, exportSnapshot, importFromJsonFile } from './fingerprintStore'
import { initDatabaseStructure } from './initDatabase'
import mainWindow from './window/mainWindow'
import databaseInitWindow from './window/databaseInitWindow'
import { is } from '@electron-toolkit/utils'
import store from './store'
import foundNewVersionWindow from './window/foundNewVersionWindow'
import updateWindow from './window/updateWindow'
import electronUpdater = require('electron-updater')
import { readManifestFile, MANIFEST_FILE_NAME, looksLikeLegacyStructure } from './databaseManifest'
import { setupMacMenus, rebuildMacMenusForCurrentFocus } from './menu/macMenu'
import { prepareAndOpenMainWindow } from './bootstrap/prepareDatabase'
import { execFile } from 'child_process'
import { ISongInfo } from '../types/globals'
import type { ISettingConfig } from '../types/globals'
import { scanSongList as svcScanSongList } from './services/scanSongs'
import {
  getSongCover as svcGetSongCover,
  getSongCoverThumb as svcGetSongCoverThumb,
  sweepSongListCovers as svcSweepSongListCovers
} from './services/covers'
import { v4 as uuidV4 } from 'uuid'
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
import os = require('os')
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
    themeMode: 'system',
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
  themeMode: 'system' as 'system' | 'light' | 'dark',
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
  showPlaylistTrackCount: true,
  nextCheckUpdateTime: '',
  // 错误日志上报默认配置
  enableErrorReport: true,
  errorReportUsageMsSinceLastSuccess: 0,
  errorReportRetryMsSinceLastFailure: -1,
  // 指纹模式：默认使用 PCM 内容哈希；如检测到旧库会在后续流程强制切为 file
  fingerprintMode: 'pcm' as 'pcm',
  // 云同步用户 Key（可为空，由设置页配置）
  cloudSyncUserKey: '',
  // 转码默认值（首次默认 MP3，新文件、不覆盖、保留元数据）
  convertDefaults: {
    targetFormat: 'mp3',
    bitrateKbps: 320,
    sampleRate: 44100,
    channels: 2,
    preserveMetadata: true,
    normalize: false,
    strategy: 'new_file',
    overwrite: false,
    backupOnReplace: true,
    addFingerprint: false
  }
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
const finalSettings: ISettingConfig = {
  ...defaultSettings,
  ...(loadedSettings as Partial<ISettingConfig>)
}

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

// 根据设置应用主题，并在 system 模式下广播一次当前状态
function applyThemeFromSettings() {
  try {
    const mode = ((store as any).settingConfig?.themeMode || 'system') as
      | 'system'
      | 'light'
      | 'dark'
    nativeTheme.themeSource = mode
  } catch {}
}
function broadcastSystemThemeIfNeeded() {
  try {
    const mode = ((store as any).settingConfig?.themeMode || 'system') as
      | 'system'
      | 'light'
      | 'dark'
    if (mode === 'system' && mainWindow.instance) {
      mainWindow.instance.webContents.send('theme/system-updated', {
        isDark: nativeTheme.shouldUseDarkColors
      })
    }
  } catch {}
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('frkb.coderDjing')
  // 设置应用显示名称为 FRKB（影响菜单栏左上角 App 菜单标题）
  try {
    app.setName('FRKB')
  } catch {}
  // 启动即按设置应用主题
  applyThemeFromSettings()
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  // macOS：交由模块化方法统一处理菜单
  if (process.platform === 'darwin') {
    setupMacMenus()
  }
  // 数据库准备与主窗口：统一调用幂等流程
  await prepareAndOpenMainWindow()
  // 初次创建窗口后，若为跟随系统，广播一次当前主题
  broadcastSystemThemeIfNeeded()
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
      await prepareAndOpenMainWindow()
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
ipcMain.handle('setSetting', async (e, setting) => {
  const prevMode = ((store as any).settingConfig?.fingerprintMode as 'pcm' | 'file') || 'pcm'
  store.settingConfig = setting
  await fs.outputJson(url.settingConfigFileUrl, setting)
  // 主题切换：应用到 nativeTheme，并在 system 模式下广播
  try {
    applyThemeFromSettings()
    broadcastSystemThemeIfNeeded()
  } catch {}
  // 指纹模式切换：即时切换内存列表并按新模式加载
  try {
    const nextMode = ((store as any).settingConfig?.fingerprintMode as 'pcm' | 'file') || 'pcm'
    if (nextMode !== prevMode) {
      const FingerprintStore = require('./fingerprintStore')
      const list = await FingerprintStore.loadList(nextMode)
      store.songFingerprintList = Array.isArray(list) ? list : []
    }
  } catch {}
  // 语言切换时（macOS）重建菜单
  if (process.platform === 'darwin') {
    rebuildMacMenusForCurrentFocus()
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
  const descPath = path.join(recycleBinTargetDir, '.description.json')
  await operateHiddenFile(descPath, async () => {
    // 若已存在则跳过写入，避免同一分钟多次覆盖 uuid
    if (!(await fs.pathExists(descPath))) {
      await fs.outputJSON(descPath, descriptionJson)
    }
  })
  // 发送前优先读取已存在的描述，确保 uuid 一致，避免同名多节点
  try {
    const existing = await fs.readJSON(descPath)
    descriptionJson = { ...descriptionJson, ...existing }
  } catch {}
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

ipcMain.handle('scanSongList', async (e, songListPath: string | string[], songListUUID: string) => {
  if (typeof songListPath === 'string') {
    const scanPath = path.join(store.databaseDir, mapRendererPathToFsPath(songListPath))
    return await svcScanSongList(scanPath, store.settingConfig.audioExt, songListUUID)
  } else {
    // 处理数组情况
    const scanPaths = songListPath.map((p) =>
      path.join(store.databaseDir, mapRendererPathToFsPath(p))
    )
    return await svcScanSongList(scanPaths, store.settingConfig.audioExt, songListUUID)
  }
})

// 获取歌单曲目数量（快速计数，不解析元数据）
ipcMain.handle('getSongListTrackCount', async (_e, songListPath: string) => {
  try {
    const scanPath = path.join(store.databaseDir, mapRendererPathToFsPath(songListPath))
    const files = await collectFilesWithExtensions(scanPath, store.settingConfig.audioExt)
    return Array.isArray(files) ? files.length : 0
  } catch (_e) {
    return 0
  }
})

// 新增：按需获取单曲封面（在播放时调用）
ipcMain.handle('getSongCover', async (_e, filePath: string) => {
  return await svcGetSongCover(filePath)
})

// 新增：返回封面缩略图文件URL（按需生成并缓存到磁盘）。目前不做重采样，仅写入嵌入图原始数据，后续可接入 sharp 生成固定尺寸。
ipcMain.handle(
  'getSongCoverThumb',
  async (_e, filePath: string, size: number = 48, listRootDir?: string | null) => {
    return await svcGetSongCoverThumb(filePath, size, listRootDir)
  }
)

// 标记清除：根据当前歌单实际曲目引用清理无引用封面
ipcMain.handle(
  'sweepSongListCovers',
  async (_e, listRootDir: string, currentFilePaths: string[]) => {
    return await svcSweepSongListCovers(listRootDir, currentFilePaths)
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

ipcMain.handle('get-user-home', async () => {
  return os.homedir()
})

ipcMain.handle('get-drives', async () => {
  try {
    const { exec } = require('child_process')
    const { promisify } = require('util')
    const execAsync = promisify(exec)

    if (process.platform === 'win32') {
      // Windows: 使用更可靠的方式获取驱动器信息
      try {
        // 首先尝试使用 PowerShell (如果可用)
        const { stdout: psStdout } = await execAsync(
          'powershell -command "Get-WmiObject Win32_LogicalDisk | Select-Object DeviceID, Size, FreeSpace | ConvertTo-Json"'
        )
        const drivesData = JSON.parse(psStdout)
        const drives = drivesData.map((drive: any) => ({
          name: drive.DeviceID,
          path: drive.DeviceID,
          type: 'drive',
          size: parseInt(drive.Size) || 0,
          freeSpace: parseInt(drive.FreeSpace) || 0
        }))
        return drives.filter((drive: any) => drive.name)
      } catch (psError) {
        // 如果 PowerShell 失败，回退到 wmic
        console.log('PowerShell failed, falling back to wmic:', psError)
        const { stdout } = await execAsync('wmic logicaldisk get name,size,freespace')
        const lines = stdout.split('\n').slice(1) // 跳过标题行
        const drives = lines
          .filter((line: string) => line.trim() && /^[A-Z]:\s+\d+\s+\d+$/.test(line.trim()))
          .map((line: string) => {
            const parts = line.trim().split(/\s+/)
            // 确保正确解析：name, size, freeSpace
            const name = parts[0] || ''
            const sizeStr = parts[1] || '0'
            const freeSpaceStr = parts[2] || '0'

            return {
              name: name,
              path: name, // 驱动器路径就是名称本身，如 "C:"
              type: 'drive',
              size: parseInt(sizeStr) || 0,
              freeSpace: parseInt(freeSpaceStr) || 0
            }
          })
          .filter((drive: any) => drive.name) // 过滤掉空名称的驱动器
        return drives
      }
    } else if (process.platform === 'darwin') {
      // macOS: 列出 /Volumes 目录
      const volumes = await fs.readdir('/Volumes')
      const drives = volumes.map((volume) => ({
        name: volume,
        path: `/Volumes/${volume}`,
        type: 'drive'
      }))
      return drives
    } else {
      // Linux: 列出挂载点
      const { stdout } = await execAsync('lsblk -o NAME,MOUNTPOINT -n -l')
      const lines: string[] = stdout.split('\n')
      const drives = lines
        .filter((line: string) => line.trim() && line.includes('/'))
        .map((line: string) => {
          const parts = line.trim().split(/\s+/)
          return {
            name: parts[0],
            path: parts[1],
            type: 'drive'
          }
        })
      return drives
    }
  } catch (wmicError) {
    // 如果 PowerShell 和 wmic 都失败了，尝试使用 Node.js fs 模块
    console.log('Both PowerShell and wmic failed, trying fs.readdir:', wmicError)
    try {
      // 尝试读取根目录下的所有驱动器
      const rootItems = await fs.readdir('C:/') // 至少有一个C盘
      const drives = []

      // 检查常见的驱动器字母
      const driveLetters = [
        'A',
        'B',
        'C',
        'D',
        'E',
        'F',
        'G',
        'H',
        'I',
        'J',
        'K',
        'L',
        'M',
        'N',
        'O',
        'P',
        'Q',
        'R',
        'S',
        'T',
        'U',
        'V',
        'W',
        'X',
        'Y',
        'Z'
      ]

      for (const letter of driveLetters) {
        const drivePath = `${letter}:`
        try {
          // 对于驱动器，我们需要检查它是否真的存在且可访问
          const stats = await fs.stat(drivePath)
          if (stats.isDirectory()) {
            drives.push({
              name: drivePath,
              path: drivePath,
              type: 'drive',
              size: 0,
              freeSpace: 0
            })
          }
        } catch {
          // 驱动器不存在，跳过
        }
      }

      return drives
    } catch (fsError) {
      console.error('All drive detection methods failed:', fsError)
      return []
    }
  }
})

ipcMain.handle('read-directory', async (event, dirPath: string) => {
  try {
    // 确保路径格式正确，特殊处理驱动器路径
    let normalizedPath: string
    if (dirPath.match(/^[A-Z]:$/i)) {
      // 驱动器路径，直接使用，不进行resolve
      normalizedPath = dirPath + '/'
    } else {
      // 普通路径，进行resolve
      normalizedPath = path.resolve(dirPath).replace(/\\/g, '/')
    }

    const items = await fs.readdir(normalizedPath, { withFileTypes: true })
    const result = await Promise.all(
      items.map(async (item) => {
        const itemPath = path.join(normalizedPath, item.name)
        let size = 0
        if (item.isFile()) {
          try {
            const stats = await fs.stat(itemPath)
            size = stats.size
          } catch {
            size = 0
          }
        }
        return {
          name: item.name,
          path: itemPath,
          isDirectory: item.isDirectory(),
          isFile: item.isFile(),
          size
        }
      })
    )
    return result
  } catch (error) {
    throw new Error(`无法读取目录 ${dirPath}: ${error}`)
  }
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
  // 初始进度：0/总数（对象事件，带 id）
  if (mainWindow.instance) {
    mainWindow.instance.webContents.send('progressSet', {
      id: batchId,
      titleKey: 'tracks.copyingTracks',
      now: 0,
      total: tasks.length,
      isInitial: true
    })
  }
  const { success, failed, hasENOSPC, skipped, results } = await runWithConcurrency(tasks, {
    concurrency: 16,
    onProgress: (done, total) => {
      if (mainWindow.instance) {
        mainWindow.instance.webContents.send('progressSet', {
          id: batchId,
          titleKey: 'tracks.copyingTracks',
          now: done,
          total
        })
      }
    },
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
    mainWindow.instance.webContents.send('progressSet', {
      id: batchId,
      titleKey: 'tracks.copyingTracks',
      now: tasks.length,
      total: tasks.length
    })
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
  // 初始进度：0/总数
  if (mainWindow.instance) {
    mainWindow.instance.webContents.send('progressSet', {
      id: batchId,
      titleKey: 'tracks.copyingTracks',
      now: 0,
      total: tasks.length,
      isInitial: true
    })
  }
  const { success, failed, hasENOSPC, skipped, results } = await runWithConcurrency(tasks, {
    concurrency: 16,
    onProgress: (done, total) => {
      if (mainWindow.instance) {
        mainWindow.instance.webContents.send('progressSet', {
          id: batchId,
          titleKey: 'tracks.copyingTracks',
          now: done,
          total
        })
      }
    },
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
    mainWindow.instance.webContents.send('progressSet', {
      id: batchId,
      titleKey: 'tracks.copyingTracks',
      now: tasks.length,
      total: tasks.length
    })
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
  // 初始进度：0/总数
  if (mainWindow.instance) {
    mainWindow.instance.webContents.send('progressSet', {
      id: batchId,
      titleKey: 'tracks.movingTracks',
      now: 0,
      total: tasks.length,
      isInitial: true
    })
  }
  const { success, failed, hasENOSPC, skipped, results } = await runWithConcurrency(tasks, {
    concurrency: 16,
    onProgress: (done, total) => {
      if (mainWindow.instance) {
        mainWindow.instance.webContents.send('progressSet', {
          id: batchId,
          titleKey: 'tracks.movingTracks',
          now: done,
          total
        })
      }
    },
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
    mainWindow.instance.webContents.send('progressSet', {
      id: batchId,
      titleKey: 'tracks.movingTracks',
      now: tasks.length,
      total: tasks.length
    })
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
