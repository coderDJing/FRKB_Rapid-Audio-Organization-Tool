import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
const path = require('path')
let databaseInitWindow = null

const createWindow = () => {
  databaseInitWindow = new BrowserWindow({
    resizable: false,
    width: 400,
    height: 200,
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
    databaseInitWindow.openDevTools()
  }

  databaseInitWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    databaseInitWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/databaseInit.html`)
  } else {
    databaseInitWindow.loadFile(path.join(__dirname, '../renderer/databaseInit.html'))
  }

  databaseInitWindow.on('ready-to-show', () => {
    databaseInitWindow.show()
  })

  ipcMain.on('databaseInitWindow-toggle-close', () => {
    app.exit()
  })
  databaseInitWindow.on('closed', () => {
    ipcMain.removeHandler('databaseInitWindow-toggle-close')
    databaseInitWindow = null
  })
}

export default {
  instance: databaseInitWindow,
  createWindow
}
