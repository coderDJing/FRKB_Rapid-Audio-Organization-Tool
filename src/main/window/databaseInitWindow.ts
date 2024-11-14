import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import { v4 as uuidV4 } from 'uuid'
import mainWindow from './mainWindow'
import store from '../store'
import { operateHiddenFile } from '../utils'
import fs = require('fs-extra')
import path = require('path')
let databaseInitWindow: BrowserWindow | null = null

const createWindow = ({ needErrorHint = false } = {}) => {
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
      preload: path.join(__dirname, '../preload/index'),
      sandbox: false
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
  ipcMain.handle('databaseInitWindow-InitDataBase', async (e, dirPath) => {
    let rootDescription = {
      uuid: uuidV4(),
      type: 'root',
      order: 1
    }
    await operateHiddenFile(path.join(dirPath, 'library', '.description.json'), async () => {
      await fs.outputJson(path.join(dirPath, 'library', '.description.json'), rootDescription)
    })

    const makeLibrary = async (libraryPath: string, order: number) => {
      if (!fs.pathExistsSync(path.join(libraryPath, '.description.json'))) {
        let description = {
          uuid: uuidV4(),
          type: 'library',
          order: order
        }
        await operateHiddenFile(path.join(libraryPath, '.description.json'), async () => {
          await fs.outputJson(path.join(libraryPath, '.description.json'), description)
        })
      }
    }
    let filterLibraryPath = path.join(dirPath, 'library/筛选库')
    let curatedLibraryPath = path.join(dirPath, 'library/精选库')
    await makeLibrary(filterLibraryPath, 1)
    await makeLibrary(curatedLibraryPath, 2)

    function hasSubdirectories(targetPath: fs.PathLike) {
      try {
        const items = fs.readdirSync(targetPath, { withFileTypes: true })
        for (const item of items) {
          if (item.isDirectory()) {
            return true
          }
        }
        return false
      } catch (err) {
        // 如果路径不存在或无法读取，会抛出错误
        console.error(err)
        return false
      }
    }
    if (!hasSubdirectories(filterLibraryPath) && !hasSubdirectories(curatedLibraryPath)) {
      await operateHiddenFile(
        path.join(filterLibraryPath, 'House', '.description.json'),
        async () => {
          await fs.outputJson(path.join(filterLibraryPath, 'House', '.description.json'), {
            uuid: 'filterLibrarySonglistDemo1',
            type: 'songList',
            order: 1
          })
          const filterLibrarySonglistSongDemo1 = path
            .join(
              __dirname,
              '../../resources/demoMusic/Oden & Fatzo, Poppy Baskcomb - Tell Me What You Want (Extended Mix).mp3'
            )
            .replace('app.asar', 'app.asar.unpacked')
          const filterLibrarySonglistSongDemo2 = path
            .join(__dirname, '../../resources/demoMusic/War - Low Rider (Kyle Watson Remix).mp3')
            .replace('app.asar', 'app.asar.unpacked')
          fs.copy(
            filterLibrarySonglistSongDemo1,
            path.join(
              filterLibraryPath,
              'House',
              'Oden & Fatzo, Poppy Baskcomb - Tell Me What You Want (Extended Mix).mp3'
            )
          )
          fs.copy(
            filterLibrarySonglistSongDemo2,
            path.join(filterLibraryPath, 'House', 'War - Low Rider (Kyle Watson Remix).mp3')
          )
        }
      )
      await operateHiddenFile(
        path.join(curatedLibraryPath, 'House Nice', '.description.json'),
        async () => {
          await fs.outputJson(path.join(curatedLibraryPath, 'House Nice', '.description.json'), {
            uuid: 'curatedLibrarySonglistDemo1',
            type: 'songList',
            order: 1
          })
          const curatedLibrarySonglistSongDemo1 = path
            .join(
              __dirname,
              '../../resources/demoMusic/Armand Van Helden - I Want Your Soul (AVH Rework).mp3'
            )
            .replace('app.asar', 'app.asar.unpacked')

          fs.copy(
            curatedLibrarySonglistSongDemo1,
            path.join(
              curatedLibraryPath,
              'House Nice',
              'Armand Van Helden - I Want Your Soul (AVH Rework).mp3'
            )
          )
        }
      )
    }

    if (fs.pathExistsSync(path.join(dirPath, 'songFingerprint', 'songFingerprint.json'))) {
      const json = await fs.readJSON(path.join(dirPath, 'songFingerprint', 'songFingerprint.json'))
      if (Array.isArray(json) && json.every((item) => typeof item === 'string')) {
      } else {
        await fs.outputJSON(path.join(dirPath, 'songFingerprint', 'songFingerprint.json'), [])
      }
    } else {
      await fs.outputJSON(path.join(dirPath, 'songFingerprint', 'songFingerprint.json'), [])
    }
    databaseInitWindow?.close()
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
  get instance() {
    return databaseInitWindow
  },
  createWindow
}
