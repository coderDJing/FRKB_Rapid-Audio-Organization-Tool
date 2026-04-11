import { ipcMain } from 'electron'
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
import {
  clearCuratedArtistLibrary,
  getCuratedArtistLibrarySnapshot,
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

  ipcMain.handle('setSetting', async (_event, setting) => {
    const prevContextMenu = !!store.settingConfig?.enableExplorerContextMenu
    const prevMode = store.settingConfig?.fingerprintMode === 'file' ? 'file' : 'pcm'
    store.settingConfig = setting
    await persistSettingConfig(setting)
    await saveLibrarySettingsFromConfig()

    try {
      applyThemeFromSettings()
      broadcastSystemThemeIfNeeded()
    } catch {}

    try {
      const nextMode = store.settingConfig?.fingerprintMode === 'file' ? 'file' : 'pcm'
      if (nextMode !== prevMode) {
        const list = await deps.loadFingerprintList(nextMode)
        store.songFingerprintList = Array.isArray(list) ? list : []
      }
    } catch {}

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
}
