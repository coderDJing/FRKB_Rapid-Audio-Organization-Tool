import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  nativeImage,
  Notification
} from 'electron'
import { is } from '@electron-toolkit/utils'
import icon from '../../../../resources/icon.png?asset'
import path = require('path')
import fs = require('fs-extra')
import store from '../../store'
import updateWindow from '../updateWindow'
import databaseInitWindow from '../databaseInitWindow'
import { registerAudioDecodeHandlers } from './audioDecodeHandlers'
import { registerFingerprintHandlers } from './fingerprintHandlers'
import { registerImportHandlers } from './importHandlers'
import { registerFilesystemHandlers } from './filesystemHandlers'
import { registerAudioConversionHandlers } from './audioConversionHandlers'
import { createProgressSender } from './progress'
import { startLibraryTreeWatcher, stopLibraryTreeWatcher } from '../../libraryTreeWatcher'
import { startKeyAnalysisBackground } from '../../services/keyAnalysisQueue'
import type { IPlayerGlobalShortcuts, PlayerGlobalShortcutAction } from 'src/types/globals'
import {
  MAIN_WINDOW_MIN_HEIGHT,
  MAIN_WINDOW_MIN_WIDTH,
  mergeLayoutConfig,
  persistLayoutConfig
} from '../../layoutConfig'
import { persistSettingConfig } from '../../settingsPersistence'
import {
  WINDOW_SCREENSHOT_SHORTCUT,
  isWindowScreenshotFeatureAvailable
} from '../../../shared/windowScreenshotFeature'

let mainWindow: BrowserWindow | null = null
const getMainWindow = () => mainWindow
const sendProgress = createProgressSender(getMainWindow)
let sharedHandlersRegistered = false
const playerShortcutActions: PlayerGlobalShortcutAction[] = [
  'fastForward',
  'fastBackward',
  'nextSong',
  'previousSong'
]
const playerShortcutActionsSet = new Set<PlayerGlobalShortcutAction>(playerShortcutActions)
const fallbackPlayerShortcuts: IPlayerGlobalShortcuts = {
  fastForward: 'Shift+Alt+Right',
  fastBackward: 'Shift+Alt+Left',
  nextSong: 'Shift+Alt+Down',
  previousSong: 'Shift+Alt+Up'
}
const transparentDragIcon = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQImWNgYGD4DwABBAEAHFqRSgAAAABJRU5ErkJggg=='
)
const externalDragFileIconCache = new Map<
  string,
  ReturnType<typeof nativeImage.createFromDataURL>
>()

const resolveExternalDragIconCacheKey = (filePath: string) => {
  const parsedPath = path.parse(filePath)
  const normalizedExt = parsedPath.ext.toLowerCase()
  if (normalizedExt) {
    return `${process.platform}:ext:${normalizedExt}`
  }
  return `${process.platform}:file:${parsedPath.base.toLowerCase()}`
}

const resolveExternalDragIcon = async (filePath: string) => {
  const cacheKey = resolveExternalDragIconCacheKey(filePath)
  const cachedIcon = externalDragFileIconCache.get(cacheKey)
  if (cachedIcon && !cachedIcon.isEmpty()) {
    return cachedIcon
  }
  try {
    const fileIcon = await app.getFileIcon(filePath, { size: 'normal' })
    if (!fileIcon.isEmpty()) {
      externalDragFileIconCache.set(cacheKey, fileIcon)
      return fileIcon
    }
  } catch {}
  return transparentDragIcon
}

const normalizeExistingExternalDragPaths = (rawPaths: unknown): string[] => {
  const sourcePaths = Array.isArray(rawPaths) ? rawPaths : []
  const existingPaths: string[] = []
  for (const filePath of sourcePaths) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      continue
    }
    const normalized = path.normalize(filePath)
    if (fs.existsSync(normalized)) {
      existingPaths.push(normalized)
    }
  }
  return existingPaths
}
const registeredPlaybackShortcuts = new Map<PlayerGlobalShortcutAction, string>()
const screenshotCss = `
  html,
  body,
  #app {
    background-color: var(--bg, #111111) !important;
  }
`
let screenshotInProgress = false
let registeredScreenshotShortcut = ''

const isWindowScreenshotFeatureEnabledForBuild = () =>
  isWindowScreenshotFeatureAvailable({
    platform: process.platform,
    isDev: is.dev,
    version: app.getVersion()
  })

const getWindowScreenshotShortcut = () =>
  isWindowScreenshotFeatureEnabledForBuild() ? WINDOW_SCREENSHOT_SHORTCUT : ''

const isWindowScreenshotShortcutEnabled = () =>
  store.settingConfig.enableWindowScreenshotShortcut !== false

const ensurePlayerShortcutConfig = (): IPlayerGlobalShortcuts => {
  const current = store.settingConfig.playerGlobalShortcuts
  const safeValue: IPlayerGlobalShortcuts =
    current && typeof current === 'object'
      ? {
          fastForward: current.fastForward || fallbackPlayerShortcuts.fastForward,
          fastBackward: current.fastBackward || fallbackPlayerShortcuts.fastBackward,
          nextSong: current.nextSong || fallbackPlayerShortcuts.nextSong,
          previousSong: current.previousSong || fallbackPlayerShortcuts.previousSong
        }
      : { ...fallbackPlayerShortcuts }
  store.settingConfig.playerGlobalShortcuts = safeValue
  return safeValue
}

const registerPlaybackShortcut = (
  action: PlayerGlobalShortcutAction,
  accelerator: string
): boolean => {
  if (!mainWindow) return false
  const prevShortcut = registeredPlaybackShortcuts.get(action)
  if (prevShortcut === accelerator) {
    return true
  }
  if (prevShortcut) {
    try {
      globalShortcut.unregister(prevShortcut)
    } catch {}
    registeredPlaybackShortcuts.delete(action)
  }
  if (!accelerator) {
    return true
  }
  const success = globalShortcut.register(accelerator, () => {
    try {
      mainWindow?.webContents.send('player/global-shortcut', action)
    } catch {}
  })
  if (!success) {
    if (prevShortcut) {
      const reverted = globalShortcut.register(prevShortcut, () => {
        try {
          mainWindow?.webContents.send('player/global-shortcut', action)
        } catch {}
      })
      if (reverted) {
        registeredPlaybackShortcuts.set(action, prevShortcut)
      }
    }
    return false
  }
  registeredPlaybackShortcuts.set(action, accelerator)
  return true
}

const unregisterPlaybackGlobalShortcuts = () => {
  registeredPlaybackShortcuts.forEach((shortcut) => {
    try {
      globalShortcut.unregister(shortcut)
    } catch {}
  })
  registeredPlaybackShortcuts.clear()
}

const registerPlaybackGlobalShortcuts = () => {
  unregisterPlaybackGlobalShortcuts()
  if (!mainWindow) return
  const config = ensurePlayerShortcutConfig()
  playerShortcutActions.forEach((action) => {
    registerPlaybackShortcut(action, config[action])
  })
}

const formatScreenshotTimestamp = () => {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

const getScreenshotOutputDir = () => {
  return app.getPath('desktop')
}

const showWindowScreenshotNotification = (params: {
  kind: 'success' | 'error'
  outputPath?: string
  errorMessage?: string
}) => {
  if (!Notification.isSupported()) return
  const isEnglish = store.settingConfig?.language === 'enUS'
  const outputPath = String(params.outputPath || '').trim()
  const errorMessage = String(params.errorMessage || '').trim()
  const title =
    params.kind === 'success'
      ? isEnglish
        ? 'Window screenshot saved'
        : '窗口截图已保存'
      : isEnglish
        ? 'Window screenshot failed'
        : '窗口截图失败'
  const body =
    params.kind === 'success'
      ? isEnglish
        ? outputPath
          ? `Saved to:\n${outputPath}\nClick to reveal in Explorer.`
          : 'Saved successfully.'
        : outputPath
          ? `已保存到：\n${outputPath}\n点击可打开所在位置。`
          : '截图已保存。'
      : isEnglish
        ? errorMessage || 'Unknown error.'
        : errorMessage || '未知错误。'
  try {
    const notification = new Notification({
      title,
      body,
      silent: false
    })
    if (params.kind === 'success' && outputPath) {
      notification.on('click', () => {
        try {
          shell.showItemInFolder(outputPath)
        } catch {}
      })
    }
    notification.show()
  } catch {}
}

const captureFocusedWindowScreenshot = async () => {
  if (!isWindowScreenshotFeatureEnabledForBuild() || screenshotInProgress) return
  const targetWindow = BrowserWindow.getFocusedWindow()
  if (!targetWindow || targetWindow.isDestroyed()) return
  screenshotInProgress = true
  let cssKey: string | null = null
  try {
    cssKey = await targetWindow.webContents.insertCSS(screenshotCss)
  } catch {}
  try {
    await targetWindow.webContents.executeJavaScript(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      true
    )
  } catch {}
  try {
    const image = await targetWindow.webContents.capturePage()
    const outputDir = getScreenshotOutputDir()
    await fs.ensureDir(outputDir)
    const outputPath = path.join(outputDir, `frkb-${formatScreenshotTimestamp()}.png`)
    await fs.outputFile(outputPath, image.toPNG())
    showWindowScreenshotNotification({
      kind: 'success',
      outputPath
    })
  } catch (error) {
    console.error('[screenshot] failed', error)
    showWindowScreenshotNotification({
      kind: 'error',
      errorMessage: error instanceof Error ? error.message : String(error || '')
    })
  } finally {
    if (cssKey) {
      try {
        await targetWindow.webContents.removeInsertedCSS(cssKey)
      } catch {}
    }
    screenshotInProgress = false
  }
}

const registerScreenshotShortcut = () => {
  const screenshotShortcut = getWindowScreenshotShortcut()
  if (!mainWindow || !screenshotShortcut || !isWindowScreenshotShortcutEnabled()) {
    unregisterScreenshotShortcut()
    return
  }
  unregisterScreenshotShortcut()
  if (globalShortcut.isRegistered(screenshotShortcut)) return
  const success = globalShortcut.register(screenshotShortcut, () => {
    void captureFocusedWindowScreenshot()
  })
  if (success) {
    registeredScreenshotShortcut = screenshotShortcut
  }
}

const unregisterScreenshotShortcut = () => {
  if (!registeredScreenshotShortcut) return
  try {
    globalShortcut.unregister(registeredScreenshotShortcut)
  } catch {}
  registeredScreenshotShortcut = ''
}

export const syncWindowScreenshotShortcut = () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    unregisterScreenshotShortcut()
    return
  }
  registerScreenshotShortcut()
}

function ensureSharedHandlersRegistered() {
  if (sharedHandlersRegistered) return
  registerAudioDecodeHandlers(getMainWindow)
  registerFingerprintHandlers({ sendProgress, getWindow: getMainWindow })
  registerImportHandlers(sendProgress, getMainWindow)
  registerFilesystemHandlers(getMainWindow)
  registerAudioConversionHandlers(getMainWindow)
  sharedHandlersRegistered = true
}

function createWindow() {
  ensureSharedHandlersRegistered()

  mainWindow = new BrowserWindow({
    width: store.layoutConfig.mainWindowWidth,
    height: store.layoutConfig.mainWindowHeight,
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    frame: process.platform === 'darwin' ? true : false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    transparent: false,
    show: false,
    backgroundColor: '#000000',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index'),
      sandbox: false,
      backgroundThrottling: false
    }
  })

  if (process.platform === 'darwin') {
    try {
      mainWindow.setVibrancy('under-window')
    } catch {}
  }

  if (is.dev && process.env.FRKB_OPEN_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools()
  }
  startLibraryTreeWatcher(mainWindow)

  mainWindow.on('ready-to-show', () => {
    if (store.layoutConfig.isMaxMainWin) {
      mainWindow?.maximize()
    }
    mainWindow?.show()
    globalShortcut.register(store.settingConfig.globalCallShortcut, () => {
      if (!mainWindow?.isFocused()) {
        if (mainWindow?.isMinimized()) {
          mainWindow.restore()
        }
        mainWindow?.focus()
      } else {
        mainWindow.minimize()
      }
    })
    registerPlaybackGlobalShortcuts()
    syncWindowScreenshotShortcut()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.control || input.meta) && input.key.toLowerCase() === 'w') {
      event.preventDefault()
    }
  })

  ipcMain.on('startExternalSongDrag', (event, payload: { filePaths?: string[] }) => {
    const rawPaths = Array.isArray(payload?.filePaths) ? payload.filePaths : []
    void (async () => {
      if (rawPaths.length === 0) {
        return
      }
      const existingPaths = normalizeExistingExternalDragPaths(payload?.filePaths)
      if (existingPaths.length === 0) {
        return
      }
      try {
        const dragIcon = await resolveExternalDragIcon(existingPaths[0])
        if (event.sender.isDestroyed()) {
          return
        }
        event.sender.startDrag({
          file: existingPaths[0],
          files: existingPaths,
          icon: dragIcon
        })
      } catch (error) {
        console.error('[startExternalSongDrag] failed', error)
      }
    })()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.send('mainWin-max', !!mainWindow?.isMaximized())
    mainWindow?.webContents.send('layoutConfigReaded', store.layoutConfig)
    // 启动后台分析和清理任务
    // 延迟启动，避免影响初始加载性能
    setTimeout(() => {
      startKeyAnalysisBackground()
    }, 5000)
  })

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('mainWin-max', true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('mainWin-max', false)
  })

  let mainWindowWidth = store.layoutConfig.mainWindowWidth
  let mainWindowHeight = store.layoutConfig.mainWindowHeight
  const persistMainWindowLayout = async () => {
    const nextLayoutConfig = mergeLayoutConfig(store.layoutConfig, {
      isMaxMainWin: !!mainWindow?.isMaximized(),
      mainWindowWidth,
      mainWindowHeight
    })
    store.layoutConfig = nextLayoutConfig
    await persistLayoutConfig(nextLayoutConfig)
  }

  mainWindow.on('resized', () => {
    const size = mainWindow?.getSize()
    if (size) {
      mainWindowWidth = size[0]
      mainWindowHeight = size[1]
    }
  })

  mainWindow.on('blur', () => {
    mainWindow?.webContents.send('mainWindowBlur')
  })

  ipcMain.on('toggle-maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow?.maximize()
    }
  })

  ipcMain.on('toggle-minimize', () => {
    mainWindow?.minimize()
  })

  ipcMain.on('toggle-close', async () => {
    await persistMainWindowLayout()
    mainWindow?.close()
  })

  ipcMain.handle('changeGlobalShortcut', (_e, shortCutValue: string) => {
    const ret = globalShortcut.register(shortCutValue, () => {
      if (!mainWindow?.isFocused()) {
        if (mainWindow?.isMinimized()) {
          mainWindow.restore()
        }
        mainWindow?.focus()
      } else {
        mainWindow.minimize()
      }
    })
    if (!ret) return false
    globalShortcut.unregister(store.settingConfig.globalCallShortcut)
    store.settingConfig.globalCallShortcut = shortCutValue
    void persistSettingConfig()
    return true
  })

  ipcMain.handle(
    'playerGlobalShortcut:update',
    async (
      _e,
      payload: { action: PlayerGlobalShortcutAction; accelerator: string } | undefined
    ) => {
      const action = payload?.action
      const accelerator = typeof payload?.accelerator === 'string' ? payload.accelerator.trim() : ''
      if (!action || !playerShortcutActionsSet.has(action) || !accelerator) {
        return { success: false }
      }
      const success = registerPlaybackShortcut(action, accelerator)
      if (!success) {
        return { success: false }
      }
      const config = ensurePlayerShortcutConfig()
      config[action] = accelerator
      await persistSettingConfig()
      return { success: true }
    }
  )

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

  ipcMain.handle('reSelectLibrary', async () => {
    databaseInitWindow.createWindow()
    await persistMainWindowLayout()
    mainWindow?.close()
  })

  mainWindow.on('closed', () => {
    stopLibraryTreeWatcher()
    ipcMain.removeAllListeners('toggle-maximize')
    ipcMain.removeAllListeners('toggle-minimize')
    ipcMain.removeAllListeners('toggle-close')
    ipcMain.removeAllListeners('checkForUpdates')
    ipcMain.removeHandler('changeGlobalShortcut')
    ipcMain.removeHandler('reSelectLibrary')
    ipcMain.removeAllListeners('startExternalSongDrag')
    globalShortcut.unregister(store.settingConfig.globalCallShortcut)
    unregisterPlaybackGlobalShortcuts()
    unregisterScreenshotShortcut()
    mainWindow = null
  })
}

export default {
  get instance() {
    return mainWindow
  },
  createWindow
}
