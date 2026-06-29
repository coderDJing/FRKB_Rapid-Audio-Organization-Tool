import { BrowserWindow, ipcMain } from 'electron'
import store from '../store'
import { applyThemeFromSettings, broadcastSystemThemeIfNeeded } from '../bootstrap/settings'
import {
  clearWindowsContextMenuSignature,
  ensureWindowsContextMenuIfNeeded,
  removeWindowsContextMenu
} from '../platform/windowsContextMenu'
import { rebuildMacMenusForCurrentFocus } from '../menu/macMenu'
import { saveLibrarySettingsFromConfig } from '../librarySettingsDb'
import { persistSettingConfig } from '../settingsPersistence'
import { syncWindowScreenshotShortcut } from '../window/mainWindow'
import mainWindow from '../window/mainWindow'
import { CURATED_ARTIST_IMPORT_PROGRESS_ID } from '../../shared/curatedArtistProgress'
import {
  clearCuratedArtistLibrary,
  getCuratedArtistLibrarySnapshot,
  importCuratedArtistsFromTracks,
  replaceCuratedArtistLibrary,
  removeCuratedArtist
} from '../curatedArtistLibrary'

type Dependencies = {
  loadFingerprintList: (mode: 'pcm' | 'file') => Promise<string[]>
}

export function registerSettingsHandlers(deps: Dependencies) {
  ipcMain.handle('getSetting', () => {
    return store.settingConfig
  })

  // 串行化队列，防止快速连续调用导致 prevMode/prevContextMenu 比较不准确
  let setSettingQueue: Promise<void> = Promise.resolve()

  ipcMain.handle('setSetting', async (_event, setting) => {
    const task = setSettingQueue
      .catch(() => undefined)
      .then(async () => {
        const prevContextMenu = !!store.settingConfig?.enableExplorerContextMenu
        const prevMode = store.settingConfig?.fingerprintMode === 'file' ? 'file' : 'pcm'
        store.settingConfig = setting
        await persistSettingConfig(setting)
        await saveLibrarySettingsFromConfig()

        try {
          applyThemeFromSettings()
          broadcastSystemThemeIfNeeded()
          // 向所有窗口广播设置变更，确保主题同步
          const allWindows = BrowserWindow.getAllWindows()
          for (const win of allWindows) {
            try {
              win.webContents.send('setting-changed', setting)
            } catch {}
          }
        } catch {}

        try {
          const nextMode = store.settingConfig?.fingerprintMode === 'file' ? 'file' : 'pcm'
          if (nextMode !== prevMode) {
            const list = await deps.loadFingerprintList(nextMode)
            store.songFingerprintList = Array.isArray(list) ? list : []
          }
        } catch {}

        syncWindowScreenshotShortcut()

        if (process.platform === 'darwin') {
          rebuildMacMenusForCurrentFocus()
        }

        if (process.platform === 'win32') {
          const nextContextMenu = !!store.settingConfig?.enableExplorerContextMenu
          if (nextContextMenu) {
            await ensureWindowsContextMenuIfNeeded()
          } else if (prevContextMenu) {
            await removeWindowsContextMenu()
            await clearWindowsContextMenuSignature()
          }
        }
      })
    setSettingQueue = task.catch(() => undefined)
    await task
  })

  ipcMain.handle('curatedArtists:get', () => {
    return getCuratedArtistLibrarySnapshot()
  })

  ipcMain.handle('curatedArtists:remove', (_event, artistName) => {
    return removeCuratedArtist(artistName)
  })

  ipcMain.handle('curatedArtists:clear', () => {
    return clearCuratedArtistLibrary()
  })

  ipcMain.handle('curatedArtists:setAll', (_event, artists) => {
    return replaceCuratedArtistLibrary(artists)
  })

  ipcMain.handle(
    'curatedArtists:importFromTracks',
    async (_event, payload: { tracks?: Array<{ artistName?: unknown; filePath?: unknown }> }) => {
      const progressId = CURATED_ARTIST_IMPORT_PROGRESS_ID
      try {
        return await importCuratedArtistsFromTracks(payload, {
          onProgress: (progress) => {
            mainWindow.instance?.webContents.send('progressSet', {
              id: progressId,
              titleKey:
                progress.stage === 'fingerprint'
                  ? 'settings.curatedArtistTracking.importProgressFingerprint'
                  : 'settings.curatedArtistTracking.importProgressScan',
              now: progress.processed,
              total: progress.total,
              isInitial: progress.processed === 0,
              noProgress: progress.total <= 0
            })
          }
        })
      } finally {
        mainWindow.instance?.webContents.send('progressSet', {
          id: progressId,
          dismiss: true
        })
      }
    }
  )
}
