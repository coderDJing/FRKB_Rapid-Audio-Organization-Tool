import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import { v4 as uuidV4 } from 'uuid'
import mainWindow from './mainWindow'
import store from '../store'
import { operateHiddenFile } from '../utils'
import { initDatabaseStructure } from '../initDatabase'
import fs = require('fs-extra')
import path = require('path')
import FingerprintStore from '../fingerprintStore'
import { ensureManifestForLegacy, writeManifest } from '../databaseManifest'
let databaseInitWindow: BrowserWindow | null = null

const createWindow = ({ needErrorHint = false } = {}) => {
  databaseInitWindow = new BrowserWindow({
    resizable: false,
    width: 640,
    height: 380,
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
    databaseInitWindow.webContents.openDevTools()
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
    databaseInitWindow?.show()
    if (needErrorHint) {
      databaseInitWindow?.webContents.send(
        'databaseInitWindow-showErrorHint',
        store.settingConfig.databaseUrl
      )
    }
  })

  ipcMain.on('databaseInitWindow-toggle-close', () => {
    databaseInitWindow?.close()
  })
  ipcMain.handle(
    'databaseInitWindow-InitDataBase',
    async (e, dirPath: string, options?: { createSamples?: boolean; reset?: boolean }) => {
      // 发现旧版 V1 指纹文件则直接删除（不再兼容）
      try {
        const v1 = path.join(dirPath, 'songFingerprint', 'songFingerprint.json')
        if (fs.pathExistsSync(v1)) {
          fs.removeSync(v1)
        }
      } catch {}

      // 如果需要重置为全新数据库，则清理核心子目录与旧声明文件
      if (options?.reset === true) {
        try {
          await fs.remove(path.join(dirPath, 'library'))
        } catch {}
        try {
          await fs.remove(path.join(dirPath, 'songFingerprint'))
        } catch {}
        try {
          await fs.remove(path.join(dirPath, 'FRKB.database.frkbdb'))
        } catch {}
      }

      await initDatabaseStructure(dirPath, { createSamples: options?.createSamples !== false })

      // 确保声明文件存在（新建或旧库静默生成）；reset 模式下总是重写
      try {
        if (options?.reset === true) {
          await writeManifest(dirPath, app.getVersion())
        } else {
          const legacy = await ensureManifestForLegacy(dirPath, app.getVersion())
          if (!legacy) {
            await writeManifest(dirPath, app.getVersion())
          }
        }
      } catch {}

      // 使用 FingerprintStore：前置修复 + 首次建立版本与指针
      store.databaseDir = dirPath
      await FingerprintStore.healAndPrepare()
      const list = await FingerprintStore.loadList()
      store.songFingerprintList = Array.isArray(list) ? list : []
      databaseInitWindow?.close()
      mainWindow.createWindow()
    }
  )
  databaseInitWindow.on('closed', () => {
    ipcMain.removeHandler('databaseInitWindow-toggle-close')
    ipcMain.removeHandler('databaseInitWindow-InitDataBase')
    databaseInitWindow = null
  })
}

export default {
  get instance() {
    return databaseInitWindow
  },
  createWindow
}
