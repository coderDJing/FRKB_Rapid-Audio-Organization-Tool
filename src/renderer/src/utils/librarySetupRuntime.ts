import {
  EMPTY_LIBRARY_SETUP_STATE,
  isLibrarySetupErrorHint,
  isLibrarySetupMode,
  type LibrarySetupState
} from '@shared/librarySetup'
import { useRuntimeStore } from '@renderer/stores/runtime'

export const applyLibrarySetupState = (payload: unknown): LibrarySetupState => {
  const runtime = useRuntimeStore()
  const raw =
    payload && typeof payload === 'object' ? (payload as Partial<LibrarySetupState>) : null
  const next: LibrarySetupState = {
    active: raw?.active === true,
    mode: isLibrarySetupMode(raw?.mode) ? raw.mode : null,
    errorHint: isLibrarySetupErrorHint(raw?.errorHint) ? raw.errorHint : null
  }
  if (!next.active) {
    next.mode = null
    next.errorHint = null
  }
  runtime.librarySetupActive = next.active
  runtime.librarySetupMode = next.mode
  runtime.librarySetupErrorHint = next.errorHint
  return next
}

export const resetLibrarySetupRuntime = (): void => {
  applyLibrarySetupState(EMPTY_LIBRARY_SETUP_STATE)
}
