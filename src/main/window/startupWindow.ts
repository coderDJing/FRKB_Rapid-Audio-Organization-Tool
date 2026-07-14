import { app, BrowserWindow, nativeTheme } from 'electron'
import { is } from '@electron-toolkit/utils'
import path = require('path')
import store from '../store'

type StartupStage =
  | 'starting'
  | 'checking-library'
  | 'recovering-library'
  | 'preparing-library'
  | 'loading-fingerprints'
  | 'opening-main-window'
  | 'selecting-library'

type StartupState = {
  message: string
  theme: 'dark' | 'light'
  version: string
}

const startupMessages: Record<StartupStage, { zhCN: string; enUS: string }> = {
  starting: {
    zhCN: '正在启动 FRKB…',
    enUS: 'Starting FRKB…'
  },
  'checking-library': {
    zhCN: '正在检查音乐库…',
    enUS: 'Checking music library…'
  },
  'recovering-library': {
    zhCN: '正在恢复上次未完成的操作…',
    enUS: 'Recovering unfinished work…'
  },
  'preparing-library': {
    zhCN: '正在准备音乐库…',
    enUS: 'Preparing music library…'
  },
  'loading-fingerprints': {
    zhCN: '正在读取曲库索引…',
    enUS: 'Loading library index…'
  },
  'opening-main-window': {
    zhCN: '正在打开主界面…',
    enUS: 'Opening main window…'
  },
  'selecting-library': {
    zhCN: '正在打开音乐库设置…',
    enUS: 'Opening music library settings…'
  }
}

let startupWindow: BrowserWindow | null = null
let currentStage: StartupStage = 'starting'

const resolveState = (): StartupState => {
  const language = store.settingConfig?.language === 'enUS' ? 'enUS' : 'zhCN'
  const configuredTheme = store.settingConfig?.themeMode
  const theme =
    configuredTheme === 'light' || (configuredTheme !== 'dark' && !nativeTheme.shouldUseDarkColors)
      ? 'light'
      : 'dark'
  return {
    message: startupMessages[currentStage][language],
    theme,
    version: app.getVersion()
  }
}

const sendState = () => {
  if (!startupWindow || startupWindow.isDestroyed()) return
  startupWindow.webContents.send('startup:state', resolveState())
}

const createWindow = async (): Promise<void> => {
  if (startupWindow && !startupWindow.isDestroyed()) return

  startupWindow = new BrowserWindow({
    width: 460,
    height: 160,
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    frame: false,
    show: false,
    backgroundColor: resolveState().theme === 'light' ? '#f7f7f7' : '#181818',
    title: 'FRKB',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index'),
      sandbox: false,
      backgroundThrottling: false
    }
  })

  startupWindow.webContents.on('did-finish-load', sendState)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void startupWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/startup.html`)
  } else {
    void startupWindow.loadFile(path.join(__dirname, '../renderer/startup.html'))
  }

  await new Promise<void>((resolve) => {
    startupWindow?.once('ready-to-show', () => {
      startupWindow?.show()
      resolve()
    })
  })
}

const setStage = (stage: StartupStage): void => {
  currentStage = stage
  sendState()
}

const closeWindow = (): void => {
  const target = startupWindow
  startupWindow = null
  if (!target || target.isDestroyed()) return
  target.hide()
  target.destroy()
}

export default {
  closeWindow,
  createWindow,
  setStage
}
