import type { BrowserWindow } from 'electron'
import {
  EMPTY_LIBRARY_SETUP_STATE,
  type LibrarySetupErrorHint,
  type LibrarySetupMode,
  type LibrarySetupState
} from '../shared/librarySetup'

type LibrarySetupListener = () => void

let librarySetupState: LibrarySetupState = { ...EMPTY_LIBRARY_SETUP_STATE }
const listeners = new Set<LibrarySetupListener>()

const emitLibrarySetupChanged = () => {
  listeners.forEach((listener) => {
    listener()
  })
}

export const getLibrarySetupState = (): LibrarySetupState => ({
  ...librarySetupState,
  errorHint: librarySetupState.errorHint ? { ...librarySetupState.errorHint } : null
})

export const isLibrarySetupActive = (): boolean => librarySetupState.active

export const beginLibrarySetup = (options?: {
  mode?: LibrarySetupMode
  errorHint?: LibrarySetupErrorHint | null
}): LibrarySetupState => {
  librarySetupState = {
    active: true,
    mode: options?.mode ?? 'required',
    errorHint: options?.errorHint ?? null
  }
  emitLibrarySetupChanged()
  return getLibrarySetupState()
}

export const clearLibrarySetup = (): LibrarySetupState => {
  librarySetupState = { ...EMPTY_LIBRARY_SETUP_STATE }
  emitLibrarySetupChanged()
  return getLibrarySetupState()
}

export const clearLibrarySetupErrorHint = (): LibrarySetupState => {
  if (!librarySetupState.errorHint) return getLibrarySetupState()
  librarySetupState = {
    ...librarySetupState,
    errorHint: null
  }
  emitLibrarySetupChanged()
  return getLibrarySetupState()
}

export const onLibrarySetupChanged = (listener: LibrarySetupListener): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const sendLibrarySetupState = (window: BrowserWindow | null | undefined): void => {
  if (!window || window.isDestroyed()) return
  window.webContents.send('library-setup:state', getLibrarySetupState())
}
