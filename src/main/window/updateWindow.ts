import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import { log } from '../log'
import type { ResolvedUpdateFileInfo, UpdateInfo } from 'electron-updater'
import electronUpdater = require('electron-updater')
import path = require('path')
import {
  type ManualMacUpdateAsset,
  type ManualMacUpdateAssetKind,
  type ManualMacUpdateResult,
  downloadManualMacUpdate,
  pickManualMacUpdateAsset
} from '../services/manualMacUpdate'
const autoUpdater = electronUpdater.autoUpdater
let updateWindow: BrowserWindow | null = null
const MANUAL_UPDATE_URL =
  'https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/releases/latest'
let autoUpdaterListenersRegistered = false
let latestMacManualUpdateAsset: ManualMacUpdateAsset | null = null
let latestMacManualUpdateResult: ManualMacUpdateResult | null = null
let manualMacDownloadPromise: Promise<ManualMacUpdateResult> | null = null

type UpdateErrorKind = 'network' | 'signature' | 'install' | 'unknown'

type UpdateErrorPayload = {
  kind: UpdateErrorKind
  message: string
  manualUrl?: string
}

type UpdateDownloadedPayload = {
  mode: 'auto' | 'manual'
  kind?: ManualMacUpdateAssetKind
  fileName?: string
  filePath?: string
  downloadDir?: string
}

const sendToUpdateWindow = (channel: string, payload?: unknown) => {
  if (!updateWindow || updateWindow.isDestroyed()) return
  updateWindow.webContents.send(channel, payload)
}

const resolveUpdateFiles = (updateInfo: UpdateInfo): ResolvedUpdateFileInfo[] => {
  const provider = (autoUpdater as any)?.updateInfoAndProvider?.provider
  if (provider?.resolveFiles instanceof Function) {
    try {
      return provider.resolveFiles(updateInfo) as ResolvedUpdateFileInfo[]
    } catch (error) {
      log.warn('[updateWindow] resolveFiles failed', error)
    }
  }

  return (Array.isArray(updateInfo?.files) ? updateInfo.files : [])
    .map((file) => {
      if (!file?.url || !/^https?:\/\//i.test(file.url)) return null
      try {
        return {
          url: new URL(file.url),
          info: file
        } satisfies ResolvedUpdateFileInfo
      } catch {
        return null
      }
    })
    .filter((entry): entry is ResolvedUpdateFileInfo => !!entry)
}

const rememberMacManualUpdateAsset = (updateInfo: UpdateInfo) => {
  if (process.platform !== 'darwin') return
  latestMacManualUpdateResult = null
  latestMacManualUpdateAsset = pickManualMacUpdateAsset(updateInfo, resolveUpdateFiles(updateInfo))
  if (!latestMacManualUpdateAsset) {
    log.warn('[updateWindow] no mac manual update asset resolved', {
      version: updateInfo?.version,
      files: updateInfo?.files
    })
  }
}

const buildUpdateErrorPayload = (error: unknown): UpdateErrorPayload => {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error || '')
  const normalized = message.toLowerCase()

  if (
    normalized.includes('net::err_timed_out') ||
    normalized.includes('net::err_name_not_resolved') ||
    normalized.includes('net::err_internet_disconnected') ||
    normalized.includes('net::err_connection') ||
    normalized.includes('fetch failed') ||
    normalized.includes('timeout')
  ) {
    return { kind: 'network', message }
  }

  if (
    normalized.includes('code signature') ||
    normalized.includes('did not pass validation') ||
    normalized.includes('not signed') ||
    message.includes('未签名') ||
    normalized.includes('shipit')
  ) {
    return {
      kind: 'signature',
      message,
      manualUrl: MANUAL_UPDATE_URL
    }
  }

  if (
    normalized.includes('install') ||
    normalized.includes('permission') ||
    normalized.includes('eacces') ||
    normalized.includes('access denied')
  ) {
    return {
      kind: 'install',
      message,
      manualUrl: process.platform === 'darwin' ? MANUAL_UPDATE_URL : undefined
    }
  }

  return {
    kind: 'unknown',
    message,
    manualUrl: process.platform === 'darwin' ? MANUAL_UPDATE_URL : undefined
  }
}

const registerAutoUpdaterListeners = () => {
  if (autoUpdaterListenersRegistered) return
  autoUpdaterListenersRegistered = true
  autoUpdater.logger = log

  autoUpdater.on('update-available', (info) => {
    const currentIsPrerelease = app.getVersion().includes('-')
    const remoteIsPrerelease = !!(
      info &&
      typeof (info as any).version === 'string' &&
      (info as any).version.includes('-')
    )
    if (currentIsPrerelease !== remoteIsPrerelease) return
    rememberMacManualUpdateAsset(info)
    sendToUpdateWindow('newVersion', info)
  })

  autoUpdater.on('update-not-available', (info) => {
    // 当同轨道无更新，才提示“已是最新版本”
    const currentIsPrerelease = app.getVersion().includes('-')
    const remoteVersion = (info as any)?.version as string | undefined
    const remoteIsPrerelease = !!(remoteVersion && remoteVersion.includes('-'))
    if (remoteVersion && currentIsPrerelease === remoteIsPrerelease) {
      sendToUpdateWindow('isLatestVersion', info.version)
    } else if (!remoteVersion) {
      sendToUpdateWindow('isLatestVersion', app.getVersion())
    }
  })

  autoUpdater.on('error', (err) => {
    const payload = buildUpdateErrorPayload(err)
    sendToUpdateWindow('isError', payload)
    log.error('autoUpdater error', payload, err)
  })

  autoUpdater.on('download-progress', (progressObj) => {
    sendToUpdateWindow('updateProgress', progressObj)
  })

  autoUpdater.on('update-downloaded', () => {
    sendToUpdateWindow('updateDownloaded', {
      mode: 'auto'
    } satisfies UpdateDownloadedPayload)
  })
}

const handleStartDownload = () => {
  if (process.platform === 'darwin') {
    if (!latestMacManualUpdateAsset) {
      const payload: UpdateErrorPayload = {
        kind: 'unknown',
        message: '没有找到可下载的新版本文件，请稍后重试。',
        manualUrl: MANUAL_UPDATE_URL
      }
      sendToUpdateWindow('isError', payload)
      log.warn('[updateWindow] missing mac manual update asset')
      return
    }

    if (manualMacDownloadPromise) return

    sendToUpdateWindow('updateProgress', {
      percent: 0,
      bytesPerSecond: 0,
      transferredBytes: 0,
      totalBytes: latestMacManualUpdateAsset.totalBytes,
      fileName: latestMacManualUpdateAsset.fileName
    })

    manualMacDownloadPromise = downloadManualMacUpdate(latestMacManualUpdateAsset, (progress) => {
      sendToUpdateWindow('updateProgress', progress)
    })

    void manualMacDownloadPromise
      .then((result) => {
        latestMacManualUpdateResult = result
        openDownloadedFilePath(result.filePath)
        sendToUpdateWindow('updateDownloaded', {
          mode: 'manual',
          kind: result.kind,
          fileName: result.fileName,
          filePath: result.filePath,
          downloadDir: result.downloadDir
        } satisfies UpdateDownloadedPayload)
      })
      .catch((error) => {
        const payload = buildUpdateErrorPayload(error)
        payload.manualUrl = MANUAL_UPDATE_URL
        sendToUpdateWindow('isError', payload)
        log.error('[updateWindow] manual mac update download failed', payload, error)
      })
      .finally(() => {
        manualMacDownloadPromise = null
      })
    return
  }

  void autoUpdater.downloadUpdate().catch((error) => {
    const payload = buildUpdateErrorPayload(error)
    sendToUpdateWindow('isError', payload)
    log.error('[updateWindow] downloadUpdate failed', payload, error)
  })
}

const handleToggleClose = () => {
  updateWindow?.close()
}

const handleToggleMinimize = () => {
  updateWindow?.minimize()
}

const handleOpenManualDownload = () => {
  void shell.openExternal(MANUAL_UPDATE_URL)
}

const openDownloadedFilePath = (filePath: string) => {
  void shell.openPath(filePath).then((result) => {
    if (!result) return
    log.warn('[updateWindow] open downloaded file failed', { filePath, result })
    try {
      shell.showItemInFolder(filePath)
    } catch (error) {
      log.warn('[updateWindow] fallback showItemInFolder failed', { filePath, error })
    }
  })
}

const handleOpenDownloadedFile = () => {
  const filePath = latestMacManualUpdateResult?.filePath
  if (!filePath) return
  openDownloadedFilePath(filePath)
}

const handleOpenDownloadFolder = () => {
  const filePath = latestMacManualUpdateResult?.filePath
  if (!filePath) return
  try {
    shell.showItemInFolder(filePath)
  } catch (error) {
    log.warn('[updateWindow] showItemInFolder failed', { filePath, error })
  }
}

const handleOpenApplicationsFolder = () => {
  if (process.platform !== 'darwin') return
  void shell.openPath('/Applications').then((result) => {
    if (result) {
      log.warn('[updateWindow] open applications folder failed', result)
    }
  })
}

const createWindow = () => {
  registerAutoUpdaterListeners()
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
    const versionString = app.getVersion()
    const isPrerelease = versionString.includes('-')
    try {
      ;(autoUpdater as any).allowPrerelease = isPrerelease
    } catch {}
    try {
      if (isPrerelease && /-rc[.-]/i.test(versionString)) {
        ;(autoUpdater as any).channel = 'rc'
      }
    } catch {}
    void autoUpdater.checkForUpdates().catch((error) => {
      const payload = buildUpdateErrorPayload(error)
      sendToUpdateWindow('isError', payload)
      log.error('[updateWindow] checkForUpdates failed', payload, error)
    })
  })
  ipcMain.on('updateWindow-startDownload', handleStartDownload)
  ipcMain.on('updateWindow-toggle-close', handleToggleClose)
  ipcMain.on('updateWindow-toggle-minimize', handleToggleMinimize)
  ipcMain.on('updateWindow-open-manual-download', handleOpenManualDownload)
  ipcMain.on('updateWindow-open-downloaded-file', handleOpenDownloadedFile)
  ipcMain.on('updateWindow-open-download-folder', handleOpenDownloadFolder)
  ipcMain.on('updateWindow-open-applications-folder', handleOpenApplicationsFolder)

  updateWindow.on('closed', () => {
    ipcMain.removeListener('updateWindow-startDownload', handleStartDownload)
    ipcMain.removeListener('updateWindow-toggle-close', handleToggleClose)
    ipcMain.removeListener('updateWindow-toggle-minimize', handleToggleMinimize)
    ipcMain.removeListener('updateWindow-open-manual-download', handleOpenManualDownload)
    ipcMain.removeListener('updateWindow-open-downloaded-file', handleOpenDownloadedFile)
    ipcMain.removeListener('updateWindow-open-download-folder', handleOpenDownloadFolder)
    ipcMain.removeListener('updateWindow-open-applications-folder', handleOpenApplicationsFolder)
    updateWindow = null
  })
}

export default {
  get instance() {
    return updateWindow
  },
  createWindow
}
