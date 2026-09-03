import { ipcMain } from 'electron'
import store from '../store'
import mainWindow from '../window/mainWindow'
import {
  initializeLibraryAtPath,
  type InitializeLibraryOptions
} from '../services/initializeLibrary'
import {
  beginLibrarySetup,
  clearLibrarySetup,
  clearLibrarySetupErrorHint,
  getLibrarySetupState,
  sendLibrarySetupState
} from '../librarySetupState'
import { isLibraryRelocateActive, hasLibraryRelocateJournalSync } from '../services/libraryRelocate'
import { persistLayoutConfig, mergeLayoutConfig } from '../layoutConfig'

const persistMainWindowLayout = async () => {
  const win = mainWindow.instance
  if (!win || win.isDestroyed()) return
  const size = win.getSize()
  const next = mergeLayoutConfig(store.layoutConfig, {
    isMaxMainWin: !!win.isMaximized(),
    ...(size ? { mainWindowWidth: size[0], mainWindowHeight: size[1] } : {})
  })
  store.layoutConfig = next
  await persistLayoutConfig(next)
}

export const registerLibrarySetupHandlers = (): void => {
  ipcMain.handle('library-setup:getState', () => getLibrarySetupState())

  ipcMain.handle('library-setup:clearErrorHint', () => clearLibrarySetupErrorHint())

  ipcMain.handle('library-setup:cancel', () => {
    const current = getLibrarySetupState()
    if (!current.active || current.mode !== 'reselect') {
      return { ok: false as const }
    }
    const next = clearLibrarySetup()
    sendLibrarySetupState(mainWindow.instance)
    return { ok: true as const, state: next }
  })

  ipcMain.handle(
    'library-setup:init',
    async (_event, dirPath: string, options?: InitializeLibraryOptions) => {
      return await initializeLibraryAtPath(String(dirPath || '').trim(), options)
    }
  )

  ipcMain.handle('reSelectLibrary', async () => {
    if (isLibraryRelocateActive() || hasLibraryRelocateJournalSync()) return
    try {
      const { stopCuratedLibraryLiveSync } = await import('../curatedLibrarySync/liveSync')
      stopCuratedLibraryLiveSync()
      const { cancelCuratedLibrarySync } = await import('../curatedLibrarySync/engine')
      await cancelCuratedLibrarySync()
    } catch {}
    await persistMainWindowLayout()
    beginLibrarySetup({ mode: 'reselect' })
    sendLibrarySetupState(mainWindow.instance)
  })
}
