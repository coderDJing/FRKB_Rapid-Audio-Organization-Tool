import { app, BrowserWindow, shell, ipcMain, screen } from 'electron'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import path = require('path')
import { log } from '../log'

export type MixtapeWindowPayload = {
  playlistId?: string
  playlistPath?: string
  playlistName?: string
}

const mixtapeWindows = new Map<string, BrowserWindow>()
const payloadByKey = new Map<string, MixtapeWindowPayload>()
const allClosedListeners = new Set<() => void>()
let ipcBound = false

const MIXTAPE_WINDOW_DEFAULT_WIDTH = 1200
const MIXTAPE_WINDOW_DEFAULT_HEIGHT = 820
const MIXTAPE_WINDOW_MIN_WIDTH = 1000
const MIXTAPE_WINDOW_MIN_HEIGHT = 640
const MIXTAPE_WINDOW_MARGIN = 24

const resolveMixtapeWindowBounds = () => {
  const cursorPoint = screen.getCursorScreenPoint()
  const targetDisplay = screen.getDisplayNearestPoint(cursorPoint)
  const workArea = targetDisplay.workArea

  const maxWidth = Math.max(640, workArea.width - MIXTAPE_WINDOW_MARGIN * 2)
  const maxHeight = Math.max(480, workArea.height - MIXTAPE_WINDOW_MARGIN * 2)

  const width = Math.min(MIXTAPE_WINDOW_DEFAULT_WIDTH, maxWidth)
  const height = Math.min(MIXTAPE_WINDOW_DEFAULT_HEIGHT, maxHeight)
  const minWidth = Math.min(MIXTAPE_WINDOW_MIN_WIDTH, width)
  const minHeight = Math.min(MIXTAPE_WINDOW_MIN_HEIGHT, height)

  const x = Math.round(workArea.x + (workArea.width - width) / 2)
  const y = Math.round(workArea.y + (workArea.height - height) / 2)

  return { width, height, minWidth, minHeight, x, y }
}

export const isMixtapeWindowOpenByPlaylistId = (playlistId: string): boolean => {
  const normalizedId = (playlistId || '').trim()
  if (!normalizedId) return false

  const directWindow = mixtapeWindows.get(normalizedId)
  if (directWindow) {
    if (directWindow.isDestroyed()) {
      mixtapeWindows.delete(normalizedId)
      payloadByKey.delete(normalizedId)
    } else {
      return true
    }
  }

  for (const [key, payload] of payloadByKey.entries()) {
    if ((payload?.playlistId || '').trim() !== normalizedId) continue
    const targetWindow = mixtapeWindows.get(key)
    if (!targetWindow || targetWindow.isDestroyed()) {
      mixtapeWindows.delete(key)
      payloadByKey.delete(key)
      continue
    }
    return true
  }

  return false
}

const resolveWindowKey = (payload: MixtapeWindowPayload) => {
  return (
    (payload.playlistId || '').trim() ||
    (payload.playlistPath || '').trim() ||
    (payload.playlistName || '').trim() ||
    'mixtape'
  )
}

const sendMaxState = (target: BrowserWindow | null, next: boolean) => {
  try {
    target?.webContents.send('mixtapeWindow-max', next)
  } catch {}
}

const setVisualEffectMaterial = (target: BrowserWindow, material: string) => {
  const setter = Reflect.get(target, 'setVisualEffectMaterial')
  if (typeof setter !== 'function') return
  Reflect.apply(setter, target, [material])
}

const ensureIpcHandlers = () => {
  if (ipcBound) return
  ipcBound = true
  ipcMain.on('mixtapeWindow-toggle-maximize', (event) => {
    const target = BrowserWindow.fromWebContents(event.sender)
    if (!target) return
    if (target.isMaximized()) {
      target.unmaximize()
    } else {
      target.maximize()
    }
  })

  ipcMain.on('mixtapeWindow-toggle-minimize', (event) => {
    const target = BrowserWindow.fromWebContents(event.sender)
    target?.minimize()
  })

  ipcMain.on('mixtapeWindow-toggle-close', (event) => {
    const target = BrowserWindow.fromWebContents(event.sender)
    target?.close()
  })
}

const sendPayloadToWindow = (target: BrowserWindow | null, payload?: MixtapeWindowPayload) => {
  if (!target || !payload) return
  try {
    target.webContents.send('mixtape-open', payload)
  } catch {}
}

const notifyAllClosedListeners = () => {
  for (const listener of allClosedListeners) {
    try {
      listener()
    } catch {}
  }
}

const createWindow = (payload: MixtapeWindowPayload, windowKey: string) => {
  ensureIpcHandlers()
  const bounds = resolveMixtapeWindowBounds()
  const mixtapeWindow = new BrowserWindow({
    resizable: true,
    width: bounds.width,
    height: bounds.height,
    minWidth: bounds.minWidth,
    minHeight: bounds.minHeight,
    x: bounds.x,
    y: bounds.y,
    frame: process.platform === 'darwin' ? true : false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    transparent: false,
    show: false,
    backgroundColor: '#0c0c0c',
    maximizable: true,

    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index'),
      sandbox: false,
      backgroundThrottling: false
    }
  })

  mixtapeWindows.set(windowKey, mixtapeWindow)
  payloadByKey.set(windowKey, payload)

  if (process.platform === 'darwin') {
    try {
      mixtapeWindow.setVibrancy('under-window')
    } catch {}
    try {
      setVisualEffectMaterial(mixtapeWindow, 'under-window')
    } catch {}
  }

  if (is.dev && process.env.FRKB_OPEN_DEVTOOLS === '1') {
    mixtapeWindow.webContents.openDevTools()
  }

  mixtapeWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  mixtapeWindow.webContents.on('render-process-gone', (_event, details) => {
    log.error('[mixtape] render-process-gone', details)
  })

  mixtapeWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
    log.error('[mixtape] did-fail-load', { code, desc, url })
  })

  mixtapeWindow.webContents.on('unresponsive', () => {
    log.error('[mixtape] renderer unresponsive')
  })

  mixtapeWindow.webContents.on('did-finish-load', () => {
    sendPayloadToWindow(mixtapeWindow, payloadByKey.get(windowKey))
    sendMaxState(mixtapeWindow, !!mixtapeWindow?.isMaximized())
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const query = new URLSearchParams()
    if (payload.playlistId) query.set('playlistId', payload.playlistId)
    if (payload.playlistPath) query.set('playlistPath', payload.playlistPath)
    if (payload.playlistName) query.set('playlistName', payload.playlistName)
    const queryString = query.toString()
    const url = `${process.env['ELECTRON_RENDERER_URL']}/mixtape.html${
      queryString ? `?${queryString}` : ''
    }`
    mixtapeWindow.loadURL(url)
  } else {
    const query: Record<string, string> = {}
    if (payload.playlistId) query.playlistId = payload.playlistId
    if (payload.playlistPath) query.playlistPath = payload.playlistPath
    if (payload.playlistName) query.playlistName = payload.playlistName
    mixtapeWindow.loadFile(path.join(__dirname, '../renderer/mixtape.html'), {
      query
    })
  }

  mixtapeWindow.on('ready-to-show', () => {
    mixtapeWindow?.show()
  })

  mixtapeWindow.on('maximize', () => {
    sendMaxState(mixtapeWindow, true)
  })

  mixtapeWindow.on('unmaximize', () => {
    sendMaxState(mixtapeWindow, false)
  })

  mixtapeWindow.on('closed', () => {
    mixtapeWindows.delete(windowKey)
    payloadByKey.delete(windowKey)
    if (mixtapeWindows.size === 0) {
      notifyAllClosedListeners()
    }
  })

  return mixtapeWindow
}

function sendPayloadIfAny() {
  for (const [key, win] of mixtapeWindows.entries()) {
    sendPayloadToWindow(win, payloadByKey.get(key))
  }
}

function broadcast(channel: string, payload?: unknown) {
  if (!channel) return
  for (const win of mixtapeWindows.values()) {
    try {
      win.webContents.send(channel, payload)
    } catch {}
  }
}

function open(payload: MixtapeWindowPayload) {
  const windowKey = resolveWindowKey(payload || {})
  payloadByKey.set(windowKey, payload || {})
  const existing = mixtapeWindows.get(windowKey)
  if (existing) {
    if (existing.isDestroyed()) {
      mixtapeWindows.delete(windowKey)
    } else {
      try {
        if (existing.isMinimized()) {
          existing.restore()
        }
        existing.show()
        existing.focus()
      } catch {}
      sendPayloadToWindow(existing, payloadByKey.get(windowKey))
      return existing
    }
  }
  return createWindow(payload || {}, windowKey)
}

function onAllClosed(listener: () => void) {
  if (typeof listener !== 'function') return () => {}
  allClosedListeners.add(listener)
  return () => {
    allClosedListeners.delete(listener)
  }
}

export default {
  get instance() {
    return mixtapeWindows.values().next().value || null
  },
  open,
  sendPayloadIfAny,
  broadcast,
  onAllClosed
}
