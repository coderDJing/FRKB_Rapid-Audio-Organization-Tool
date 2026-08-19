import { app, BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import path from 'node:path'
import { restrictExternalNavigation } from './externalNavigation'
import type { LibraryRelocateProgress } from '../services/libraryRelocate'

type BrowserWindowWithVisualEffect = BrowserWindow & {
  setVisualEffectMaterial?: (material: string) => void
}

let relocateWindow: BrowserWindow | null = null
let latestProgress: LibraryRelocateProgress | null = null
let canClose = false

const sendProgress = () => {
  if (!relocateWindow || relocateWindow.isDestroyed()) return
  relocateWindow.webContents.send('library-relocate:progress', latestProgress)
}

const createWindow = async (): Promise<BrowserWindow> => {
  if (relocateWindow && !relocateWindow.isDestroyed()) {
    if (relocateWindow.isMinimized()) relocateWindow.restore()
    relocateWindow.focus()
    sendProgress()
    return relocateWindow
  }

  canClose = false
  relocateWindow = new BrowserWindow({
    resizable: false,
    width: 640,
    height: 430,
    frame: process.platform === 'darwin' ? true : false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    transparent: false,
    show: false,
    title: 'FRKB',
    backgroundColor: '#000000',
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index'),
      sandbox: false,
      backgroundThrottling: false
    }
  })

  if (process.platform === 'darwin') {
    try {
      relocateWindow.setVibrancy('under-window')
    } catch {}
    try {
      ;(relocateWindow as BrowserWindowWithVisualEffect).setVisualEffectMaterial?.('under-window')
    } catch {}
  }

  if (!app.isPackaged && process.env.FRKB_OPEN_DEVTOOLS === '1') {
    relocateWindow.webContents.openDevTools()
  }
  restrictExternalNavigation(relocateWindow.webContents)

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void relocateWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/libraryRelocate.html`)
  } else {
    void relocateWindow.loadFile(path.join(__dirname, '../renderer/libraryRelocate.html'))
  }

  relocateWindow.webContents.on('did-finish-load', sendProgress)
  await new Promise<void>((resolve) => {
    const finish = () => {
      relocateWindow?.show()
      sendProgress()
      resolve()
    }
    if (!relocateWindow) {
      resolve()
      return
    }
    relocateWindow.on('close', (event) => {
      if (!canClose) event.preventDefault()
    })
    if (relocateWindow.isVisible()) {
      finish()
      return
    }
    relocateWindow.once('ready-to-show', finish)
  })
  return relocateWindow
}

const setProgress = (progress: LibraryRelocateProgress | null) => {
  latestProgress = progress
  sendProgress()
}

const closeWindow = () => {
  const target = relocateWindow
  relocateWindow = null
  latestProgress = null
  canClose = true
  if (!target || target.isDestroyed()) return
  try {
    target.setClosable(true)
  } catch {}
  try {
    target.hide()
    target.destroy()
  } catch {}
}

export default {
  get instance() {
    return relocateWindow
  },
  createWindow,
  setProgress,
  closeWindow
}
