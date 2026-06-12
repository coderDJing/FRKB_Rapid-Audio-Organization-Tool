import path from 'node:path'
import { probeAudioFile } from './audioProbe'
import { log } from '../../log'
import {
  KEY_ANALYSIS_FAILURE_BASE_COOLDOWN_MS,
  KEY_ANALYSIS_FAILURE_MAX_COOLDOWN_MS,
  KEY_ANALYSIS_FAILURE_RECORD_TTL_MS,
  KEY_ANALYSIS_FAILURE_SKIP_THRESHOLD,
  KEY_ANALYSIS_JOB_TIMEOUT_MS,
  KEY_ANALYSIS_TIMEOUT_PROBE_MIN_FILE_SIZE_BYTES,
  KEY_ANALYSIS_TIMEOUT_PROBE_TTL_MS,
  type KeyAnalysisAudioProbe,
  type KeyAnalysisFailureReason,
  type KeyAnalysisFailureRecord,
  type KeyAnalysisJob
} from './types'

export type KeyAnalysisFailureTrackerDeps = {
  failedByPath: Map<string, KeyAnalysisFailureRecord>
  probeCache: Map<
    string,
    {
      size: number
      mtimeMs: number
      probedAt: number
      probe: KeyAnalysisAudioProbe
    }
  >
  failureProbeInFlight: Set<string>
}

export const createKeyAnalysisFailureTracker = (deps: KeyAnalysisFailureTrackerDeps) => {
  const getJobFileVersion = (job: KeyAnalysisJob): { size: number; mtimeMs: number } => {
    const size = Number.isFinite(job.fileSize) ? Number(job.fileSize) : -1
    const mtimeMs = Number.isFinite(job.fileMtimeMs) ? Number(job.fileMtimeMs) : -1
    return { size, mtimeMs }
  }

  const isSameFileVersion = (
    left: { size: number; mtimeMs: number },
    right: { size: number; mtimeMs: number }
  ): boolean => {
    return left.size === right.size && Math.abs(left.mtimeMs - right.mtimeMs) < 1
  }

  const computeFailureCooldownMs = (failCount: number): number => {
    if (failCount < KEY_ANALYSIS_FAILURE_SKIP_THRESHOLD) return 0
    const exp = failCount - KEY_ANALYSIS_FAILURE_SKIP_THRESHOLD
    return Math.min(
      KEY_ANALYSIS_FAILURE_BASE_COOLDOWN_MS * 2 ** exp,
      KEY_ANALYSIS_FAILURE_MAX_COOLDOWN_MS
    )
  }

  const inferFailureCause = (job: KeyAnalysisJob, reason: KeyAnalysisFailureReason): string => {
    const stage = job.trace?.lastStage
    if (reason === 'timeout') {
      if (stage === 'decode-start') return 'decode-stage-timeout'
      if (stage === 'analyze-start') {
        const decodeMs = Number(job.trace?.decodeMs || 0)
        if (decodeMs >= KEY_ANALYSIS_JOB_TIMEOUT_MS * 0.75) {
          return 'decode-consumed-time-budget'
        }
        return 'analyze-stage-timeout'
      }
      if (stage === 'waveform-start') return 'waveform-stage-timeout'
      return 'job-timeout'
    }
    if (reason === 'worker-exit') return 'worker-process-exit'
    return 'worker-runtime-error'
  }

  const cleanupStaleFailures = () => {
    if (deps.failedByPath.size === 0) return
    const now = Date.now()
    for (const [normalizedPath, record] of deps.failedByPath.entries()) {
      if (now - record.lastFailedAt <= KEY_ANALYSIS_FAILURE_RECORD_TTL_MS) continue
      deps.failedByPath.delete(normalizedPath)
    }
  }

  const scheduleFailureProbe = (job: KeyAnalysisJob, reason: KeyAnalysisFailureReason) => {
    const normalizedPath = job.normalizedPath
    if (!normalizedPath || deps.failureProbeInFlight.has(normalizedPath)) return
    deps.failureProbeInFlight.add(normalizedPath)
    void (async () => {
      try {
        const probe = await probeAudioFile(job.filePath)
        const { size, mtimeMs } = getJobFileVersion(job)
        deps.probeCache.set(normalizedPath, { size, mtimeMs, probe, probedAt: Date.now() })
        job.probe = probe
        const current = deps.failedByPath.get(normalizedPath)
        if (current) {
          current.lastProbe = probe
        }
        log.error('[闲时分析] 失败文件诊断', {
          filePath: job.filePath,
          fileName: path.basename(job.filePath),
          source: job.source,
          reason,
          stage: job.trace?.lastStage || 'unknown',
          decodeBackend: job.trace?.decodeBackend || 'unknown',
          inferredCause: current?.inferredCause || inferFailureCause(job, reason),
          failCount: current?.failCount,
          decodeMs: job.trace?.decodeMs,
          analyzeMs: job.trace?.analyzeMs,
          waveformMs: job.trace?.waveformMs,
          partialKeyPersisted: job.trace?.partialKeyPersisted === true,
          partialBpmPersisted: job.trace?.partialBpmPersisted === true,
          ...probe
        })
      } catch (error) {
        log.error('[闲时分析] 失败文件诊断异常', {
          filePath: job.filePath,
          error: error instanceof Error ? error.message : String(error)
        })
      } finally {
        deps.failureProbeInFlight.delete(normalizedPath)
      }
    })()
  }

  const recordJobFailure = (
    job: KeyAnalysisJob,
    reason: KeyAnalysisFailureReason,
    detail?: string
  ) => {
    const normalizedPath = job.normalizedPath
    const now = Date.now()
    const { size, mtimeMs } = getJobFileVersion(job)
    const existing = deps.failedByPath.get(normalizedPath)
    const sameFileVersion = existing && isSameFileVersion(existing, { size, mtimeMs })
    const failCount = sameFileVersion ? existing.failCount + 1 : 1
    const cooldownMs = computeFailureCooldownMs(failCount)
    const nextRetryAt = now + cooldownMs
    const inferredCause = inferFailureCause(job, reason)
    const record: KeyAnalysisFailureRecord = {
      size,
      mtimeMs,
      failCount,
      firstFailedAt: sameFileVersion ? existing.firstFailedAt : now,
      lastFailedAt: now,
      nextRetryAt,
      lastReason: reason,
      lastStage: job.trace?.lastStage,
      lastDetail: detail || job.trace?.detail,
      inferredCause,
      lastProbe: existing?.lastProbe
    }
    deps.failedByPath.set(normalizedPath, record)

    if (cooldownMs === 0) {
      log.error('[闲时分析] 任务失败（未进入冷却阈值）', {
        filePath: job.filePath,
        fileName: path.basename(job.filePath),
        source: job.source,
        reason,
        inferredCause,
        stage: job.trace?.lastStage || 'unknown',
        decodeBackend: job.trace?.decodeBackend || 'unknown',
        failCount,
        partialKeyPersisted: job.trace?.partialKeyPersisted === true,
        partialBpmPersisted: job.trace?.partialBpmPersisted === true,
        detail: record.lastDetail
      })
    }

    if (cooldownMs > 0) {
      log.error('[闲时分析] 任务失败进入冷却期，后续将暂时跳过', {
        filePath: job.filePath,
        fileName: path.basename(job.filePath),
        source: job.source,
        reason,
        inferredCause,
        stage: job.trace?.lastStage || 'unknown',
        decodeBackend: job.trace?.decodeBackend || 'unknown',
        failCount,
        cooldownMs,
        nextRetryAt: new Date(nextRetryAt).toISOString(),
        partialKeyPersisted: job.trace?.partialKeyPersisted === true,
        partialBpmPersisted: job.trace?.partialBpmPersisted === true,
        detail: record.lastDetail
      })
    }
    scheduleFailureProbe(job, reason)
  }

  const clearJobFailure = (job: KeyAnalysisJob) => {
    if (!deps.failedByPath.has(job.normalizedPath)) return
    deps.failedByPath.delete(job.normalizedPath)
  }

  const getFailureCooldownRecord = (job: KeyAnalysisJob): KeyAnalysisFailureRecord | null => {
    if (job.priority === 'high') return null
    if (job.category === 'manual-batch') return null
    const record = deps.failedByPath.get(job.normalizedPath)
    if (!record) return null
    const sameFileVersion = isSameFileVersion(record, getJobFileVersion(job))
    if (!sameFileVersion) {
      deps.failedByPath.delete(job.normalizedPath)
      return null
    }
    if (record.nextRetryAt <= Date.now()) return null
    return record
  }

  const cleanupStaleProbeCache = () => {
    if (deps.probeCache.size === 0) return
    const now = Date.now()
    for (const [normalizedPath, entry] of deps.probeCache.entries()) {
      if (now - entry.probedAt <= KEY_ANALYSIS_TIMEOUT_PROBE_TTL_MS) continue
      deps.probeCache.delete(normalizedPath)
    }
  }

  const getProbeForJob = (job: KeyAnalysisJob): KeyAnalysisAudioProbe | undefined => {
    const normalizedPath = job.normalizedPath
    if (!normalizedPath) return undefined
    const fileVersion = getJobFileVersion(job)
    const cache = deps.probeCache.get(normalizedPath)
    if (cache && isSameFileVersion(cache, fileVersion)) {
      if (Date.now() - cache.probedAt <= KEY_ANALYSIS_TIMEOUT_PROBE_TTL_MS) {
        return cache.probe
      }
      deps.probeCache.delete(normalizedPath)
    }

    const failed = deps.failedByPath.get(normalizedPath)
    if (
      failed &&
      isSameFileVersion(failed, fileVersion) &&
      failed.lastProbe &&
      Date.now() - failed.lastFailedAt <= KEY_ANALYSIS_TIMEOUT_PROBE_TTL_MS
    ) {
      deps.probeCache.set(normalizedPath, {
        size: failed.size,
        mtimeMs: failed.mtimeMs,
        probe: failed.lastProbe,
        probedAt: failed.lastFailedAt
      })
      return failed.lastProbe
    }
    return undefined
  }

  const shouldProbeForTimeoutBudget = (job: KeyAnalysisJob): boolean => {
    if (job.probe) return false
    if (getProbeForJob(job)) return false
    const hasFailureRecord = deps.failedByPath.has(job.normalizedPath)
    if (hasFailureRecord) return true
    const { size } = getJobFileVersion(job)
    return size >= KEY_ANALYSIS_TIMEOUT_PROBE_MIN_FILE_SIZE_BYTES
  }

  const ensureJobProbe = async (job: KeyAnalysisJob) => {
    const reusedProbe = getProbeForJob(job)
    if (reusedProbe) {
      job.probe = reusedProbe
      return
    }
    if (!shouldProbeForTimeoutBudget(job)) return
    const probe = await probeAudioFile(job.filePath)
    job.probe = probe
    const { size, mtimeMs } = getJobFileVersion(job)
    deps.probeCache.set(job.normalizedPath, {
      size,
      mtimeMs,
      probe,
      probedAt: Date.now()
    })
  }

  return {
    cleanupStaleFailures,
    cleanupStaleProbeCache,
    recordJobFailure,
    clearJobFailure,
    getFailureCooldownRecord,
    ensureJobProbe
  }
}

export type KeyAnalysisFailureTracker = ReturnType<typeof createKeyAnalysisFailureTracker>
