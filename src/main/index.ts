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
  mapRendererPathToFsPath,
  getSongsAnalyseResult
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
import whatsNewWindow, { type WhatsNewReleasePayload } from './window/whatsNewWindow'
import electronUpdater = require('electron-updater')
import { readManifestFile, MANIFEST_FILE_NAME, looksLikeLegacyStructure } from './databaseManifest'
import { setupMacMenus, rebuildMacMenusForCurrentFocus } from './menu/macMenu'
import { prepareAndOpenMainWindow } from './bootstrap/prepareDatabase'
import { execFile, execFileSync } from 'child_process'
import { ISongInfo, ITrackMetadataUpdatePayload } from '../types/globals'
import type { ISettingConfig } from '../types/globals'
import { scanSongList as svcScanSongList } from './services/scanSongs'
import { resolveBundledFfmpegPath, ensureExecutableOnMac } from './ffmpeg'
import {
  getSongCover as svcGetSongCover,
  getSongCoverThumb as svcGetSongCoverThumb,
  sweepSongListCovers as svcSweepSongListCovers
} from './services/covers'
import {
  readTrackMetadata as svcReadTrackMetadata,
  updateTrackMetadata as svcUpdateTrackMetadata
} from './services/metadataEditor'
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
import os = require('os')
const platform = process.platform
const ffmpegPath = resolveBundledFfmpegPath()
process.env.FRKB_FFMPEG_PATH = ffmpegPath
void ensureExecutableOnMac(ffmpegPath)
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
    audioExt: [
      '.mp3',
      '.wav',
      '.flac',
      '.aif',
      '.aiff',
      '.ogg',
      '.opus',
      '.aac',
      '.m4a',
      '.mp4',
      '.wma',
      '.ac3',
      '.dts',
      '.mka',
      '.webm',
      '.ape',
      '.tak',
      '.tta',
      '.wv'
    ],
    databaseUrl: '',
    globalCallShortcut:
      platform === 'win32' ? 'Ctrl+Alt+F' : platform === 'darwin' ? 'Command+Option+F' : '',
    hiddenPlayControlArea: false,
    waveformStyle: 'SoundCloud' as 'SoundCloud' | 'RGB',
    waveformMode: 'half',
    autoPlayNextSong: false,
    startPlayPercent: 0,
    endPlayPercent: 100,
    fastForwardTime: 10,
    fastBackwardTime: -5,
    autoScrollToCurrentSong: true,
    enablePlaybackRange: false,
    recentDialogSelectedSongListMaxCount: 10,
    persistSongFilters: false,
    enableExplorerContextMenu: platform === 'win32'
  })
}

// 定义默认设置结构
const defaultConvertDefaults: NonNullable<ISettingConfig['convertDefaults']> = {
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

const defaultSettings = {
  platform: (platform === 'darwin' ? 'darwin' : 'win32') as 'darwin' | 'win32',
  language: (is.dev ? 'zhCN' : '') as '' | 'enUS' | 'zhCN',
  themeMode: 'system' as 'system' | 'light' | 'dark',
  audioExt: [
    '.mp3',
    '.wav',
    '.flac',
    '.aif',
    '.aiff',
    '.ogg',
    '.opus',
    '.aac',
    '.m4a',
    '.mp4',
    '.wma',
    '.ac3',
    '.dts',
    '.mka',
    '.webm',
    '.ape',
    '.tak',
    '.tta',
    '.wv'
  ],
  databaseUrl: '',
  globalCallShortcut:
    platform === 'win32' ? 'Ctrl+Alt+F' : platform === 'darwin' ? 'Command+Option+F' : '',
  hiddenPlayControlArea: false,
  waveformStyle: 'SoundCloud' as 'SoundCloud' | 'RGB',
  waveformMode: 'half',
  autoPlayNextSong: false,
  startPlayPercent: 0,
  endPlayPercent: 100,
  fastForwardTime: 10,
  fastBackwardTime: -5,
  autoScrollToCurrentSong: true,
  enablePlaybackRange: false,
  recentDialogSelectedSongListMaxCount: 10,
  audioOutputDeviceId: '',
  persistSongFilters: false,
  enableExplorerContextMenu: platform === 'win32',
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
  convertDefaults: defaultConvertDefaults,
  // “更新日志”弹窗记录字段
  lastSeenWhatsNewVersion: '',
  pendingWhatsNewForVersion: ''
}

const WHATS_NEW_RELEASE_URL =
  'https://api.github.com/repos/coderDJing/FRKB_Rapid-Audio-Organization-Tool/releases/latest'

type WhatsNewStatePatch = Partial<
  Pick<ISettingConfig, 'lastSeenWhatsNewVersion' | 'pendingWhatsNewForVersion'>
>

const toSafeString = (val: unknown): string => {
  if (typeof val === 'string') return val
  return ''
}

async function persistWhatsNewState(patch: WhatsNewStatePatch) {
  const nextSetting = {
    ...store.settingConfig,
    ...patch
  }
  store.settingConfig = nextSetting
  try {
    await fs.outputJson(url.settingConfigFileUrl, nextSetting)
  } catch (error) {
    log.error('[whatsNew] 持久化设置失败', error)
  }
}

async function fetchLatestStableRelease(
  currentVersion: string
): Promise<WhatsNewReleasePayload | null> {
  try {
    const res = await fetch(WHATS_NEW_RELEASE_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `FRKB/${currentVersion}`
      }
    })
    if (!res.ok) {
      log.error('[whatsNew] 拉取 GitHub release 失败', { status: res.status })
      return null
    }
    const data = await res.json()
    const payload: WhatsNewReleasePayload = {
      title: toSafeString(data?.name || data?.tag_name),
      tagName: toSafeString(data?.tag_name),
      body: toSafeString(data?.body),
      publishedAt: toSafeString(data?.published_at),
      htmlUrl: toSafeString(data?.html_url),
      currentVersion
    }
    return payload
  } catch (error) {
    log.error('[whatsNew] 拉取 GitHub release 异常', error)
    return null
  }
}

async function maybeShowWhatsNew() {
  const currentVersion = app.getVersion()
  if (is.dev || currentVersion.includes('-')) {
    return
  }
  const lastSeen = toSafeString(store.settingConfig.lastSeenWhatsNewVersion)
  const pending = toSafeString(store.settingConfig.pendingWhatsNewForVersion)

  const shouldRetry = pending === currentVersion
  const isFirstLaunchForVersion = lastSeen !== currentVersion
  if (!shouldRetry && !isFirstLaunchForVersion) return

  const release = await fetchLatestStableRelease(currentVersion)
  if (!release) {
    await persistWhatsNewState({ pendingWhatsNewForVersion: currentVersion })
    return
  }

  await persistWhatsNewState({ pendingWhatsNewForVersion: '' })
  whatsNewWindow.open(release)
}

ipcMain.on('whatsNew-acknowledge', async (_event, options?: { skipClose?: boolean }) => {
  try {
    const currentVersion = app.getVersion()
    await persistWhatsNewState({
      lastSeenWhatsNewVersion: currentVersion,
      pendingWhatsNewForVersion: ''
    })
  } catch (error) {
    log.error('[whatsNew] 记录已查看版本失败', error)
  } finally {
    if (!options?.skipClose) {
      try {
        whatsNewWindow.instance?.close()
      } catch {}
    }
  }
})

ipcMain.on('showWhatsNew', async () => {
  try {
    const release = await fetchLatestStableRelease(app.getVersion())
    if (release) {
      whatsNewWindow.open(release)
    }
  } catch (error) {
    log.error('[whatsNew] showWhatsNew 手动打开失败', error)
  }
})

store.layoutConfig = fs.readJSONSync(url.layoutConfigFileUrl)

const settingFileExisted = fs.pathExistsSync(url.settingConfigFileUrl)

// 加载并合并设置
let loadedSettings = {}
if (settingFileExisted) {
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

// 合并默认设置与加载的设置，确保所有键都存在，并对关键字段做类型收敛
const mergedSettings = {
  ...defaultSettings,
  ...(loadedSettings as Partial<ISettingConfig>)
}

const finalSettings: ISettingConfig = {
  ...mergedSettings,
  waveformMode: mergedSettings.waveformMode === 'full' ? 'full' : 'half'
}
if (process.platform === 'win32') {
  if (typeof (finalSettings as any).enableExplorerContextMenu !== 'boolean') {
    ;(finalSettings as any).enableExplorerContextMenu = settingFileExisted
      ? hasWindowsContextMenu()
      : true
  }
} else {
  ;(finalSettings as any).enableExplorerContextMenu = false
}

// 一次性迁移：默认勾选所有格式（升级老版本时补齐），并写入迁移标记
try {
  const migrated = (loadedSettings as any)?.migratedAudioExtAll === true
  if (!migrated) {
    const arr = Array.isArray((finalSettings as any).audioExt)
      ? ((finalSettings as any).audioExt as string[])
      : []
    const set = new Set(arr.map((e) => String(e || '').toLowerCase()))

    // 所有支持的格式（Symphonia + FFmpeg 回退）
    const allFormats = [
      '.mp3',
      '.wav',
      '.flac',
      '.aif',
      '.aiff',
      '.ogg',
      '.opus',
      '.aac',
      '.m4a',
      '.mp4',
      '.wma',
      '.ac3',
      '.dts',
      '.mka',
      '.webm',
      '.ape',
      '.tak',
      '.tta',
      '.wv'
    ]

    let changed = false
    for (const fmt of allFormats) {
      if (!set.has(fmt.toLowerCase())) {
        arr.push(fmt)
        changed = true
      }
    }

    if (changed) {
      ;(finalSettings as any).audioExt = arr
      ;(finalSettings as any).migratedAudioExtAll = true
    }
  }
} catch (_e) {
  // 忽略迁移异常，保持既有行为
}

// 更新 store
store.settingConfig = finalSettings

// 将可能更新的设置持久化回文件
// 确保即使文件最初不存在，或者读取出错时，最终也会写入一个有效的配置文件
fs.outputJsonSync(url.settingConfigFileUrl, finalSettings)

const WINDOWS_LEGACY_CONTEXT_MENU_REG_PATH = 'HKCU\\Software\\Classes\\*\\shell\\PlayWithFRKB'
const externalOpenQueue: string[] = []
const externalOpenSeen = new Set<string>()
let processingExternalOpen = false

const normalizeExternalPathKey = (p: string): string => {
  try {
    const resolved = path.resolve(p)
    return os.platform() === 'win32' ? resolved.toLowerCase() : resolved
  } catch {
    return os.platform() === 'win32' ? String(p || '').toLowerCase() : String(p || '')
  }
}

const getAudioExtSet = (): Set<string> => {
  try {
    return new Set(
      (store.settingConfig.audioExt || []).map((ext) => String(ext || '').toLowerCase())
    )
  } catch {
    return new Set<string>()
  }
}
const getWindowsContextMenuPaths = (): string[] => {
  if (process.platform !== 'win32') return []
  const extensions = Array.isArray(store.settingConfig.audioExt) ? store.settingConfig.audioExt : []
  const normalized = extensions
    .map((ext) => {
      const trimmed = String(ext || '').trim()
      if (!trimmed) return ''
      return trimmed.startsWith('.') ? trimmed : `.${trimmed}`
    })
    .filter(Boolean)
  const unique = Array.from(new Set(normalized.map((ext) => ext.toLowerCase())))
  return unique.map(
    (ext) => `HKCU\\Software\\Classes\\SystemFileAssociations\\${ext}\\shell\\PlayWithFRKB`
  )
}
const getWindowsContextMenuCommandPaths = (): string[] => {
  return getWindowsContextMenuPaths().map((p) => `${p}\\command`)
}

const isSupportedAudioPath = (filePath: string): boolean => {
  try {
    const ext = path.extname(filePath || '').toLowerCase()
    if (!getAudioExtSet().has(ext)) return false
    return fs.pathExistsSync(filePath)
  } catch {
    return false
  }
}

function collectSupportedAudioPaths(paths: string[]): string[] {
  const accepted: string[] = []
  for (const raw of paths || []) {
    if (!raw || typeof raw !== 'string') continue
    const normalized = path.resolve(String(raw).replace(/^"+|"+$/g, ''))
    if (!isSupportedAudioPath(normalized)) continue
    const key = normalizeExternalPathKey(normalized)
    if (externalOpenSeen.has(key)) continue
    externalOpenSeen.add(key)
    accepted.push(normalized)
  }
  return accepted
}

function queueExternalAudioFiles(paths: string[]): void {
  const accepted = collectSupportedAudioPaths(paths)
  if (accepted.length === 0) return
  externalOpenQueue.push(...accepted)
  void processExternalOpenQueue()
}

type ExternalOpenPayload = {
  paths: string[]
}

async function sendExternalOpenPayload(payload: ExternalOpenPayload): Promise<void> {
  if (!mainWindow.instance) return
  const wc = mainWindow.instance.webContents
  if (wc.isLoading()) {
    await new Promise<void>((resolve) => wc.once('did-finish-load', () => resolve()))
  }
  wc.send('external-open/imported', payload)
}

async function processExternalOpenQueue(): Promise<void> {
  if (processingExternalOpen) return
  if (!externalOpenQueue.length) return
  if (!mainWindow.instance) return
  processingExternalOpen = true
  try {
    const batch: string[] = []
    while (externalOpenQueue.length > 0) {
      const candidate = externalOpenQueue.shift()
      if (!candidate) continue
      const key = normalizeExternalPathKey(candidate)
      externalOpenSeen.delete(key)
      if (!isSupportedAudioPath(candidate)) continue
      batch.push(candidate)
    }
    if (batch.length > 0) {
      await sendExternalOpenPayload({ paths: batch })
    }
  } catch (error) {
    log.error('处理外部音频打开队列失败', error)
  } finally {
    processingExternalOpen = false
    if (externalOpenQueue.length > 0) {
      void processExternalOpenQueue()
    }
  }
}

function runRegCommand(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('reg', args, { windowsHide: true }, (error) => {
      if (error) return reject(error)
      resolve()
    })
  })
}

async function removeLegacyWindowsContextMenu(): Promise<void> {
  if (process.platform !== 'win32') return
  try {
    await runRegCommand(['delete', WINDOWS_LEGACY_CONTEXT_MENU_REG_PATH, '/f'])
  } catch {}
}

async function ensureWindowsContextMenu(): Promise<void> {
  if (process.platform !== 'win32') return
  const displayName = '在 FRKB 中播放'
  const command = `"${process.execPath.replace(/"/g, '\\"')}" "%1"`
  const shellPaths = getWindowsContextMenuPaths()
  const commandPaths = getWindowsContextMenuCommandPaths()
  await removeLegacyWindowsContextMenu()
  for (let i = 0; i < shellPaths.length; i++) {
    const shellPath = shellPaths[i]
    const commandPath = commandPaths[i]
    try {
      await runRegCommand(['add', shellPath, '/ve', '/d', displayName, '/f'])
      await runRegCommand(['add', shellPath, '/v', 'Icon', '/d', process.execPath, '/f'])
      await runRegCommand(['add', commandPath, '/ve', '/d', command, '/f'])
    } catch (error) {
      log.error('注册 Windows 右键菜单失败', { path: shellPath, error })
    }
  }
}

async function removeWindowsContextMenu(): Promise<void> {
  if (process.platform !== 'win32') return
  const shellPaths = getWindowsContextMenuPaths()
  for (const shellPath of shellPaths) {
    try {
      await runRegCommand(['delete', shellPath, '/f'])
    } catch (error) {
      log.error('删除 Windows 右键菜单失败', { path: shellPath, error })
    }
  }
  await removeLegacyWindowsContextMenu()
}

function hasWindowsContextMenu(): boolean {
  if (process.platform !== 'win32') return false
  const commandPaths = getWindowsContextMenuCommandPaths()
  for (const commandPath of commandPaths) {
    try {
      execFileSync('reg', ['query', commandPath], { stdio: 'ignore' })
      return true
    } catch {
      continue
    }
  }
  try {
    execFileSync('reg', ['query', `${WINDOWS_LEGACY_CONTEXT_MENU_REG_PATH}\\command`], {
      stdio: 'ignore'
    })
    return true
  } catch {
    return false
  }
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
  await processExternalOpenQueue()
  setTimeout(() => {
    maybeShowWhatsNew().catch((error) => {
      log.error('[whatsNew] maybeShowWhatsNew 异常', error)
    })
  }, 1500)
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
      await processExternalOpenQueue()
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
  const prevContextMenu = !!(store as any).settingConfig?.enableExplorerContextMenu
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
  if (process.platform === 'win32') {
    const nextContextMenu = !!(store as any).settingConfig?.enableExplorerContextMenu
    if (nextContextMenu !== prevContextMenu) {
      if (nextContextMenu) {
        await ensureWindowsContextMenu()
      } else {
        await removeWindowsContextMenu()
      }
    }
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

ipcMain.handle('deduplicateSongListByFingerprint', async (_e, payload: any) => {
  let rendererPath = ''
  let incomingProgressId = ''
  if (typeof payload === 'string') {
    rendererPath = payload
  } else if (payload && typeof payload === 'object') {
    rendererPath = String(payload.songListPath || '')
    incomingProgressId = payload.progressId ? String(payload.progressId) : ''
  }
  if (!rendererPath) {
    throw new Error('缺少有效的歌单路径')
  }

  const progressId = incomingProgressId || `playlist_dedup_${Date.now()}`
  const pushProgress = (
    titleKey: string,
    now: number,
    total: number,
    options?: { isInitial?: boolean }
  ) => {
    if (!mainWindow.instance) return
    mainWindow.instance.webContents.send('progressSet', {
      id: progressId,
      titleKey,
      now,
      total,
      isInitial: !!options?.isInitial
    })
  }

  try {
    const startedAt = Date.now()
    const mode = ((store as any).settingConfig?.fingerprintMode as 'pcm' | 'file') || 'pcm'
    const scanPath = path.join(store.databaseDir, mapRendererPathToFsPath(rendererPath))

    const summaryBase = {
      scannedCount: 0,
      analyzeFailedCount: 0,
      duplicatesRemovedCount: 0,
      removedFilePaths: [] as string[],
      fingerprintMode: mode,
      durationMs: 0,
      recycleBinInfo: null as null | {
        dirName: string
        uuid: string
        type: string
        order: number
      },
      progressId
    }

    pushProgress('playlist.deduplicateProgressScanning', 0, 1, { isInitial: true })

    const songFileUrlsRaw = await collectFilesWithExtensions(scanPath, store.settingConfig.audioExt)
    const songFileUrls = Array.isArray(songFileUrlsRaw)
      ? Array.from(
          new Set(
            songFileUrlsRaw.filter(
              (item): item is string => typeof item === 'string' && item.trim().length > 0
            )
          )
        )
      : []

    pushProgress('playlist.deduplicateProgressScanning', 1, 1)

    if (songFileUrls.length === 0) {
      pushProgress('playlist.deduplicateProgressFinished', 1, 1)
      return { ...summaryBase, durationMs: Date.now() - startedAt }
    }

    const analysisTotal = songFileUrls.length
    pushProgress('playlist.deduplicateProgressAnalyzing', 0, analysisTotal)

    const { songsAnalyseResult, errorSongsAnalyseResult } = await getSongsAnalyseResult(
      songFileUrls,
      (processed: number) => {
        const current = Math.min(processed, analysisTotal)
        pushProgress('playlist.deduplicateProgressAnalyzing', current, analysisTotal)
      }
    )

    pushProgress('playlist.deduplicateProgressAnalyzing', analysisTotal, analysisTotal)

    const groups = new Map<string, string[]>()
    for (const item of songsAnalyseResult) {
      const hash = item?.sha256_Hash
      const filePath = item?.file_path
      if (!hash || hash === 'error' || !filePath) continue
      const list = groups.get(hash) || []
      list.push(filePath)
      groups.set(hash, list)
    }

    const duplicates: string[] = []
    groups.forEach((paths) => {
      if (paths.length <= 1) return
      paths.sort((a: string, b: string) =>
        a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
      )
      duplicates.push(...paths.slice(1))
    })

    const existingToRemove: string[] = []
    for (const filePath of duplicates) {
      try {
        if (await fs.pathExists(filePath)) {
          existingToRemove.push(filePath)
        }
      } catch (err) {
        log.warn('检查重复文件是否存在失败', { filePath, err })
      }
    }

    if (existingToRemove.length === 0) {
      pushProgress('playlist.deduplicateProgressFinished', 1, 1)
      return {
        scannedCount: songFileUrls.length,
        analyzeFailedCount: errorSongsAnalyseResult.length,
        duplicatesRemovedCount: 0,
        removedFilePaths: [],
        fingerprintMode: mode,
        durationMs: Date.now() - startedAt,
        recycleBinInfo: null,
        progressId
      }
    }

    const now = new Date()
    const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`)
    const dirName = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}_${pad2(
      now.getHours()
    )}-${pad2(now.getMinutes())}`
    const recycleBinTargetDir = path.join(
      store.databaseDir,
      'library',
      getCoreFsDirName('RecycleBin'),
      dirName
    )

    await fs.ensureDir(recycleBinTargetDir)

    pushProgress('playlist.deduplicateProgressRemoving', 0, existingToRemove.length)

    const moveTasks = existingToRemove.map((srcPath) => async () => {
      const destPath = path.join(recycleBinTargetDir, path.basename(srcPath))
      await fs.move(srcPath, destPath, { overwrite: true })
      return srcPath
    })

    const { results: moveResults } = await runWithConcurrency(moveTasks, {
      concurrency: 16,
      onProgress: (done: number, total: number) => {
        pushProgress('playlist.deduplicateProgressRemoving', done, total)
      }
    })
    const movedPaths = moveResults.filter((item): item is string => typeof item === 'string')
    const failedMoves = moveResults.filter((item) => item instanceof Error) as Error[]

    if (failedMoves.length > 0) {
      failedMoves.forEach((err, index) => {
        log.error('指纹去重移动重复文件失败', { error: err?.message, index })
      })
    }

    let recycleBinInfo: { dirName: string; uuid: string; type: string; order: number } | null = null

    if (movedPaths.length > 0) {
      const descriptionJson = {
        uuid: uuidV4(),
        type: 'songList',
        order: Date.now()
      }
      await operateHiddenFile(path.join(recycleBinTargetDir, '.description.json'), async () => {
        const descPath = path.join(recycleBinTargetDir, '.description.json')
        if (!(await fs.pathExists(descPath))) {
          await fs.outputJSON(descPath, descriptionJson)
        }
      })
      recycleBinInfo = { dirName, ...descriptionJson }
      if (mainWindow.instance) {
        mainWindow.instance.webContents.send('delSongsSuccess', recycleBinInfo)
      }
    }

    pushProgress('playlist.deduplicateProgressFinished', 1, 1)

    return {
      scannedCount: songFileUrls.length,
      analyzeFailedCount: errorSongsAnalyseResult.length,
      duplicatesRemovedCount: movedPaths.length,
      removedFilePaths: movedPaths,
      fingerprintMode: mode,
      durationMs: Date.now() - startedAt,
      recycleBinInfo,
      progressId
    }
  } catch (error) {
    pushProgress('playlist.deduplicateProgressFailed', 1, 1)
    throw error
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

ipcMain.handle('audio:metadata:get', async (_e, filePath: string) => {
  return await svcReadTrackMetadata(filePath)
})

ipcMain.handle('audio:metadata:update', async (_e, payload: ITrackMetadataUpdatePayload) => {
  try {
    const result = await svcUpdateTrackMetadata(payload)
    return {
      success: true,
      songInfo: result.songInfo,
      detail: result.detail,
      renamedFrom: result.renamedFrom
    }
  } catch (error: any) {
    log.error('更新音频元数据失败', {
      filePath: payload?.filePath,
      error: error?.message || error
    })
    return {
      success: false,
      message: error?.message || 'metadata-update-failed'
    }
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
