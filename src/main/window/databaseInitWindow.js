import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import { v4 as uuidv4 } from 'uuid'
import mainWindow from './mainWindow.js'
import store from '../store.js'
const fs = require('fs-extra')
const path = require('path')
let databaseInitWindow = null

const createWindow = () => {
  databaseInitWindow = new BrowserWindow({
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
    databaseInitWindow.close()
    app.quit()
  })
  ipcMain.handle('databaseInitWindow-InitDataBase', async (e, dirPath) => {
    let rootDescription = {
      uuid: uuidv4(),
      type: 'root',
      dirName: 'library',
      order: 1
    }
    await fs.outputJson(path.join(dirPath, 'library', 'description.json'), rootDescription)
    const makeLibrary = async (libraryPath, libraryName, order) => {
      let description = {
        uuid: uuidv4(),
        type: 'library',
        dirName: libraryName,
        order: order
      }
      await fs.outputJson(path.join(libraryPath, 'description.json'), description)
    }
    await makeLibrary(path.join(dirPath, 'library/筛选库'), '筛选库', 1)
    await makeLibrary(path.join(dirPath, 'library/精选库'), '精选库', 2)

    if (fs.pathExistsSync(path.join(dirPath, 'songFingerprint', 'songFingerprint.json'))) {
      const json = await fs.readJSON(path.join(dirPath, 'songFingerprint', 'songFingerprint.json'))
      if (Array.isArray(json) && json.every((item) => typeof item === 'string')) {
      } else {
        await fs.outputJSON(path.join(dirPath, 'songFingerprint', 'songFingerprint.json'), [])
      }
    } else {
      await fs.outputJSON(path.join(dirPath, 'songFingerprint', 'songFingerprint.json'), [])
    }
    databaseInitWindow.close()
    store.databaseDir = store.settingConfig.databaseUrl
    store.songFingerprintList = fs.readJSONSync(
      path.join(store.databaseDir, 'songFingerprint', 'songFingerprint.json')
    )
    mainWindow.createWindow()
  })
  databaseInitWindow.on('closed', () => {
    ipcMain.removeHandler('databaseInitWindow-toggle-close')
    ipcMain.removeHandler('databaseInitWindow-InitDataBase')
    databaseInitWindow = null
  })
}

export default {
  instance: databaseInitWindow,
  createWindow
}
