import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import { log } from '../log'
import electronUpdater = require('electron-updater')
import path = require('path')
const autoUpdater = electronUpdater.autoUpdater
let updateWindow: BrowserWindow | null = null

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
    updateWindow.webContents.openDevTools()
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
    updateWindow?.show()
    autoUpdater.autoDownload = false
    autoUpdater.checkForUpdates()

    autoUpdater.on('update-available', (info) => {
      updateWindow?.webContents.send('newVersion', info)
    })

    autoUpdater.on('update-not-available', (info) => {
      updateWindow?.webContents.send('isLatestVersion', info.version)
    })

    autoUpdater.on('error', (err) => {
      updateWindow?.webContents.send('isError')
      log.error('autoUpdater', 'error', err)
    })

    autoUpdater.on('download-progress', (progressObj) => {
      updateWindow?.webContents.send('updateProgress', progressObj)
    })

    autoUpdater.on('update-downloaded', (info) => {
      updateWindow?.webContents.send('updateDownloaded')
    })
  })
  ipcMain.on('updateWindow-startDownload', async () => {
    autoUpdater.downloadUpdate()
  })

  ipcMain.on('updateWindow-toggle-close', async () => {
    updateWindow?.close()
  })

  ipcMain.on('updateWindow-toggle-minimize', () => {
    updateWindow?.minimize()
  })

  updateWindow.on('closed', () => {
    ipcMain.removeHandler('updateWindow-toggle-close')
    ipcMain.removeHandler('updateWindow-toggle-minimize')
    updateWindow = null
  })
}

export default {
  get instance() {
    return updateWindow
  },
  createWindow
}
