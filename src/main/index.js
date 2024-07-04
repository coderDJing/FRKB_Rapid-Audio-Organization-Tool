import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import {
  updateTargetDirSubdirOrder,
  readJsonFile,
  deleteFolderRecursive,
  updateTargetDirSubdirOrderAfterNumMinus,
  getLibrary
} from './utils.js'
import layoutConfigFileUrl from '../../resources/config/layoutConfig.json?commonjs-external&asset'
import { v4 as uuidv4 } from 'uuid';

const fs = require('fs')
let layoutConfig = JSON.parse(fs.readFileSync(layoutConfigFileUrl))

const libraryInit = async () => {
  //检查有没有library文件夹
  fs.promises.access(join(__dirname, 'library'), fs.constants.F_OK).then(async () => {
    //有library文件夹
  }).catch(async err => {
    //没有library文件夹
    const makeLibrary = async (libraryPath, libraryName, order) => {
      await fs.promises.mkdir(libraryPath, { recursive: true })
      let description = {
        uuid: uuidv4(),
        type: 'library',
        dirName: libraryName,
        order: order
      }
      await fs.promises.writeFile(join(libraryPath, 'description.json'), JSON.stringify(description, null, 2))
    }
    await fs.promises.mkdir(join(__dirname, 'library'), { recursive: true })
    let rootDescription = {
      uuid: uuidv4(),
      type: 'root',
      dirName: 'library',
      order: 1
    }
    await fs.promises.writeFile(join(join(__dirname, 'library'), 'description.json'), JSON.stringify(rootDescription, null, 2))
    await makeLibrary(join(__dirname, 'library/筛选库'), '筛选库', 1)
    await makeLibrary(join(__dirname, 'library/精选库'), '精选库', 2)
  })
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
    fs.writeFile(layoutConfigFileUrl, layoutConfig, (error) => {
      if (error) {
        console.log("ipcMain.on('layoutConfigChanged') some error has occurred ", error);
      }
    })
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


ipcMain.handle('getLibrary', async () => {
  const library = await getLibrary()
  return library
})

ipcMain.handle('renameDir', async (e, newName, dirPath) => {
  let descriptionPath = join(__dirname, join(dirPath, 'description.json'))
  let descriptionJson = await readJsonFile(descriptionPath)
  descriptionJson.dirName = newName
  await fs.promises.writeFile(descriptionPath, JSON.stringify(descriptionJson, null, 2))
  await fs.promises.rename(join(__dirname, dirPath), join(__dirname, dirPath.slice(0, dirPath.lastIndexOf('/') + 1) + newName))
  return
})
ipcMain.handle('updateOrderAfterNum', async (e, path, order) => {
  await updateTargetDirSubdirOrderAfterNumMinus(join(__dirname, path), order)
})

ipcMain.handle('delDir', async (e, path) => {
  await deleteFolderRecursive(join(__dirname, path))
  return
})

ipcMain.handle('mkDir', async (e, descriptionJson, dirPath) => {
  await updateTargetDirSubdirOrder(join(__dirname, dirPath))
  let path = join(__dirname, dirPath, descriptionJson.dirName)
  await fs.promises.mkdir(path, { recursive: true })
  await fs.promises.writeFile(join(path, 'description.json'), JSON.stringify(descriptionJson, null, 2))
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
