import { ipcMain } from 'electron'
import {
  cancelKeyAnalysisBackground,
  enqueueKeyAnalysis,
  enqueueKeyAnalysisImmediate,
  replaceVisibleKeyAnalysisList,
  getKeyAnalysisBackgroundStatus
} from '../services/keyAnalysisQueue'

type VisibleQueuePayload = {
  filePaths?: string[]
}

export function registerKeyAnalysisHandlers() {
  ipcMain.on('key-analysis:queue-visible', (_e, payload: VisibleQueuePayload) => {
    const paths = Array.isArray(payload?.filePaths) ? payload.filePaths : []
    const normalized = paths.filter((p) => typeof p === 'string' && p.trim().length > 0)
    replaceVisibleKeyAnalysisList(normalized)
  })

  ipcMain.on(
    'key-analysis:queue-playing',
    (_e, payload: { filePath?: string; focusSlot?: string }) => {
      const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
      const focusSlot = typeof payload?.focusSlot === 'string' ? payload.focusSlot.trim() : ''
      if (!filePath) return
      enqueueKeyAnalysisImmediate(filePath, { focusSlot })
    }
  )

  ipcMain.on('key-analysis:queue-deck-idle', (_e, payload: { filePath?: string }) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
    if (!filePath) return
    enqueueKeyAnalysis(filePath, 'low', {
      source: 'foreground',
      preemptible: true
    })
  })

  ipcMain.handle('key-analysis:cancel-background', (_e, payload?: { mode?: string }) => {
    const mode = String(payload?.mode || '')
    const pauseMs = mode === '1h' ? 60 * 60 * 1000 : mode === '3h' ? 3 * 60 * 60 * 1000 : 0
    cancelKeyAnalysisBackground(pauseMs || undefined)
  })

  ipcMain.handle('key-analysis:background-status', () => {
    return getKeyAnalysisBackgroundStatus()
  })
}
