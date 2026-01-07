import { ipcMain } from 'electron'
import { enqueueKeyAnalysisImmediate, enqueueKeyAnalysisList } from '../services/keyAnalysisQueue'

type VisibleQueuePayload = {
  filePaths?: string[]
}

export function registerKeyAnalysisHandlers() {
  ipcMain.on('key-analysis:queue-visible', (_e, payload: VisibleQueuePayload) => {
    const paths = Array.isArray(payload?.filePaths) ? payload.filePaths : []
    const normalized = paths.filter((p) => typeof p === 'string' && p.trim().length > 0)
    if (normalized.length === 0) return
    enqueueKeyAnalysisList(normalized, 'medium')
  })

  ipcMain.on('key-analysis:queue-playing', (_e, payload: { filePath?: string }) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
    if (!filePath) return
    enqueueKeyAnalysisImmediate(filePath)
  })
}
