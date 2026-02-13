import { ipcMain } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import mixtapeWindow, { type MixtapeWindowPayload } from '../window/mixtapeWindow'
import mainWindow from '../window/mainWindow'
import {
  appendMixtapeItems,
  listMixtapeItems,
  listMixtapeFilePathsByItemIds,
  removeMixtapeItemsById,
  removeMixtapeItemsByFilePath,
  reorderMixtapeItems
} from '../mixtapeDb'
import { queueMixtapeWaveforms } from '../services/mixtapeWaveformQueue'
import { queueMixtapeRawWaveforms } from '../services/mixtapeRawWaveformQueue'
import { cleanupMixtapeWaveformCache } from '../services/mixtapeWaveformMaintenance'

const resolveKeyAnalysisWorkerPath = () => path.join(__dirname, 'workers', 'keyAnalysisWorker.js')

const analyzeMixtapeBpmBatch = async (filePaths: string[]) => {
  const unique = Array.from(
    new Set(filePaths.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean))
  )
  if (unique.length === 0) {
    return { results: [], unresolved: [] as string[] }
  }

  const workerPath = resolveKeyAnalysisWorkerPath()
  const maxWorkers = Math.max(1, Math.min(2, os.cpus().length, unique.length))
  const workers: Worker[] = []
  const busy = new Map<Worker, number>()
  const jobMap = new Map<number, string>()
  const unresolved = new Set<string>(unique)
  const results: Array<{ filePath: string; bpm: number }> = []
  let cursor = 0
  let jobId = 0
  let finished = false
  const timeoutMs = Math.min(30 * 60 * 1000, Math.max(60_000, unique.length * 12_000))

  return await new Promise<{
    results: Array<{ filePath: string; bpm: number }>
    unresolved: string[]
  }>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null

    const cleanup = () => {
      for (const worker of workers) {
        try {
          worker.removeAllListeners()
        } catch {}
        try {
          void worker.terminate()
        } catch {}
      }
      workers.length = 0
      busy.clear()
      jobMap.clear()
    }

    const finish = () => {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      cleanup()
      resolve({ results, unresolved: Array.from(unresolved) })
    }

    const assignNext = (worker: Worker) => {
      if (cursor >= unique.length) {
        if (busy.size === 0) finish()
        return
      }
      const filePath = unique[cursor]
      cursor += 1
      const nextJobId = (jobId += 1)
      busy.set(worker, nextJobId)
      jobMap.set(nextJobId, filePath)
      worker.postMessage({
        jobId: nextJobId,
        filePath,
        fastAnalysis: false,
        needsKey: false,
        needsBpm: true,
        needsWaveform: false
      })
    }

    const handleMessage = (worker: Worker, payload: any) => {
      const currentJobId = busy.get(worker)
      if (currentJobId !== undefined) {
        busy.delete(worker)
      }
      const filePath = jobMap.get(payload?.jobId ?? currentJobId ?? -1)
      if (filePath) {
        jobMap.delete(payload?.jobId ?? currentJobId ?? -1)
        const bpmValue = payload?.result?.bpm
        if (typeof bpmValue === 'number' && Number.isFinite(bpmValue) && bpmValue > 0) {
          results.push({ filePath, bpm: bpmValue })
          unresolved.delete(filePath)
        }
      }
      assignNext(worker)
    }

    const handleFailure = (worker: Worker) => {
      const currentJobId = busy.get(worker)
      if (currentJobId !== undefined) {
        busy.delete(worker)
        const filePath = jobMap.get(currentJobId)
        if (filePath) {
          jobMap.delete(currentJobId)
          unresolved.add(filePath)
        }
      }
      try {
        worker.removeAllListeners()
      } catch {}
      try {
        void worker.terminate()
      } catch {}
      const idx = workers.indexOf(worker)
      if (idx !== -1) workers.splice(idx, 1)
      if (!finished && cursor < unique.length) {
        const replacement = new Worker(workerPath)
        workers.push(replacement)
        bindWorker(replacement)
        assignNext(replacement)
      } else if (busy.size === 0 && cursor >= unique.length) {
        finish()
      }
    }

    const bindWorker = (worker: Worker) => {
      worker.on('message', (payload) => handleMessage(worker, payload))
      worker.on('error', () => handleFailure(worker))
      worker.on('exit', (code) => {
        if (code !== 0) {
          handleFailure(worker)
        }
      })
    }

    for (let i = 0; i < maxWorkers; i += 1) {
      const worker = new Worker(workerPath)
      workers.push(worker)
      bindWorker(worker)
    }

    timer = setTimeout(() => finish(), timeoutMs)
    for (const worker of workers) {
      assignNext(worker)
    }
  })
}

export function registerMixtapeHandlers() {
  ipcMain.on('mixtape:open', (_e, payload: MixtapeWindowPayload) => {
    mixtapeWindow.open(payload || {})
  })

  ipcMain.on('mixtapeWindow-open-dialog', (_e, key: string) => {
    if (!key) return
    try {
      mainWindow.instance?.webContents.send('openDialogFromTray', key)
    } catch {}
  })

  ipcMain.handle('mixtape:list', async (_e, payload: { playlistId?: string }) => {
    const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
    return { items: listMixtapeItems(playlistId) }
  })

  ipcMain.handle(
    'mixtape:append',
    async (
      _e,
      payload: {
        playlistId?: string
        items?: Array<{
          filePath: string
          originPlaylistUuid?: string | null
          originPathSnapshot?: string | null
          info?: Record<string, any> | null
        }>
      }
    ) => {
      const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
      const items = Array.isArray(payload?.items) ? payload.items : []
      const result = appendMixtapeItems(playlistId, items)
      const filePaths = Array.from(
        new Set(items.map((item) => item?.filePath).filter((value): value is string => !!value))
      )
      if (filePaths.length > 0) {
        queueMixtapeWaveforms(filePaths)
        queueMixtapeRawWaveforms(filePaths)
      }
      return result
    }
  )

  ipcMain.handle(
    'mixtape:remove',
    async (_e, payload: { playlistId?: string; filePaths?: string[]; itemIds?: string[] }) => {
      const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
      const itemIds = Array.isArray(payload?.itemIds) ? payload.itemIds : []
      const filePaths = Array.isArray(payload?.filePaths) ? payload.filePaths : []
      if (itemIds.length > 0) {
        const removedPaths = listMixtapeFilePathsByItemIds(playlistId, itemIds)
        const result = removeMixtapeItemsById(playlistId, itemIds)
        await cleanupMixtapeWaveformCache(removedPaths)
        return result
      }
      const result = removeMixtapeItemsByFilePath(playlistId, filePaths)
      await cleanupMixtapeWaveformCache(filePaths)
      return result
    }
  )

  ipcMain.handle(
    'mixtape:reorder',
    async (_e, payload: { playlistId?: string; orderedIds?: string[] }) => {
      const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
      const orderedIds = Array.isArray(payload?.orderedIds) ? payload.orderedIds : []
      return reorderMixtapeItems(playlistId, orderedIds)
    }
  )

  ipcMain.handle('mixtape:analyze-bpm', async (_e, payload: { filePaths?: string[] }) => {
    const input = Array.isArray(payload?.filePaths) ? payload.filePaths : []
    return analyzeMixtapeBpmBatch(input)
  })
}
