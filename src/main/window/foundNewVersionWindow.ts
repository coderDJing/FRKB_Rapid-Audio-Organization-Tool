import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import updateWindow from './updateWindow.js'
import path = require('path')
let foundNewVersionWindow: BrowserWindow | null = null

const createWindow = () => {
  foundNewVersionWindow = new BrowserWindow({
    resizable: false,
    width: 300,
    height: 200,
    frame: false,
    transparent: false,
    show: false,
    backgroundColor: '#181818',
    maximizable: false,

    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index'),
      sandbox: false
    }
  })

  if (!app.isPackaged) {
    foundNewVersionWindow.webContents.openDevTools()
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
  })

  ipcMain.on('foundNewVersionWindow-toggle-close', async () => {
    foundNewVersionWindow?.close()
  })

  ipcMain.on('foundNewVersionWindow-toggle-minimize', () => {
    foundNewVersionWindow?.minimize()
  })

  ipcMain.handle('foundNewVersionWindow-checkForUpdates', () => {
    if (updateWindow.instance === null) {
      updateWindow.createWindow()
    } else {
      if (updateWindow.instance.isMinimized()) {
        updateWindow.instance.restore()
      }
      updateWindow.instance.focus()
    }
  })

  foundNewVersionWindow.on('closed', () => {
    ipcMain.removeHandler('foundNewVersionWindow-toggle-close')
    ipcMain.removeHandler('foundNewVersionWindow-toggle-minimize')
    ipcMain.removeHandler('foundNewVersionWindow-checkForUpdates')
    foundNewVersionWindow = null
  })
}

export default {
  get instance() {
    return foundNewVersionWindow
  },
  createWindow
}
