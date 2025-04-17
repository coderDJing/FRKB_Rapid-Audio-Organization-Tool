import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import mainWindow from './mainWindow'
import store from '../store'
import fs = require('fs-extra')
import path = require('path')
let foundOldVersionDatabaseWindow: BrowserWindow | null = null

const createWindow = () => {
  foundOldVersionDatabaseWindow = new BrowserWindow({
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
      preload: path.join(__dirname, '../preload/index'),
      sandbox: false,
      backgroundThrottling: false
    }
  })
  if (!app.isPackaged) {
    foundOldVersionDatabaseWindow.webContents.openDevTools()
  }

  foundOldVersionDatabaseWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    foundOldVersionDatabaseWindow.loadURL(
      `${process.env['ELECTRON_RENDERER_URL']}/foundOldVersionDatabase.html`
    )
  } else {
    foundOldVersionDatabaseWindow.loadFile(
      path.join(__dirname, '../renderer/foundOldVersionDatabase.html')
    )
  }
  ipcMain.on('foundOldVersionDatabaseWindow-toggle-close', () => {
    foundOldVersionDatabaseWindow?.close()
  })
  ipcMain.on('foundOldVersionDatabaseWindow-confirmUpdate', async (_e, databaseUrl) => {
    if (fs.pathExistsSync(path.join(databaseUrl, 'songFingerprint', 'songFingerprint.json'))) {
      fs.removeSync(path.join(databaseUrl, 'songFingerprint', 'songFingerprint.json'))
      await fs.outputJSON(path.join(databaseUrl, 'songFingerprint', 'songFingerprintV2.json'), [])
    }
    foundOldVersionDatabaseWindow?.close()
    store.databaseDir = store.settingConfig.databaseUrl
    store.songFingerprintList = []
    mainWindow.createWindow()
  })
  foundOldVersionDatabaseWindow.on('ready-to-show', () => {
    foundOldVersionDatabaseWindow?.show()
  })
  foundOldVersionDatabaseWindow.on('closed', () => {
    ipcMain.removeHandler('foundOldVersionDatabaseWindow-toggle-close')
    foundOldVersionDatabaseWindow = null
  })
}

export default {
  get instance() {
    return foundOldVersionDatabaseWindow
  },
  createWindow
}
