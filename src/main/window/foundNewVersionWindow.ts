import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import updateWindow from './updateWindow.js'
import type { UpdateInfo } from 'electron-updater'
import type { ReleaseNotesRangePayload } from '../../shared/releaseNotes'
import path = require('path')

export type FoundNewVersionPayload = {
  version: string
  releaseDate: string
  releaseNotes: ReleaseNotesRangePayload | null
  releaseNotesLoading: boolean
}

let foundNewVersionWindow: BrowserWindow | null = null
let lastPayload: FoundNewVersionPayload | null = null

const setVisualEffectMaterial = (target: BrowserWindow, material: string) => {
  const setter = Reflect.get(target, 'setVisualEffectMaterial')
  if (typeof setter !== 'function') return
  Reflect.apply(setter, target, [material])
}

const handleToggleClose = async () => {
  foundNewVersionWindow?.close()
}

const handleToggleMinimize = () => {
  foundNewVersionWindow?.minimize()
}

const handleCheckForUpdates = () => {
  if (updateWindow.instance === null) {
    updateWindow.createWindow()
  } else {
    if (updateWindow.instance.isMinimized()) {
      updateWindow.instance.restore()
    }
    updateWindow.instance.focus()
  }
}

const createWindow = () => {
  foundNewVersionWindow = new BrowserWindow({
    resizable: true,
    width: 650,
    height: 500,
    minWidth: 520,
    minHeight: 360,
    frame: process.platform === 'darwin' ? true : false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    transparent: false,
    show: false,
    backgroundColor: '#000000',
    maximizable: false,

    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index'),
      sandbox: false,
      backgroundThrottling: false
    }
  })

  if (process.platform === 'darwin') {
    try {
      foundNewVersionWindow.setVibrancy('under-window')
    } catch {}
    try {
      setVisualEffectMaterial(foundNewVersionWindow, 'under-window')
    } catch {}
  }

  foundNewVersionWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    foundNewVersionWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/foundNewVersion.html`)
  } else {
    foundNewVersionWindow.loadFile(path.join(__dirname, '../renderer/foundNewVersion.html'))
  }

  foundNewVersionWindow.on('ready-to-show', () => {
    foundNewVersionWindow?.show()
    sendPayloadIfAny()
  })

  ipcMain.on('foundNewVersionWindow-toggle-close', handleToggleClose)
  ipcMain.on('foundNewVersionWindow-toggle-minimize', handleToggleMinimize)
  ipcMain.handle('foundNewVersionWindow-checkForUpdates', handleCheckForUpdates)

  foundNewVersionWindow.on('closed', () => {
    ipcMain.removeListener('foundNewVersionWindow-toggle-close', handleToggleClose)
    ipcMain.removeListener('foundNewVersionWindow-toggle-minimize', handleToggleMinimize)
    ipcMain.removeHandler('foundNewVersionWindow-checkForUpdates')
    foundNewVersionWindow = null
  })
}

const sendPayloadIfAny = () => {
  if (!foundNewVersionWindow || !lastPayload) return
  try {
    foundNewVersionWindow.webContents.send('foundNewVersion-data', lastPayload)
  } catch {}
}

const toPayload = (
  updateInfo: Pick<UpdateInfo, 'version' | 'releaseDate'>,
  releaseNotes: ReleaseNotesRangePayload | null,
  releaseNotesLoading: boolean
): FoundNewVersionPayload => ({
  version: typeof updateInfo.version === 'string' ? updateInfo.version : '',
  releaseDate: typeof updateInfo.releaseDate === 'string' ? updateInfo.releaseDate : '',
  releaseNotes,
  releaseNotesLoading
})

const open = (
  updateInfo: Pick<UpdateInfo, 'version' | 'releaseDate'>,
  releaseNotes: ReleaseNotesRangePayload | null = null,
  releaseNotesLoading = true
) => {
  lastPayload = toPayload(updateInfo, releaseNotes, releaseNotesLoading)
  if (!foundNewVersionWindow) {
    createWindow()
    return
  }
  try {
    if (foundNewVersionWindow.isMinimized()) {
      foundNewVersionWindow.restore()
    }
    foundNewVersionWindow.focus()
  } catch {}
  sendPayloadIfAny()
}

const updateReleaseNotes = (releaseNotes: ReleaseNotesRangePayload | null) => {
  if (!lastPayload) return
  lastPayload = {
    ...lastPayload,
    releaseNotes,
    releaseNotesLoading: false
  }
  sendPayloadIfAny()
}

export default {
  get instance() {
    return foundNewVersionWindow
  },
  createWindow,
  open,
  updateReleaseNotes
}
