import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
const path = require('path')
let updateWindow = null

const createWindow = () => {
  updateWindow = new BrowserWindow({
    resizable: false,
    width: 500,
    height: 300,
    frame: false,
    transparent: false,
    show: false,
    backgroundColor: '#181818',
    maximizable: false,

    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  if (!app.isPackaged) {
    updateWindow.openDevTools()
  }

  updateWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    updateWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/update.html`)
  } else {
    updateWindow.loadFile(path.join(__dirname, '../renderer/update.html'))
  }

  updateWindow.on('ready-to-show', () => {
    updateWindow.show()
  })

  updateWindow.on('closed', () => {
    updateWindow = null
  })
}

export default {
  get instance() {
    return updateWindow
  },
  createWindow
}
