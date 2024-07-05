import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import {
  updateTargetDirSubdirOrder,
  getLibrary
} from './utils.js'
import layoutConfigFileUrl from '../../resources/config/layoutConfig.json?commonjs-external&asset'
import { v4 as uuidv4 } from 'uuid';

const fs = require('fs-extra')
let layoutConfig = fs.readJSONSync(layoutConfigFileUrl)

const libraryInit = async () => {
  let rootDescription = {
    uuid: uuidv4(),
    type: 'root',
    dirName: 'library',
    order: 1
  }
  await fs.outputJson(join(join(__dirname, 'library'), 'description.json'), rootDescription)
  const makeLibrary = async (libraryPath, libraryName, order) => {
    let description = {
      uuid: uuidv4(),
      type: 'library',
      dirName: libraryName,
      order: order
    }
    await fs.outputJson(join(libraryPath, 'description.json'), description)
  }
  await makeLibrary(join(__dirname, 'library/筛选库'), '筛选库', 1)
  await makeLibrary(join(__dirname, 'library/精选库'), '精选库', 2)

}
libraryInit()

function createWindow() {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 500,
    minHeight: 300,
    frame: false,
    transparent: false,
    show: false,

    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.webContents.send('mainWin-max', true)
    } else {
      mainWindow.webContents.send('mainWin-max', false)
    }
    mainWindow.webContents.send('layoutConfigReaded', layoutConfig)
  })

  ipcMain.on('layoutConfigChanged', (e, layoutConfig) => {
    fs.outputJson(layoutConfigFileUrl, JSON.parse(layoutConfig))
  })
  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('mainWin-max', true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('mainWin-max', false)
  })
  ipcMain.on('toggle-maximize', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });

  ipcMain.on('toggle-minimize', () => {
    mainWindow.minimize()
  })

  ipcMain.on('toggle-close', () => {
    app.exit()
  })
  ipcMain.on('collapseButtonHandleClick', () => {
    mainWindow.webContents.send('collapseButtonHandleClick')
  })
}
ipcMain.handle('moveDir', async (e, src, dest, isExist) => {
  if (isExist) {
    let oldJson = await fs.readJSON(join(__dirname, dest, 'description.json'))
    await fs.remove(join(__dirname, dest, src.split('/')[dest, src.split('/').length - 1]))
    await updateTargetDirSubdirOrder(join(__dirname, dest), oldJson.order, 'before', 'plus')
    await fs.move(join(__dirname, src), join(__dirname, dest, src.split('/')[dest, src.split('/').length - 1]))
    let json = await fs.readJSON(join(__dirname, dest, 'description.json'))
    json.order = 1
    await fs.outputJSON(join(__dirname, dest, 'description.json'), json)
  } else {
    //todo
  }
  return
})

ipcMain.handle('getLibrary', async () => {
  const library = await getLibrary()
  return library
})

ipcMain.handle('renameDir', async (e, newName, dirPath) => {
  let descriptionPath = join(__dirname, join(dirPath, 'description.json'))
  let descriptionJson = await fs.readJSON(descriptionPath)
  descriptionJson.dirName = newName
  await fs.outputJson(descriptionPath, descriptionJson)
  await fs.rename(join(__dirname, dirPath), join(__dirname, dirPath.slice(0, dirPath.lastIndexOf('/') + 1) + newName))
  return
})
ipcMain.handle('updateOrderAfterNum', async (e, path, order) => {
  await updateTargetDirSubdirOrder(join(__dirname, path), order, 'after', 'minus')
  return
})

ipcMain.handle('delDir', async (e, path) => {
  await fs.remove(join(__dirname, path))
  return
})

ipcMain.handle('mkDir', async (e, descriptionJson, dirPath) => {
  await updateTargetDirSubdirOrder(join(__dirname, dirPath), 0, 'after', 'plus')
  let path = join(__dirname, dirPath, descriptionJson.dirName)
  await fs.outputJson(join(path, 'description.json'), descriptionJson)
  return
})

ipcMain.handle('updateTargetDirSubdirOrderAdd', async (e, dirPath) => {
  await updateTargetDirSubdirOrder(join(__dirname, dirPath), 0, 'after', 'plus')
  return
})

ipcMain.handle('select-folder', async (event, arg) => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  });
  if (result.canceled) {
    return null;
  }
  return result.filePaths[0];
});
// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app"s specific main process
// code. You can also put them in separate files and require them here.
