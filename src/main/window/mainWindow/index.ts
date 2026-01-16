import { app, shell, BrowserWindow, ipcMain, globalShortcut, nativeImage } from 'electron'
import { is } from '@electron-toolkit/utils'
import icon from '../../../../resources/icon.png?asset'
import path = require('path')
import fs = require('fs-extra')
import store from '../../store'
import url from '../../url'
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
import { persistSettingConfig } from '../../settingsPersistence'

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
const registeredPlaybackShortcuts = new Map<PlayerGlobalShortcutAction, string>()

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
    minWidth: 900,
    minHeight: 600,
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

  if (!app.isPackaged) {
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
    console.info('[external-drag] start request', {
      count: rawPaths.length,
      sample: rawPaths[0] || ''
    })
    if (rawPaths.length === 0) {
      console.info('[external-drag] abort: empty payload')
      event.returnValue = false
      return
    }
    const existingPaths: string[] = []
    for (const filePath of rawPaths) {
      if (typeof filePath !== 'string' || !filePath.trim()) {
        continue
      }
      const normalized = path.normalize(filePath)
      if (fs.existsSync(normalized)) {
        existingPaths.push(normalized)
      }
    }
    if (existingPaths.length === 0) {
      console.info('[external-drag] abort: no existing paths')
      event.returnValue = false
      return
    }
    const iconCandidates = [
      icon,
      path.resolve(process.cwd(), 'resources', 'icon.png'),
      path.resolve(process.cwd(), 'build', 'icon.png'),
      path.resolve(app.getAppPath(), 'resources', 'icon.png'),
      path.resolve(app.getAppPath(), 'build', 'icon.png'),
      path.resolve(process.resourcesPath, 'icon.png')
    ]
    let dragIcon: ReturnType<typeof nativeImage.createFromPath> | null = null
    for (const candidate of iconCandidates) {
      if (typeof candidate !== 'string' || !candidate) {
        continue
      }
      if (!fs.existsSync(candidate)) {
        continue
      }
      const image = nativeImage.createFromPath(candidate)
      if (!image.isEmpty()) {
        dragIcon = image
        break
      }
    }
    if (!dragIcon || dragIcon.isEmpty()) {
      dragIcon = nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQImWNgYGD4DwABBAEAHFqRSgAAAABJRU5ErkJggg=='
      )
    }
    try {
      console.info('[external-drag] startDrag', {
        count: existingPaths.length,
        first: existingPaths[0]
      })
      event.sender.startDrag({
        file: existingPaths[0],
        files: existingPaths,
        icon: dragIcon
      })
      event.returnValue = true
    } catch (error) {
      console.error('[startExternalSongDrag] failed', error)
      event.returnValue = false
    }
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
    const layoutConfig = fs.readJSONSync(url.layoutConfigFileUrl)
    layoutConfig.isMaxMainWin = !!mainWindow?.isMaximized()
    layoutConfig.mainWindowWidth = mainWindowWidth
    layoutConfig.mainWindowHeight = mainWindowHeight
    await fs.outputJson(url.layoutConfigFileUrl, layoutConfig)
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
    const layoutConfig = fs.readJSONSync(url.layoutConfigFileUrl)
    layoutConfig.isMaxMainWin = !!mainWindow?.isMaximized()
    layoutConfig.mainWindowWidth = mainWindowWidth
    layoutConfig.mainWindowHeight = mainWindowHeight
    await fs.outputJson(url.layoutConfigFileUrl, layoutConfig)
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
    mainWindow = null
  })
}

export default {
  get instance() {
    return mainWindow
  },
  createWindow
}
