import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { log } from '../log'
import {
  listMixtapeItems,
  removeMixtapeItemsById,
  updateMixtapeItemFilePathsById,
  type MixtapeItemRecord
} from '../mixtapeDb'
import { queueMixtapeWaveforms } from '../services/mixtapeWaveformQueue'
import { queueMixtapeRawWaveforms } from '../services/mixtapeRawWaveformQueue'
import { queueMixtapeWaveformHires } from '../services/mixtapeWaveformHiresQueue'
import { cleanupMixtapeWaveformCache } from '../services/mixtapeWaveformMaintenance'
import { resolveMissingMixtapeFilePath } from '../recycleBinService'

const resolveKeyAnalysisWorkerPath = () => path.join(__dirname, 'workers', 'keyAnalysisWorker.js')

export type MixtapeBpmAnalyzeResult = {
  results: Array<{ filePath: string; bpm: number; firstBeatMs: number }>
  unresolved: string[]
  unresolvedDetails: Array<{ filePath: string; reason: string }>
}

export type MixtapeMissingRecovery = {
  recovered: Array<{
    itemId: string
    fromPath: string
    toPath: string
    source: 'recycle_bin' | 'mixtape_vault'
  }>
  removedPaths: string[]
}

const inFlightBpmBatchMap = new Map<string, Promise<MixtapeBpmAnalyzeResult>>()

const normalizePathForBatchKey = (value: string): string => {
  const normalized = String(value || '').trim()
  if (!normalized) return ''
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const buildBpmBatchInput = (filePaths: string[]): string[] => {
  const set = new Set<string>()
  for (const item of filePaths) {
    const normalized = typeof item === 'string' ? item.trim() : ''
    if (!normalized) continue
    set.add(normalized)
  }
  return Array.from(set)
}

const buildBpmBatchKey = (filePaths: string[]): string =>
  filePaths
    .map((item) => normalizePathForBatchKey(item))
    .filter(Boolean)
    .sort()
    .join('\n')

type MixtapeBpmAnalyzeRunOptions = {
  fastAnalysis?: boolean
  stage?: 'primary' | 'retry-fast'
  attempt?: number
  totalAttempts?: number
}

const BPM_ANALYZE_JOB_TIMEOUT_NORMAL_MS = 3 * 60 * 1000
const BPM_ANALYZE_JOB_TIMEOUT_FAST_MS = 2 * 60 * 1000
const resolveBpmJobTimeoutMs = (fastAnalysis: boolean) =>
  fastAnalysis ? BPM_ANALYZE_JOB_TIMEOUT_FAST_MS : BPM_ANALYZE_JOB_TIMEOUT_NORMAL_MS

const analyzeMixtapeBpmBatch = async (
  filePaths: string[],
  options: MixtapeBpmAnalyzeRunOptions = {}
) => {
  const unique = buildBpmBatchInput(filePaths)
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

  const fastAnalysis = options.fastAnalysis === true
  const stage = options.stage || (fastAnalysis ? 'retry-fast' : 'primary')
  const jobTimeoutMs = resolveBpmJobTimeoutMs(fastAnalysis)

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

  return await new Promise<MixtapeBpmAnalyzeResult>((resolve) => {
    const workerJobTimerMap = new Map<Worker, ReturnType<typeof setTimeout>>()

    const markUnresolvedReason = (filePath: string, reason: string) => {
      if (!filePath || unresolvedReasons.has(filePath)) return
      unresolvedReasons.set(filePath, reason || 'unknown error')
    }

    const clearWorkerTimer = (worker: Worker) => {
      const timer = workerJobTimerMap.get(worker)
      if (!timer) return
      clearTimeout(timer)
      workerJobTimerMap.delete(worker)
    }

    function handleFailure(worker: Worker, error?: unknown) {
      if (!workers.includes(worker) && !busy.has(worker)) return
      clearWorkerTimer(worker)
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

    const setWorkerTimeout = (worker: Worker, currentJobId: number, filePath: string) => {
      clearWorkerTimer(worker)
      const timer = setTimeout(() => {
        if (finished) return
        const activeJobId = busy.get(worker)
        if (activeJobId !== currentJobId) return
        markUnresolvedReason(filePath, 'analysis timeout')
        handleFailure(worker, new Error(`analysis timeout (${jobTimeoutMs}ms)`))
      }, jobTimeoutMs)
      workerJobTimerMap.set(worker, timer)
    }

    const cleanup = () => {
      for (const timer of workerJobTimerMap.values()) {
        clearTimeout(timer)
      }
      workerJobTimerMap.clear()
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

      cleanup()
      const unresolvedList = Array.from(unresolved)
      const unresolvedDetails = unresolvedList.map((filePath) => ({
        filePath,
        reason: unresolvedReasons.get(filePath) || 'unknown error'
      }))
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
      setWorkerTimeout(worker, nextJobId, filePath)
      worker.postMessage({
        jobId: nextJobId,
        filePath,
        fastAnalysis,
        needsKey: false,
        needsBpm: true,
        needsWaveform: false
      })
    }

    const handleMessage = (worker: Worker, payload: any) => {
      const hasProgressPayload =
        payload &&
        typeof payload === 'object' &&
        Object.prototype.hasOwnProperty.call(payload, 'progress')
      if (hasProgressPayload) return

      const hasFinalPayload =
        payload &&
        typeof payload === 'object' &&
        (Object.prototype.hasOwnProperty.call(payload, 'result') ||
          Object.prototype.hasOwnProperty.call(payload, 'error'))
      if (!hasFinalPayload) return

      clearWorkerTimer(worker)
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

    const bindWorker = (worker: Worker) => {
      worker.on('message', (payload) => handleMessage(worker, payload))
      worker.on('error', (error) => handleFailure(worker, error))
      worker.on('exit', (code) => {
        const activeJobId = busy.get(worker)
        if (code !== 0) {
          handleFailure(worker, new Error(`worker exited with code ${code}`))
          return
        }
        if (activeJobId !== undefined) {
          handleFailure(worker, new Error('worker exited before returning analysis result'))
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

    for (let index = 0; index < maxWorkers; index += 1) {
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

    for (const worker of workers) {
      assignNext(worker)
    }
  })
}

export const analyzeMixtapeBpmBatchShared = async (filePaths: string[]) => {
  const input = buildBpmBatchInput(filePaths)
  if (input.length === 0) {
    return {
      results: [],
      unresolved: [],
      unresolvedDetails: []
    } satisfies MixtapeBpmAnalyzeResult
  }

  const key = buildBpmBatchKey(input)
  const existing = inFlightBpmBatchMap.get(key)
  if (existing) return existing

  const task = (async (): Promise<MixtapeBpmAnalyzeResult> => {
    const resultMap = new Map<
      string,
      {
        filePath: string
        bpm: number
        firstBeatMs: number
      }
    >()
    const unresolvedReasonMap = new Map<string, string>()
    const plans: Array<{ stage: 'primary' | 'retry-fast'; fastAnalysis: boolean }> = [
      { stage: 'primary', fastAnalysis: false },
      { stage: 'retry-fast', fastAnalysis: true }
    ]
    let pending = input

    for (let index = 0; index < plans.length && pending.length > 0; index += 1) {
      const plan = plans[index]!
      const runResult = await analyzeMixtapeBpmBatch(pending, {
        stage: plan.stage,
        fastAnalysis: plan.fastAnalysis,
        attempt: index + 1,
        totalAttempts: plans.length
      })

      for (const item of runResult.results) {
        const normalizedPath = normalizePathForBatchKey(item.filePath)
        if (!normalizedPath) continue
        resultMap.set(normalizedPath, {
          filePath: item.filePath,
          bpm: item.bpm,
          firstBeatMs: Number(item.firstBeatMs.toFixed(3))
        })
        unresolvedReasonMap.delete(normalizedPath)
      }

      const retryCandidates: string[] = []
      for (const detail of runResult.unresolvedDetails) {
        const normalizedPath = normalizePathForBatchKey(detail.filePath)
        if (!normalizedPath || resultMap.has(normalizedPath)) continue
        unresolvedReasonMap.set(normalizedPath, detail.reason || 'unknown error')
        retryCandidates.push(detail.filePath)
      }
      pending = buildBpmBatchInput(retryCandidates)
    }

    const unresolved = pending
    const unresolvedDetails = unresolved.map((filePath) => {
      const normalizedPath = normalizePathForBatchKey(filePath)
      return {
        filePath,
        reason: unresolvedReasonMap.get(normalizedPath) || 'unknown error'
      }
    })

    return {
      results: Array.from(resultMap.values()),
      unresolved,
      unresolvedDetails
    }
  })().finally(() => {
    if (inFlightBpmBatchMap.get(key) === task) {
      inFlightBpmBatchMap.delete(key)
    }
  })

  inFlightBpmBatchMap.set(key, task)
  return task
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

export const reconcileMixtapeMissingFiles = async (
  playlistId: string
): Promise<{ items: MixtapeItemRecord[]; recovery: MixtapeMissingRecovery }> => {
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
