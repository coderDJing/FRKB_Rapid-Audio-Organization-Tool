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
      updateWindow.setVibrancy('under-window')
    } catch {}
    try {
      ;(updateWindow as any).setVisualEffectMaterial?.('under-window')
    } catch {}
  }

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
    const isPrerelease = app.getVersion().includes('-')
    try {
      ;(autoUpdater as any).allowPrerelease = isPrerelease
    } catch {}
    autoUpdater.checkForUpdates()

    autoUpdater.on('update-available', (info) => {
      const currentIsPrerelease = app.getVersion().includes('-')
      const remoteIsPrerelease = !!(
        info &&
        typeof (info as any).version === 'string' &&
        (info as any).version.includes('-')
      )
      if (currentIsPrerelease !== remoteIsPrerelease) return
      updateWindow?.webContents.send('newVersion', info)
    })

    autoUpdater.on('update-not-available', (info) => {
      // 当同轨道无更新，才提示“已是最新版本”
      const currentIsPrerelease = app.getVersion().includes('-')
      const remoteVersion = (info as any)?.version as string | undefined
      const remoteIsPrerelease = !!(remoteVersion && remoteVersion.includes('-'))
      if (remoteVersion && currentIsPrerelease === remoteIsPrerelease) {
        updateWindow?.webContents.send('isLatestVersion', info.version)
      } else if (!remoteVersion) {
        updateWindow?.webContents.send('isLatestVersion', app.getVersion())
      }
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
