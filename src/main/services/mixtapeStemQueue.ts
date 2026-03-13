import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import childProcess from 'node:child_process'
import { app } from 'electron'
import { resolveBundledFfmpegPath } from '../ffmpeg'
import { log } from '../log'
import mixtapeWindow from '../window/mixtapeWindow'
import type { MixtapeStemMode } from '../mixtapeDb'
import { listMixtapeItems } from '../mixtapeDb'
import {
  resolveBundledDemucsModelsPath,
  resolveBundledDemucsPythonPath,
  resolveBundledDemucsRuntimeCandidates,
  resolveBundledDemucsRuntimeDir,
  type BundledDemucsRuntimeCandidate
} from '../demucs'
import {
  DEFAULT_MIXTAPE_STEM_BASE_MODEL,
  DEFAULT_MIXTAPE_STEM_PROFILE,
  normalizeMixtapeStemProfile,
  parseMixtapeStemModel,
  resolveMixtapeStemBaseModelByProfile,
  resolveMixtapeStemModelByProfile,
  type MixtapeStemProfile
} from '../../shared/mixtapeStemProfiles'
import { FIXED_MIXTAPE_STEM_MODE } from '../../shared/mixtapeStemMode'
import { prewarmMixtapeStemWaveformBundle } from './mixtapeStemWaveformService'
import {
  getMixtapeStemAsset,
  listMixtapeTrackStemStatusByPlaylist,
  summarizeMixtapeStemStatusByPlaylist,
  type MixtapeStemStatus,
  upsertMixtapeItemStemStateById,
  upsertMixtapeStemAsset
} from '../mixtapeStemDb'
import { findSongListRoot } from './cacheMaintenance'
import { runStemSeparation } from './mixtapeStemSeparationRun'
import { getStemBackgroundConcurrencyHint } from './backgroundIdleGate'
import { getCachedStemDeviceProbeSnapshot } from './mixtapeStemSeparationProbe'
import type {
  MixtapeStemComputeDevice,
  MixtapeStemCpuFallbackReasonCode,
  MixtapeStemSeparationResult
} from './mixtapeStemSeparationShared'
import {
  STEM_FREE_MEMORY_GB_FOR_GPU_CONCURRENCY_2,
  STEM_FREE_MEMORY_GB_FOR_GPU_CONCURRENCY_3,
  STEM_SYSTEM_MEMORY_GB_FOR_GPU_CONCURRENCY_2,
  STEM_SYSTEM_MEMORY_GB_FOR_GPU_CONCURRENCY_3
} from './mixtapeStemSeparationShared'

const DEFAULT_STEM_MODEL = resolveMixtapeStemModelByProfile(DEFAULT_MIXTAPE_STEM_PROFILE)
const DEFAULT_STEM_VERSION = 'demucs-waveform-builtin-20260313-stem-v2'

type MixtapeStemQueueTarget = {
  playlistId: string
  itemIds: string[]
}

type MixtapeStemQueueJob = {
  key: string
  filePath: string
  stemMode: MixtapeStemMode
  model: string
  stemVersion: string
  source: MixtapeStemEnqueueSource
  listRoot: string
  targets: Map<string, Set<string>>
}

type MixtapeStemEnqueueSource = 'foreground' | 'background'

export type MixtapeStemEnqueueParams = {
  playlistId: string
  filePaths: string[]
  stemMode: MixtapeStemMode
  force?: boolean
  profile?: MixtapeStemProfile
  model?: string
  stemVersion?: string
  source?: MixtapeStemEnqueueSource
}

export type MixtapeStemRetryParams = {
  playlistId: string
  stemMode: MixtapeStemMode
  itemIds?: string[]
  filePaths?: string[]
  profile?: MixtapeStemProfile
  model?: string
  stemVersion?: string
}

export type MixtapeStemEnqueueResult = {
  total: number
  queued: number
  merged: number
  readyFromCache: number
  skipped: number
}

const pendingQueue: MixtapeStemQueueJob[] = []
const pendingJobMap = new Map<string, MixtapeStemQueueJob>()
const inFlightJobMap = new Map<string, MixtapeStemQueueJob>()
let activeWorkers = 0
let stemQueueConcurrencySnapshot = 0
const cpuSlowHintNotifiedPlaylistIdSet = new Set<string>()

const normalizeStemMode = (_value: unknown): MixtapeStemMode => FIXED_MIXTAPE_STEM_MODE

const normalizeText = (value: unknown, maxLen = 2000): string => {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.length <= maxLen ? trimmed : trimmed.slice(0, maxLen)
}

const normalizeNumberOrNull = (value: unknown): number | null => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return parsed
}

const normalizeFilePath = (value: unknown): string => normalizeText(value, 4000)

const normalizePlaylistId = (value: unknown): string => normalizeText(value, 80)

const normalizeStemProfile = (
  value: unknown,
  fallback: MixtapeStemProfile = DEFAULT_MIXTAPE_STEM_PROFILE
): MixtapeStemProfile => normalizeMixtapeStemProfile(normalizeText(value, 24), fallback)

const normalizeModel = (
  value: unknown,
  fallbackProfile: MixtapeStemProfile = DEFAULT_MIXTAPE_STEM_PROFILE
): string => {
  const parsed = parseMixtapeStemModel(normalizeText(value, 128), fallbackProfile)
  return normalizeText(parsed.requestedModel, 128) || DEFAULT_STEM_MODEL
}

const normalizeStemVersion = (value: unknown, model?: string): string => {
  const normalized = normalizeText(value, 128)
  if (!normalized) return DEFAULT_STEM_VERSION
  return normalized
}

const normalizeEnqueueSource = (value: unknown): MixtapeStemEnqueueSource =>
  value === 'background' ? 'background' : 'foreground'

const shouldBypassReadyCacheForLegacyStemVersion = (params: {
  playlistId: string
  itemIds: string[]
  stemVersion: string
}): boolean => {
  if (params.stemVersion !== DEFAULT_STEM_VERSION) return false
  const targetItemIdSet = new Set(
    (params.itemIds || []).map((itemId) => normalizeText(itemId, 80)).filter(Boolean)
  )
  if (!targetItemIdSet.size) return false
  try {
    const items = listMixtapeItems(params.playlistId)
    for (const item of items) {
      const itemId = normalizeText((item as any)?.id, 80)
      if (!itemId || !targetItemIdSet.has(itemId)) continue
      const infoJsonRaw = normalizeText((item as any)?.infoJson, 200_000)
      if (!infoJsonRaw) {
        // 历史数据缺少 stemVersion 字段时，强制重算一次，避免旧缓存误命中。
        return true
      }
      try {
        const info = JSON.parse(infoJsonRaw)
        const currentStemVersion = normalizeText(info?.stemVersion, 128)
        if (!currentStemVersion) {
          return true
        }
        if (currentStemVersion !== params.stemVersion) {
          return true
        }
      } catch {}
    }
  } catch {}
  return false
}

const normalizePathKey = (value: string): string => {
  const normalized = normalizeFilePath(value)
  if (!normalized) return ''
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const buildJobKey = (params: {
  listRoot: string
  filePath: string
  stemMode: MixtapeStemMode
  model: string
}) => {
  const rootKey = normalizePathKey(params.listRoot)
  const fileKey = normalizePathKey(params.filePath)
  return `${rootKey}::${fileKey}::${params.stemMode}::${params.model}`
}

const notifyStemStatusUpdated = (params: {
  playlistId: string
  itemIds: string[]
  stemStatus: MixtapeStemStatus
  filePath?: string
  errorCode?: string | null
  errorMessage?: string | null
}) => {
  const playlistId = normalizePlaylistId(params.playlistId)
  if (!playlistId) return
  try {
    mixtapeWindow.broadcast?.('mixtape-stem-status-updated', {
      playlistId,
      itemIds: params.itemIds,
      stemStatus: params.stemStatus,
      filePath: normalizeFilePath(params.filePath),
      errorCode: normalizeText(params.errorCode, 80) || null,
      errorMessage: normalizeText(params.errorMessage, 1200) || null,
      stemSummary: summarizeMixtapeStemStatusByPlaylist(playlistId)
    })
  } catch {}
}

const notifyStemCpuSlowHint = (params: {
  playlistId: string
  filePath?: string
  model?: string
  reasonCode?: MixtapeStemCpuFallbackReasonCode
  reasonDetail?: string
}) => {
  const playlistId = normalizePlaylistId(params.playlistId)
  if (!playlistId) return
  if (cpuSlowHintNotifiedPlaylistIdSet.has(playlistId)) return
  cpuSlowHintNotifiedPlaylistIdSet.add(playlistId)
  try {
    mixtapeWindow.broadcast?.('mixtape-stem-cpu-slow-hint', {
      playlistId,
      filePath: normalizeFilePath(params.filePath),
      model: normalizeText(params.model, 128) || null,
      reasonCode:
        params.reasonCode === 'gpu_unavailable' ||
        params.reasonCode === 'gpu_failed' ||
        params.reasonCode === 'gpu_backend_missing'
          ? params.reasonCode
          : null,
      reasonDetail: normalizeText(params.reasonDetail, 600) || null
    })
  } catch {}
}

const notifyStemRuntimeProgress = (params: {
  playlistId: string
  itemIds: string[]
  filePath?: string
  model?: string
  device: MixtapeStemComputeDevice
  percent: number
  processedSec: number | null
  totalSec: number | null
  etaSec: number | null
}) => {
  const playlistId = normalizePlaylistId(params.playlistId)
  if (!playlistId) return
  const itemIds = Array.from(
    new Set((params.itemIds || []).map((itemId) => normalizeText(itemId, 80)).filter(Boolean))
  )
  if (!itemIds.length) return
  const percent = Math.max(0, Math.min(100, Math.round(Number(params.percent) || 0)))
  try {
    mixtapeWindow.broadcast?.('mixtape-stem-runtime-progress', {
      playlistId,
      itemIds,
      filePath: normalizeFilePath(params.filePath),
      model: normalizeText(params.model, 128) || null,
      device: params.device,
      percent,
      processedSec: normalizeNumberOrNull(params.processedSec),
      totalSec: normalizeNumberOrNull(params.totalSec),
      etaSec: normalizeNumberOrNull(params.etaSec),
      updatedAt: Date.now()
    })
  } catch {}
}

const collectTargetsForFilePaths = (playlistId: string, filePaths: string[]) => {
  const normalizedPlaylistId = normalizePlaylistId(playlistId)
  if (!normalizedPlaylistId) return new Map<string, { filePath: string; itemIds: string[] }>()
  const requestedPathMap = new Map<string, string>()
  for (const item of filePaths) {
    const normalizedPath = normalizeFilePath(item)
    const pathKey = normalizePathKey(normalizedPath)
    if (!normalizedPath || !pathKey || requestedPathMap.has(pathKey)) continue
    requestedPathMap.set(pathKey, normalizedPath)
  }
  if (!requestedPathMap.size) return new Map<string, { filePath: string; itemIds: string[] }>()
  const matched = new Map<string, { filePath: string; itemIds: string[] }>()
  const items = listMixtapeItems(normalizedPlaylistId)
  for (const item of items) {
    const itemId = normalizeText(item?.id, 80)
    const filePath = normalizeFilePath(item?.filePath)
    const pathKey = normalizePathKey(filePath)
    if (!itemId || !filePath || !pathKey || !requestedPathMap.has(pathKey)) continue
    const existing = matched.get(pathKey)
    if (existing) {
      existing.itemIds.push(itemId)
      continue
    }
    matched.set(pathKey, {
      filePath,
      itemIds: [itemId]
    })
  }
  return matched
}

const upsertItemStemStatus = (
  targets: MixtapeStemQueueTarget[],
  status: MixtapeStemStatus,
  extra?: {
    stemError?: string | null
    stemReadyAt?: number | null
    stemModel?: string | null
    stemVersion?: string | null
    stemVocalPath?: string | null
    stemInstPath?: string | null
    stemBassPath?: string | null
    stemDrumsPath?: string | null
    filePath?: string
    errorCode?: string | null
  }
) => {
  for (const target of targets) {
    const itemIds = Array.from(
      new Set(target.itemIds.map((itemId) => normalizeText(itemId, 80)).filter(Boolean))
    )
    if (!itemIds.length) continue
    upsertMixtapeItemStemStateById(
      itemIds.map((itemId) => ({
        itemId,
        stemStatus: status,
        stemError: Object.prototype.hasOwnProperty.call(extra || {}, 'stemError')
          ? extra?.stemError || null
          : undefined,
        stemReadyAt: Object.prototype.hasOwnProperty.call(extra || {}, 'stemReadyAt')
          ? (extra?.stemReadyAt ?? null)
          : undefined,
        stemModel: Object.prototype.hasOwnProperty.call(extra || {}, 'stemModel')
          ? extra?.stemModel || null
          : undefined,
        stemVersion: Object.prototype.hasOwnProperty.call(extra || {}, 'stemVersion')
          ? extra?.stemVersion || null
          : undefined,
        stemVocalPath: Object.prototype.hasOwnProperty.call(extra || {}, 'stemVocalPath')
          ? extra?.stemVocalPath || null
          : undefined,
        stemInstPath: Object.prototype.hasOwnProperty.call(extra || {}, 'stemInstPath')
          ? extra?.stemInstPath || null
          : undefined,
        stemBassPath: Object.prototype.hasOwnProperty.call(extra || {}, 'stemBassPath')
          ? extra?.stemBassPath || null
          : undefined,
        stemDrumsPath: Object.prototype.hasOwnProperty.call(extra || {}, 'stemDrumsPath')
          ? extra?.stemDrumsPath || null
          : undefined
      }))
    )
    notifyStemStatusUpdated({
      playlistId: target.playlistId,
      itemIds,
      stemStatus: status,
      filePath: extra?.filePath,
      errorCode: extra?.errorCode || null,
      errorMessage: extra?.stemError || null
    })
  }
}

const buildQueueTargets = (job: MixtapeStemQueueJob): MixtapeStemQueueTarget[] => {
  const targets: MixtapeStemQueueTarget[] = []
  for (const [playlistId, itemIds] of job.targets.entries()) {
    targets.push({
      playlistId,
      itemIds: Array.from(itemIds)
    })
  }
  return targets
}

const resolveAssetRequiredPaths = (
  _stemMode: MixtapeStemMode,
  result: MixtapeStemSeparationResult
): string[] => {
  return [result.vocalPath, result.instPath, result.bassPath, result.drumsPath]
    .map((item) => normalizeFilePath(item))
    .filter(Boolean)
}

const hasReadyStemAssets = (
  stemMode: MixtapeStemMode,
  asset: ReturnType<typeof getMixtapeStemAsset> | null
): boolean => {
  if (!asset) return false
  if (asset.status !== 'ready') return false
  const requiredPaths = resolveAssetRequiredPaths(stemMode, {
    vocalPath: asset.vocalPath,
    instPath: asset.instPath,
    bassPath: asset.bassPath,
    drumsPath: asset.drumsPath
  })
  if (!requiredPaths.length) return false
  return requiredPaths.every((filePath) => fs.existsSync(filePath))
}

const prewarmStemWaveformBundleFromPaths = (params: {
  listRoot: string
  sourceFilePath: string
  stemMode: MixtapeStemMode
  stemModel: string
  stemVersion: string
  vocalPath?: string | null
  instPath?: string | null
  bassPath?: string | null
  drumsPath?: string | null
}) => {
  prewarmMixtapeStemWaveformBundle({
    listRoot: params.listRoot,
    sourceFilePath: params.sourceFilePath,
    stemMode: params.stemMode,
    stemModel: params.stemModel,
    stemVersion: params.stemVersion,
    stemPaths: {
      vocalPath: params.vocalPath || null,
      instPath: params.instPath || null,
      bassPath: params.bassPath || null,
      drumsPath: params.drumsPath || null
    }
  })
}

const STEM_QUEUE_CPU_JOB_CONCURRENCY_MAX = 4
const STEM_QUEUE_CPU_JOB_CORE_DIVISOR = 2
const STEM_QUEUE_XPU_JOB_CONCURRENCY_MAX = 2
const STEM_QUEUE_DIRECTML_JOB_CONCURRENCY_MAX = 1

const hasBundledXpuRuntimeCandidate = () =>
  resolveBundledDemucsRuntimeCandidates().some((candidate) => {
    const runtimeKey = normalizeText(candidate?.key, 64).toLowerCase()
    return runtimeKey === 'runtime-xpu'
  })

const resolveGpuDeviceCap = (preferredDevice: MixtapeStemComputeDevice) => {
  const totalMemoryGb = Math.max(1, Math.floor(os.totalmem() / 1024 ** 3))
  const freeMemoryGb = Math.max(0, Math.floor(os.freemem() / 1024 ** 3))
  let cap = 1
  if (
    totalMemoryGb >= STEM_SYSTEM_MEMORY_GB_FOR_GPU_CONCURRENCY_2 &&
    freeMemoryGb >= STEM_FREE_MEMORY_GB_FOR_GPU_CONCURRENCY_2
  ) {
    cap = 2
  }
  if (
    preferredDevice === 'cuda' &&
    totalMemoryGb >= STEM_SYSTEM_MEMORY_GB_FOR_GPU_CONCURRENCY_3 &&
    freeMemoryGb >= STEM_FREE_MEMORY_GB_FOR_GPU_CONCURRENCY_3
  ) {
    cap = 3
  }
  if (preferredDevice === 'xpu') {
    cap = Math.min(cap, STEM_QUEUE_XPU_JOB_CONCURRENCY_MAX)
  }
  if (preferredDevice === 'directml') {
    cap = STEM_QUEUE_DIRECTML_JOB_CONCURRENCY_MAX
  }
  return {
    cap,
    totalMemoryGb,
    freeMemoryGb
  }
}

const resolveStemQueueConcurrency = () => {
  const cpuCount = Math.max(1, os.cpus().length || 1)
  const cpuCap = Math.max(
    1,
    Math.min(
      STEM_QUEUE_CPU_JOB_CONCURRENCY_MAX,
      Math.floor(cpuCount / STEM_QUEUE_CPU_JOB_CORE_DIVISOR)
    )
  )
  const deviceSnapshot = getCachedStemDeviceProbeSnapshot()
  const preferredDevice =
    deviceSnapshot?.devices.find((device) => device !== 'cpu') ||
    (process.platform === 'win32' && hasBundledXpuRuntimeCandidate() ? 'xpu' : 'cpu')
  const gpuDevice = preferredDevice !== 'cpu'
  const gpuDeviceCap = gpuDevice ? resolveGpuDeviceCap(preferredDevice) : null
  const deviceCap = preferredDevice === 'cpu' ? cpuCap : gpuDeviceCap?.cap || 1
  const hasForegroundQueueJob = pendingQueue.some((job) => job.source === 'foreground')
  const hasForegroundInFlightJob = Array.from(inFlightJobMap.values()).some(
    (job) => job.source === 'foreground'
  )
  const hasForegroundDemand = hasForegroundQueueJob || hasForegroundInFlightJob
  const idleHint = getStemBackgroundConcurrencyHint()
  const backgroundTarget = Math.max(1, Math.min(deviceCap, idleHint.target))
  const maxWorkers = hasForegroundDemand ? deviceCap : backgroundTarget
  return {
    maxWorkers,
    cpuCount,
    cpuCap,
    deviceCap,
    preferredDevice,
    totalMemoryGb:
      gpuDeviceCap?.totalMemoryGb || Math.max(1, Math.floor(os.totalmem() / 1024 ** 3)),
    freeMemoryGb: gpuDeviceCap?.freeMemoryGb || Math.max(0, Math.floor(os.freemem() / 1024 ** 3)),
    hasForegroundDemand,
    backgroundTarget,
    idleTarget: idleHint.target,
    idleProfile: idleHint.profile,
    idleAllowed: idleHint.allowed,
    foregroundBusy: idleHint.foregroundBusy,
    systemIdleSeconds: idleHint.systemIdleSeconds,
    systemIdleState: idleHint.systemIdleState
  }
}

const runQueueLoop = () => {
  const concurrency = resolveStemQueueConcurrency()
  const maxWorkers = concurrency.maxWorkers
  if (stemQueueConcurrencySnapshot !== maxWorkers) {
    stemQueueConcurrencySnapshot = maxWorkers
    log.info('[mixtape-stem] queue concurrency updated', {
      maxWorkers,
      cpuCount: concurrency.cpuCount,
      cpuCap: concurrency.cpuCap,
      deviceCap: concurrency.deviceCap,
      preferredDevice: concurrency.preferredDevice,
      totalMemoryGb: concurrency.totalMemoryGb,
      freeMemoryGb: concurrency.freeMemoryGb,
      hasForegroundDemand: concurrency.hasForegroundDemand,
      backgroundTarget: concurrency.backgroundTarget,
      idleTarget: concurrency.idleTarget,
      idleProfile: concurrency.idleProfile,
      idleAllowed: concurrency.idleAllowed,
      foregroundBusy: concurrency.foregroundBusy,
      systemIdleSeconds: concurrency.systemIdleSeconds,
      systemIdleState: concurrency.systemIdleState
    })
  }
  while (activeWorkers < maxWorkers && pendingQueue.length > 0) {
    const job = pendingQueue.shift()
    if (!job) continue
    if (pendingJobMap.get(job.key) !== job) continue
    pendingJobMap.delete(job.key)
    inFlightJobMap.set(job.key, job)
    activeWorkers += 1
    void processQueueJob(job)
      .catch((error) => {
        log.error('[mixtape-stem] process queue job failed', {
          filePath: job.filePath,
          stemMode: job.stemMode,
          error
        })
      })
      .finally(() => {
        activeWorkers = Math.max(0, activeWorkers - 1)
        if (inFlightJobMap.get(job.key) === job) {
          inFlightJobMap.delete(job.key)
        }
        runQueueLoop()
      })
  }
}

const processQueueJob = async (job: MixtapeStemQueueJob) => {
  const targets = buildQueueTargets(job)
  if (!targets.length) return
  upsertItemStemStatus(targets, 'running', {
    stemError: null,
    stemModel: job.model,
    stemVersion: job.stemVersion,
    stemReadyAt: null,
    stemVocalPath: null,
    stemInstPath: null,
    stemBassPath: null,
    stemDrumsPath: null,
    filePath: job.filePath
  })
  upsertMixtapeStemAsset({
    listRoot: job.listRoot,
    filePath: job.filePath,
    stemMode: job.stemMode,
    model: job.model,
    status: 'running',
    errorCode: null,
    errorMessage: null
  })
  try {
    const separation = await runStemSeparation({
      filePath: job.filePath,
      stemMode: job.stemMode,
      model: job.model,
      onDeviceStart: (device, context) => {
        if (device !== 'cpu') return
        for (const target of targets) {
          notifyStemCpuSlowHint({
            playlistId: target.playlistId,
            filePath: job.filePath,
            model: job.model,
            reasonCode: context?.reasonCode,
            reasonDetail: context?.reasonDetail
          })
        }
      },
      onProgress: (progress) => {
        for (const target of targets) {
          notifyStemRuntimeProgress({
            playlistId: target.playlistId,
            itemIds: target.itemIds,
            filePath: job.filePath,
            model: job.model,
            device: progress.device,
            percent: progress.percent,
            processedSec: progress.processedSec,
            totalSec: progress.totalSec,
            etaSec: progress.etaSec
          })
        }
      }
    })
    const requiredPaths = resolveAssetRequiredPaths(job.stemMode, separation)
    if (!requiredPaths.length || !requiredPaths.every((filePath) => fs.existsSync(filePath))) {
      const missingError = new Error('STEM_ASSET_MISSING')
      ;(missingError as any).code = 'STEM_ASSET_MISSING'
      throw missingError
    }
    upsertMixtapeStemAsset({
      listRoot: job.listRoot,
      filePath: job.filePath,
      stemMode: job.stemMode,
      model: job.model,
      status: 'ready',
      vocalPath: separation.vocalPath || null,
      instPath: separation.instPath || null,
      bassPath: separation.bassPath || null,
      drumsPath: separation.drumsPath || null,
      errorCode: null,
      errorMessage: null
    })
    upsertItemStemStatus(targets, 'ready', {
      stemError: null,
      stemModel: job.model,
      stemVersion: job.stemVersion,
      stemReadyAt: Date.now(),
      stemVocalPath: separation.vocalPath || null,
      stemInstPath: separation.instPath || null,
      stemBassPath: separation.bassPath || null,
      stemDrumsPath: separation.drumsPath || null,
      filePath: job.filePath
    })
    prewarmStemWaveformBundleFromPaths({
      listRoot: job.listRoot,
      sourceFilePath: job.filePath,
      stemMode: job.stemMode,
      stemModel: job.model,
      stemVersion: job.stemVersion,
      vocalPath: separation.vocalPath || null,
      instPath: separation.instPath || null,
      bassPath: separation.bassPath || null,
      drumsPath: separation.drumsPath || null
    })
  } catch (error) {
    const errorCode = normalizeText((error as any)?.code, 80) || 'STEM_SPLIT_FAILED'
    const errorMessage = normalizeText(
      error instanceof Error ? error.message : String(error || 'stem split failed'),
      1200
    )
    log.error('[mixtape-stem] stem split failed', {
      filePath: job.filePath,
      stemMode: job.stemMode,
      model: job.model,
      errorCode,
      errorMessage
    })
    upsertMixtapeStemAsset({
      listRoot: job.listRoot,
      filePath: job.filePath,
      stemMode: job.stemMode,
      model: job.model,
      status: 'failed',
      errorCode,
      errorMessage
    })
    upsertItemStemStatus(targets, 'failed', {
      stemError: errorMessage,
      stemModel: job.model,
      stemVersion: job.stemVersion,
      stemReadyAt: null,
      stemVocalPath: null,
      stemInstPath: null,
      stemBassPath: null,
      stemDrumsPath: null,
      filePath: job.filePath,
      errorCode
    })
  }
}

const mergeJobTargets = (job: MixtapeStemQueueJob, targets: MixtapeStemQueueTarget[]) => {
  for (const target of targets) {
    const playlistId = normalizePlaylistId(target.playlistId)
    if (!playlistId) continue
    const existing = job.targets.get(playlistId) || new Set<string>()
    for (const itemId of target.itemIds) {
      const normalizedItemId = normalizeText(itemId, 80)
      if (!normalizedItemId) continue
      existing.add(normalizedItemId)
    }
    if (existing.size > 0) {
      job.targets.set(playlistId, existing)
    }
  }
}

const resolveListRootForFile = async (filePath: string): Promise<string> => {
  const normalizedPath = normalizeFilePath(filePath)
  if (!normalizedPath) return ''
  try {
    const resolved = await findSongListRoot(path.dirname(normalizedPath))
    if (resolved) return normalizeFilePath(resolved)
  } catch {}
  return normalizeFilePath(path.dirname(normalizedPath))
}

export async function enqueueMixtapeStemJobs(
  params: MixtapeStemEnqueueParams
): Promise<MixtapeStemEnqueueResult> {
  const playlistId = normalizePlaylistId(params?.playlistId)
  const stemMode = normalizeStemMode(params?.stemMode)
  const force = !!params?.force
  const profile = normalizeStemProfile(params?.profile, DEFAULT_MIXTAPE_STEM_PROFILE)
  const model = normalizeModel(params?.model, profile)
  const stemVersion = normalizeStemVersion(params?.stemVersion, model)
  const source = normalizeEnqueueSource(params?.source)
  const inputPaths = Array.isArray(params?.filePaths) ? params.filePaths : []
  if (!playlistId || !inputPaths.length) {
    return {
      total: 0,
      queued: 0,
      merged: 0,
      readyFromCache: 0,
      skipped: 0
    }
  }

  const targetByPath = collectTargetsForFilePaths(playlistId, inputPaths)
  const total = targetByPath.size
  if (total === 0) {
    log.warn('[mixtape-stem] enqueue: no mixtape items matched file paths', {
      playlistId,
      stemMode,
      inputCount: inputPaths.length
    })
  }
  let queued = 0
  let merged = 0
  let readyFromCache = 0
  let skipped = 0

  for (const { filePath, itemIds } of targetByPath.values()) {
    if (!filePath || !itemIds.length) {
      skipped += 1
      continue
    }
    const listRoot = await resolveListRootForFile(filePath)
    if (!listRoot) {
      skipped += 1
      continue
    }

    const queueTargets: MixtapeStemQueueTarget[] = [{ playlistId, itemIds }]
    const jobKey = buildJobKey({
      listRoot,
      filePath,
      stemMode,
      model
    })
    const bypassReadyCache = shouldBypassReadyCacheForLegacyStemVersion({
      playlistId,
      itemIds,
      stemVersion
    })
    if (bypassReadyCache) {
      log.info('[mixtape-stem] bypass ready cache for outdated stem version', {
        playlistId,
        file: filePath,
        stemMode,
        model,
        stemVersion,
        targetCount: itemIds.length
      })
    }
    if (!force) {
      if (!bypassReadyCache) {
        const cachedAsset = getMixtapeStemAsset({
          listRoot,
          filePath,
          stemMode,
          model
        })
        if (hasReadyStemAssets(stemMode, cachedAsset)) {
          readyFromCache += 1
          upsertItemStemStatus(queueTargets, 'ready', {
            stemError: null,
            stemModel: model,
            stemVersion,
            stemReadyAt: Date.now(),
            stemVocalPath: cachedAsset?.vocalPath || null,
            stemInstPath: cachedAsset?.instPath || null,
            stemBassPath: cachedAsset?.bassPath || null,
            stemDrumsPath: cachedAsset?.drumsPath || null,
            filePath
          })
          prewarmStemWaveformBundleFromPaths({
            listRoot,
            sourceFilePath: filePath,
            stemMode,
            stemModel: model,
            stemVersion,
            vocalPath: cachedAsset?.vocalPath || null,
            instPath: cachedAsset?.instPath || null,
            bassPath: cachedAsset?.bassPath || null,
            drumsPath: cachedAsset?.drumsPath || null
          })
          continue
        }
      }
    }

    upsertItemStemStatus(queueTargets, 'pending', {
      stemError: null,
      stemModel: model,
      stemVersion,
      stemReadyAt: null,
      stemVocalPath: null,
      stemInstPath: null,
      stemBassPath: null,
      stemDrumsPath: null,
      filePath
    })
    upsertMixtapeStemAsset({
      listRoot,
      filePath,
      stemMode,
      model,
      status: 'pending',
      errorCode: null,
      errorMessage: null
    })

    const pendingJob = pendingJobMap.get(jobKey)
    if (pendingJob) {
      mergeJobTargets(pendingJob, queueTargets)
      if (source === 'foreground' && pendingJob.source !== 'foreground') {
        pendingJob.source = 'foreground'
      }
      merged += 1
      continue
    }
    const inFlightJob = inFlightJobMap.get(jobKey)
    if (inFlightJob) {
      mergeJobTargets(inFlightJob, queueTargets)
      if (source === 'foreground' && inFlightJob.source !== 'foreground') {
        inFlightJob.source = 'foreground'
      }
      merged += 1
      continue
    }
    const job: MixtapeStemQueueJob = {
      key: jobKey,
      filePath,
      stemMode,
      model,
      stemVersion,
      source,
      listRoot,
      targets: new Map<string, Set<string>>()
    }
    mergeJobTargets(job, queueTargets)
    pendingJobMap.set(jobKey, job)
    pendingQueue.push(job)
    queued += 1
  }

  runQueueLoop()
  return {
    total,
    queued,
    merged,
    readyFromCache,
    skipped
  }
}

export function isMixtapeStemQueueBusy(): boolean {
  return pendingQueue.length > 0 || inFlightJobMap.size > 0 || activeWorkers > 0
}

export async function retryMixtapeStemJobs(params: MixtapeStemRetryParams) {
  const playlistId = normalizePlaylistId(params?.playlistId)
  const stemMode = normalizeStemMode(params?.stemMode)
  if (!playlistId) {
    return {
      total: 0,
      queued: 0,
      merged: 0,
      readyFromCache: 0,
      skipped: 0
    }
  }
  const explicitFilePaths = Array.isArray(params?.filePaths)
    ? params.filePaths.map((item) => normalizeFilePath(item)).filter(Boolean)
    : []
  const explicitItemIds = new Set(
    Array.isArray(params?.itemIds)
      ? params.itemIds.map((item) => normalizeText(item, 80)).filter(Boolean)
      : []
  )
  const statusRows = listMixtapeTrackStemStatusByPlaylist(playlistId)
  const failedRows = statusRows.filter((row) => row.stemStatus === 'failed')
  const failedFilePathSet = new Set<string>(
    failedRows.map((row) => normalizeFilePath(row.filePath)).filter(Boolean)
  )
  if (explicitItemIds.size > 0) {
    for (const row of failedRows) {
      if (!explicitItemIds.has(row.itemId)) continue
      const filePath = normalizeFilePath(row.filePath)
      if (filePath) failedFilePathSet.add(filePath)
    }
  }
  for (const item of explicitFilePaths) {
    failedFilePathSet.add(item)
  }
  const profile = normalizeStemProfile(params?.profile, DEFAULT_MIXTAPE_STEM_PROFILE)
  return enqueueMixtapeStemJobs({
    playlistId,
    filePaths: Array.from(failedFilePathSet),
    stemMode,
    force: true,
    profile,
    model: params?.model,
    stemVersion: params?.stemVersion
  })
}

export function getMixtapeStemStatusSnapshot(playlistId: string) {
  const normalizedPlaylistId = normalizePlaylistId(playlistId)
  if (!normalizedPlaylistId) {
    return {
      items: [],
      stemSummary: summarizeMixtapeStemStatusByPlaylist('')
    }
  }
  return {
    items: listMixtapeTrackStemStatusByPlaylist(normalizedPlaylistId),
    stemSummary: summarizeMixtapeStemStatusByPlaylist(normalizedPlaylistId)
  }
}
