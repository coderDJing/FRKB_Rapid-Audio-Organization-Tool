import { app, BrowserWindow, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import path from 'node:path'
import { type LibrarySchemaV36MigrationProgress } from '../librarySchemaV36Migration'
import { restrictExternalNavigation } from './externalNavigation'

let databaseSchemaMigrationWindow: BrowserWindow | null = null
let schemaMigrationProgress: LibrarySchemaV36MigrationProgress | null = null
let canClose = false

const sendProgress = () => {
  if (!databaseSchemaMigrationWindow || databaseSchemaMigrationWindow.isDestroyed()) return
  databaseSchemaMigrationWindow.webContents.send(
    'databaseInitWindow-schemaMigrationProgress',
    schemaMigrationProgress
  )
}

const createWindow = () => {
  if (databaseSchemaMigrationWindow && !databaseSchemaMigrationWindow.isDestroyed()) {
    if (databaseSchemaMigrationWindow.isMinimized()) databaseSchemaMigrationWindow.restore()
    databaseSchemaMigrationWindow.focus()
    sendProgress()
    return
  }

  canClose = schemaMigrationProgress?.phase === 'failed'
  databaseSchemaMigrationWindow = new BrowserWindow({
    width: 500,
    height: 300,
    minWidth: 500,
    minHeight: 300,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    frame: process.platform === 'darwin' ? true : false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    transparent: false,
    show: false,
    title: 'FRKB',
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index'),
      sandbox: false,
      backgroundThrottling: false
    }
  })

  if (!app.isPackaged && process.env.FRKB_OPEN_DEVTOOLS === '1') {
    databaseSchemaMigrationWindow.webContents.openDevTools()
  }
  restrictExternalNavigation(databaseSchemaMigrationWindow.webContents)

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    databaseSchemaMigrationWindow.loadURL(
      `${process.env.ELECTRON_RENDERER_URL}/databaseInit.html?mode=schema-migration`
    )
  } else {
    databaseSchemaMigrationWindow.loadFile(path.join(__dirname, '../renderer/databaseInit.html'), {
      query: { mode: 'schema-migration' }
    })
  }

  databaseSchemaMigrationWindow.on('ready-to-show', () => {
    databaseSchemaMigrationWindow?.show()
    sendProgress()
  })
  databaseSchemaMigrationWindow.on('close', (event) => {
    if (!canClose) event.preventDefault()
  })
  ipcMain.on('databaseSchemaMigrationWindow-close', close)
  databaseSchemaMigrationWindow.on('closed', () => {
    ipcMain.removeListener('databaseSchemaMigrationWindow-close', close)
    databaseSchemaMigrationWindow = null
    schemaMigrationProgress = null
    canClose = false
  })
}

const setSchemaMigrationProgress = (progress: LibrarySchemaV36MigrationProgress | null) => {
  schemaMigrationProgress = progress
  if (progress?.phase === 'failed') canClose = true
  sendProgress()
}

const close = () => {
  if (!databaseSchemaMigrationWindow || databaseSchemaMigrationWindow.isDestroyed()) return
  canClose = true
  databaseSchemaMigrationWindow.close()
}

const hasFailedMigration = () => schemaMigrationProgress?.phase === 'failed'

export default {
  get instance() {
    return databaseSchemaMigrationWindow
  },
  createWindow,
  setSchemaMigrationProgress,
  hasFailedMigration,
  close
}
