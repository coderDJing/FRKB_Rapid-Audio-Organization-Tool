import { contextBridge, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export interface PreloadApi {
  showFilesPath: (file: File) => string
  getDevRuntimeInfo: () => {
    instanceId: string
  }
}

const sanitizeDevInstanceId = (value: unknown): string =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

const resolveDevInstanceId = (): string => {
  const isDevRuntime =
    process.env.NODE_ENV === 'development' || !!String(process.env.ELECTRON_RENDERER_URL || '')
  if (!isDevRuntime) return ''
  return sanitizeDevInstanceId(process.env.FRKB_DEV_INSTANCE)
}
// Custom APIs for renderer
const api: PreloadApi = {
  showFilesPath(file) {
    const path = webUtils.getPathForFile(file)
    return path
  },
  getDevRuntimeInfo() {
    return {
      instanceId: resolveDevInstanceId()
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
