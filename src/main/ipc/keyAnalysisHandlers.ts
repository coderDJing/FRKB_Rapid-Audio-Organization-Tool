import { ipcMain } from 'electron'
import {
  cancelKeyAnalysisBackground,
  cancelManualKeyAnalysisBatch,
  enqueueKeyAnalysis,
  enqueueKeyAnalysisList,
  enqueueManualKeyAnalysisBatch,
  getManualKeyAnalysisPendingFilePaths,
  replaceVisibleKeyAnalysisList,
  getKeyAnalysisBackgroundStatus
} from '../services/keyAnalysisQueue'
import { isInRecordingLibraryAbsPath } from '../recordingLibraryService'

type VisibleQueuePayload = {
  filePaths?: string[]
  waveformOnly?: boolean
  scope?: 'list' | 'waveform-preview'
}

type ManualBatchPayload = {
  filePaths?: string[]
  titleKey?: string
}

export function registerKeyAnalysisHandlers() {
  ipcMain.on('key-analysis:queue-visible', (_e, payload: VisibleQueuePayload) => {
    const paths = Array.isArray(payload?.filePaths) ? payload.filePaths : []
    const normalized = paths.filter((p) => typeof p === 'string' && p.trim().length > 0)
    if (payload?.scope === 'waveform-preview') {
      enqueueKeyAnalysisList(normalized, 'low', {
        source: 'foreground',
        preemptible: true,
        category: 'waveform-preview',
        waveformOnly: payload?.waveformOnly === true
      })
      return
    }
    replaceVisibleKeyAnalysisList(normalized, {
      waveformOnly: payload?.waveformOnly === true
    })
  })

  ipcMain.on(
    'key-analysis:queue-playing',
    (_e, payload: { filePath?: string; focusSlot?: string }) => {
      const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
      if (!filePath) return
      if (isInRecordingLibraryAbsPath(filePath)) return
      enqueueKeyAnalysis(filePath, 'high', {
        urgent: true,
        source: 'foreground',
        focusSlot: payload?.focusSlot
      })
    }
  )

  ipcMain.on('key-analysis:queue-deck-idle', (_e, payload: { filePath?: string }) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
    if (!filePath) return
    if (isInRecordingLibraryAbsPath(filePath)) return
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

  ipcMain.handle('key-analysis:queue-manual-batch', (_e, payload?: ManualBatchPayload) => {
    const paths = Array.isArray(payload?.filePaths) ? payload.filePaths : []
    const normalized = paths.filter((p) => typeof p === 'string' && p.trim().length > 0)
    return enqueueManualKeyAnalysisBatch(normalized, {
      titleKey: typeof payload?.titleKey === 'string' ? payload.titleKey : undefined
    })
  })

  ipcMain.handle('key-analysis:manual-batch-pending', (_e, payload?: { filePaths?: string[] }) => {
    const paths = Array.isArray(payload?.filePaths) ? payload.filePaths : undefined
    return { filePaths: getManualKeyAnalysisPendingFilePaths(paths) }
  })

  ipcMain.handle(
    'key-analysis:cancel-manual-batch',
    async (_e, payload?: { batchId?: string } | string) => {
      const batchId =
        typeof payload === 'string'
          ? payload
          : typeof payload?.batchId === 'string'
            ? payload.batchId
            : ''
      return await cancelManualKeyAnalysisBatch(batchId)
    }
  )

  ipcMain.handle('key-analysis:background-status', () => {
    return getKeyAnalysisBackgroundStatus()
  })
}
