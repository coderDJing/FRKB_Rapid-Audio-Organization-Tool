import type { IpcRendererEvent } from 'electron'

type StartupState = {
  message?: unknown
  theme?: unknown
  version?: unknown
}

const statusText = document.getElementById('status-text')
const versionText = document.getElementById('version-text')

const applyState = (_event: IpcRendererEvent, state: unknown) => {
  const startupState =
    state && typeof state === 'object' ? (state as StartupState) : ({} as StartupState)
  const message = typeof startupState.message === 'string' ? startupState.message.trim() : ''
  if (message && statusText) {
    statusText.textContent = message
  }
  const version = typeof startupState.version === 'string' ? startupState.version.trim() : ''
  if (version && versionText) {
    versionText.textContent = `v${version}`
  }
  const isLight = startupState.theme === 'light'
  document.documentElement.dataset.theme = isLight ? 'light' : 'dark'
}

window.electron.ipcRenderer.on('startup:state', applyState)
