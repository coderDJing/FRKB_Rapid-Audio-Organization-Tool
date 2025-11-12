import { app, BrowserWindow, shell, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import path = require('path')

export type WhatsNewReleasePayload = {
  title: string
  tagName: string
  body: string
  publishedAt: string
  htmlUrl: string
  currentVersion: string
}

let whatsNewWindow: BrowserWindow | null = null
let lastPayload: WhatsNewReleasePayload | null = null

const createWindow = () => {
  whatsNewWindow = new BrowserWindow({
    resizable: true,
    width: 650,
    height: 400,
    minWidth: 480,
    minHeight: 300,
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
      whatsNewWindow.setVibrancy('under-window')
    } catch {}
    try {
      ;(whatsNewWindow as any).setVisualEffectMaterial?.('under-window')
    } catch {}
  }

  if (!app.isPackaged) {
    whatsNewWindow.webContents.openDevTools()
  }

  whatsNewWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  whatsNewWindow.webContents.on('did-finish-load', () => {
    sendPayloadIfAny()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    whatsNewWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/whatsNew.html`)
  } else {
    whatsNewWindow.loadFile(path.join(__dirname, '../renderer/whatsNew.html'))
  }

  whatsNewWindow.on('ready-to-show', () => {
    whatsNewWindow?.show()
  })

  whatsNewWindow.on('close', () => {
    try {
      ipcMain.emit('whatsNew-acknowledge', undefined, { skipClose: true })
    } catch {}
  })

  whatsNewWindow.on('closed', () => {
    whatsNewWindow = null
  })

  return whatsNewWindow
}

function sendPayloadIfAny() {
  if (!whatsNewWindow || !lastPayload) return
  try {
    whatsNewWindow.webContents.send('whatsNew-data', lastPayload)
  } catch {}
}

function open(payload: WhatsNewReleasePayload) {
  lastPayload = payload
  if (whatsNewWindow) {
    try {
      if (whatsNewWindow.isMinimized()) {
        whatsNewWindow.restore()
      }
      whatsNewWindow.focus()
    } catch {}
    sendPayloadIfAny()
    return whatsNewWindow
  }
  return createWindow()
}

export default {
  get instance() {
    return whatsNewWindow
  },
  open,
  sendPayloadIfAny
}

ipcMain.on('whatsNew-toggle-close', () => {
  try {
    ipcMain.emit('whatsNew-acknowledge')
  } catch {}
})

ipcMain.on('whatsNew-toggle-minimize', () => {
  try {
    whatsNewWindow?.minimize()
  } catch {}
})
