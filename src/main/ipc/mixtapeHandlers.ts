import { ipcMain } from 'electron'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import mixtapeWindow, {
  isMixtapeWindowOpenByPlaylistId,
  type MixtapeWindowPayload
} from '../window/mixtapeWindow'
import mainWindow from '../window/mainWindow'
import { log } from '../log'
import {
  appendMixtapeItems,
  listMixtapeItems,
  listMixtapeFilePathsByItemIds,
  removeMixtapeItemsById,
  removeMixtapeItemsByFilePath,
  reorderMixtapeItems,
  updateMixtapeItemFilePathsById,
  upsertMixtapeItemBpmByFilePath,
  upsertMixtapeItemGridByFilePath,
  upsertMixtapeItemGainEnvelopeById
} from '../mixtapeDb'
import { queueMixtapeWaveforms } from '../services/mixtapeWaveformQueue'
import { queueMixtapeRawWaveforms } from '../services/mixtapeRawWaveformQueue'
import { queueMixtapeWaveformHires } from '../services/mixtapeWaveformHiresQueue'
import { cleanupMixtapeWaveformCache } from '../services/mixtapeWaveformMaintenance'
import { resolveMissingMixtapeFilePath } from '../recycleBinService'

const resolveKeyAnalysisWorkerPath = () => path.join(__dirname, 'workers', 'keyAnalysisWorker.js')

const analyzeMixtapeBpmBatch = async (filePaths: string[]) => {
  const unique = Array.from(
    new Set(filePaths.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean))
  )
  if (unique.length === 0) {
    return {
      results: [],
      unresolved: [] as string[],
      unresolvedDetails: [] as Array<{ filePath: string; reason: string }>
    }
  }

  const workerPath = resolveKeyAnalysisWorkerPath()
  if (!fs.existsSync(workerPath)) {
    log.error('[mixtape] BPM worker entry not found', { workerPath, requested: unique.length })
    return {
      results: [],
      unresolved: unique,
      unresolvedDetails: unique.map((filePath) => ({ filePath, reason: 'worker entry not found' }))
    }
  }

  const startedAt = Date.now()
  log.info('[mixtape] BPM analyze start', {
    requested: filePaths.length,
    unique: unique.length,
    sample: unique.slice(0, 3).map((item) => path.basename(item))
  })

  const maxWorkers = Math.max(1, Math.min(2, os.cpus().length, unique.length))
  const workers: Worker[] = []
  const busy = new Map<Worker, number>()
  const jobMap = new Map<number, string>()
  const unresolved = new Set<string>(unique)
  const results: Array<{ filePath: string; bpm: number; firstBeatMs: number }> = []
  const unresolvedReasons = new Map<string, string>()
  let cursor = 0
  let jobId = 0
  let finished = false
  const timeoutMs = Math.min(30 * 60 * 1000, Math.max(60_000, unique.length * 12_000))

  return await new Promise<{
    results: Array<{ filePath: string; bpm: number; firstBeatMs: number }>
    unresolved: string[]
    unresolvedDetails: Array<{ filePath: string; reason: string }>
  }>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null

    const markUnresolvedReason = (filePath: string, reason: string) => {
      if (!filePath || unresolvedReasons.has(filePath)) return
      unresolvedReasons.set(filePath, reason || 'unknown error')
    }

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
      const unresolvedList = Array.from(unresolved)
      if (unresolvedList.length > 0) {
        const sample = unresolvedList.slice(0, 5).map((filePath) => ({
          file: path.basename(filePath),
          reason: unresolvedReasons.get(filePath) || 'unknown error'
        }))
        log.warn('[mixtape] BPM analyze finished with unresolved tracks', {
          requested: unique.length,
          resolved: results.length,
          unresolved: unresolvedList.length,
          sample
        })
      }
      const unresolvedDetails = unresolvedList.map((filePath) => ({
        filePath,
        reason: unresolvedReasons.get(filePath) || 'unknown error'
      }))
      log.info('[mixtape] BPM analyze finish', {
        requested: unique.length,
        resolved: results.length,
        unresolved: unresolvedList.length,
        elapsedMs: Date.now() - startedAt
      })
      resolve({ results, unresolved: unresolvedList, unresolvedDetails })
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
      const resolvedJobId =
        typeof payload?.jobId === 'number' ? payload.jobId : (currentJobId ?? -1)
      const filePath = jobMap.get(resolvedJobId)
      if (filePath) {
        jobMap.delete(resolvedJobId)
        const bpmValue = payload?.result?.bpm
        if (typeof bpmValue === 'number' && Number.isFinite(bpmValue) && bpmValue > 0) {
          const rawFirstBeatMs = Number(payload?.result?.firstBeatMs)
          const firstBeatMs =
            Number.isFinite(rawFirstBeatMs) && rawFirstBeatMs >= 0
              ? Number(rawFirstBeatMs.toFixed(3))
              : 0
          results.push({ filePath, bpm: bpmValue, firstBeatMs })
          unresolved.delete(filePath)
        } else {
          const reason =
            (typeof payload?.error === 'string' && payload.error) ||
            (typeof payload?.result?.bpmError === 'string' && payload.result.bpmError) ||
            `invalid bpm value: ${String(bpmValue)}`
          markUnresolvedReason(filePath, reason)
        }
      }
      assignNext(worker)
    }

    const handleFailure = (worker: Worker, error?: unknown) => {
      const currentJobId = busy.get(worker)
      if (currentJobId !== undefined) {
        busy.delete(worker)
        const filePath = jobMap.get(currentJobId)
        if (filePath) {
          jobMap.delete(currentJobId)
          unresolved.add(filePath)
          markUnresolvedReason(
            filePath,
            error instanceof Error ? error.message : String(error || 'worker failure')
          )
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
      log.warn('[mixtape] BPM worker failed', {
        error: error instanceof Error ? error.message : String(error || 'worker failure'),
        busyWorkers: busy.size,
        pendingJobs: unique.length - cursor
      })
      if (!finished && cursor < unique.length) {
        const replacement = createWorker()
        if (replacement) {
          assignNext(replacement)
        } else if (busy.size === 0) {
          finish()
        }
      } else if (busy.size === 0 && cursor >= unique.length) {
        finish()
      }
    }

    const bindWorker = (worker: Worker) => {
      worker.on('message', (payload) => handleMessage(worker, payload))
      worker.on('error', (error) => handleFailure(worker, error))
      worker.on('exit', (code) => {
        if (code !== 0) {
          handleFailure(worker, new Error(`worker exited with code ${code}`))
        }
      })
    }

    const createWorker = () => {
      try {
        const worker = new Worker(workerPath)
        workers.push(worker)
        bindWorker(worker)
        return worker
      } catch (error) {
        log.error('[mixtape] BPM worker spawn failed', {
          workerPath,
          error: error instanceof Error ? error.message : String(error)
        })
        return null
      }
    }

    for (let i = 0; i < maxWorkers; i += 1) {
      const worker = createWorker()
      if (!worker) break
    }

    if (workers.length === 0) {
      log.error('[mixtape] BPM analyze aborted because no worker can be started', {
        workerPath,
        requested: unique.length
      })
      finish()
      return
    }

    timer = setTimeout(() => finish(), timeoutMs)
    for (const worker of workers) {
      assignNext(worker)
    }
  })
}

type MixtapeMissingRecovery = {
  recovered: Array<{
    itemId: string
    fromPath: string
    toPath: string
    source: 'recycle_bin' | 'mixtape_vault'
  }>
  removedPaths: string[]
}

const normalizeUniquePaths = (values: unknown[]): string[] => {
  if (!Array.isArray(values)) return []
  return Array.from(
    new Set(
      values
        .filter((value) => typeof value === 'string')
        .map((value) => String(value).trim())
        .filter(Boolean)
    )
  )
}

const reconcileMixtapeMissingFiles = async (
  playlistId: string
): Promise<{ items: ReturnType<typeof listMixtapeItems>; recovery: MixtapeMissingRecovery }> => {
  const emptyRecovery: MixtapeMissingRecovery = { recovered: [], removedPaths: [] }
  if (!playlistId) return { items: [], recovery: emptyRecovery }

  const items = listMixtapeItems(playlistId)
  if (!items.length) return { items, recovery: emptyRecovery }

  const updates: Array<{ id: string; filePath: string }> = []
  const stalePaths: string[] = []
  const removeIds: string[] = []

  for (const item of items) {
    const itemId = typeof item?.id === 'string' ? item.id.trim() : ''
    const filePath = typeof item?.filePath === 'string' ? item.filePath.trim() : ''
    if (!itemId || !filePath) {
      if (itemId) removeIds.push(itemId)
      if (filePath) {
        emptyRecovery.removedPaths.push(filePath)
        stalePaths.push(filePath)
      }
      continue
    }
    if (fs.existsSync(filePath)) continue
    const resolved = await resolveMissingMixtapeFilePath(filePath)
    if (resolved?.resolvedPath) {
      updates.push({ id: itemId, filePath: resolved.resolvedPath })
      stalePaths.push(filePath)
      emptyRecovery.recovered.push({
        itemId,
        fromPath: filePath,
        toPath: resolved.resolvedPath,
        source: resolved.source
      })
      continue
    }
    removeIds.push(itemId)
    emptyRecovery.removedPaths.push(filePath)
    stalePaths.push(filePath)
  }

  if (updates.length > 0) {
    updateMixtapeItemFilePathsById(updates)
    const resolvedPaths = normalizeUniquePaths(updates.map((item) => item.filePath))
    if (resolvedPaths.length > 0) {
      queueMixtapeWaveforms(resolvedPaths)
      queueMixtapeRawWaveforms(resolvedPaths)
      queueMixtapeWaveformHires(resolvedPaths)
    }
  }
  if (removeIds.length > 0) {
    removeMixtapeItemsById(playlistId, removeIds)
  }
  if (stalePaths.length > 0) {
    await cleanupMixtapeWaveformCache(normalizeUniquePaths(stalePaths))
  }
  if (updates.length === 0 && removeIds.length === 0) {
    return { items, recovery: emptyRecovery }
  }

  const refreshed = listMixtapeItems(playlistId)
  return {
    items: refreshed,
    recovery: {
      recovered: emptyRecovery.recovered,
      removedPaths: normalizeUniquePaths(emptyRecovery.removedPaths)
    }
  }
}

export function registerMixtapeHandlers() {
  ipcMain.on('mixtape:open', (_e, payload: MixtapeWindowPayload) => {
    mixtapeWindow.open(payload || {})
  })

  ipcMain.handle('mixtape:is-window-open-by-playlist-id', (_e, playlistId?: string) => {
    return isMixtapeWindowOpenByPlaylistId(typeof playlistId === 'string' ? playlistId : '')
  })

  ipcMain.on('mixtapeWindow-open-dialog', (_e, key: string) => {
    if (!key) return
    try {
      mainWindow.instance?.webContents.send('openDialogFromTray', key)
    } catch {}
  })

  ipcMain.handle('mixtape:list', async (_e, payload: { playlistId?: string }) => {
    const playlistId = typeof payload?.playlistId === 'string' ? payload.playlistId : ''
    const { items, recovery } = await reconcileMixtapeMissingFiles(playlistId)
    return { items, recovery }
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
        queueMixtapeWaveformHires(filePaths)
        // 预分析 BPM（后台，不阻塞返回）
        void analyzeMixtapeBpmBatch(filePaths)
          .then((bpmResult) => {
            if (bpmResult.results.length > 0) {
              upsertMixtapeItemBpmByFilePath(bpmResult.results)
              try {
                mixtapeWindow.broadcast?.('mixtape-bpm-batch-ready', {
                  results: bpmResult.results
                })
              } catch {}
            }
          })
          .catch(() => {})
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
    try {
      const result = await analyzeMixtapeBpmBatch(input)
      if (result.results.length > 0) {
        upsertMixtapeItemBpmByFilePath(result.results)
      }
      return result
    } catch (error) {
      log.error('[mixtape] BPM analyze invoke failed', {
        requested: input.length,
        error: error instanceof Error ? error.message : String(error)
      })
      return {
        results: [],
        unresolved: input,
        unresolvedDetails: input.map((filePath) => ({ filePath, reason: 'invoke failed' }))
      }
    }
  })

  ipcMain.handle(
    'mixtape:update-grid-definition',
    async (
      _e,
      payload: { filePath?: string; barBeatOffset?: number; firstBeatMs?: number; bpm?: number }
    ) => {
      const filePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
      const rawOffset = Number(payload?.barBeatOffset)
      const rawFirstBeatMs = Number(payload?.firstBeatMs)
      const rawBpm = Number(payload?.bpm)
      const hasOffset = Number.isFinite(rawOffset)
      const hasFirstBeatMs = Number.isFinite(rawFirstBeatMs)
      const hasBpm = Number.isFinite(rawBpm) && rawBpm > 0
      if (!filePath || (!hasOffset && !hasFirstBeatMs && !hasBpm)) {
        return { updated: 0 }
      }
      return upsertMixtapeItemGridByFilePath([
        {
          filePath,
          barBeatOffset: hasOffset ? rawOffset : 0,
          firstBeatMs: hasFirstBeatMs ? rawFirstBeatMs : undefined,
          bpm: hasBpm ? rawBpm : undefined
        }
      ])
    }
  )

  ipcMain.handle(
    'mixtape:update-gain-envelope',
    async (
      _e,
      payload?: {
        entries?: Array<{ itemId?: string; gainEnvelope?: Array<{ sec?: number; gain?: number }> }>
      }
    ) => {
      const entries = Array.isArray(payload?.entries) ? payload.entries : []
      return upsertMixtapeItemGainEnvelopeById(
        entries.map((item) => ({
          itemId: typeof item?.itemId === 'string' ? item.itemId : '',
          gainEnvelope: Array.isArray(item?.gainEnvelope)
            ? item.gainEnvelope
                .map((point) => ({
                  sec: Number(point?.sec),
                  gain: Number(point?.gain)
                }))
                .filter(
                  (point) =>
                    Number.isFinite(point.sec) &&
                    point.sec >= 0 &&
                    Number.isFinite(point.gain) &&
                    point.gain > 0
                )
            : []
        }))
      )
    }
  )
}
