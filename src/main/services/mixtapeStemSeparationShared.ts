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
  resolveBundledDemucsRuntimeDir
} from '../demucs'
import {
  DEFAULT_MIXTAPE_STEM_BASE_MODEL,
  DEFAULT_MIXTAPE_STEM_PROFILE,
  normalizeMixtapeStemProfile,
  parseMixtapeStemModel,
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

export const STEM_GPU_JOB_CONCURRENCY_MIN = 1
export const STEM_GPU_JOB_CONCURRENCY_MAX = 3
export const STEM_GPU_JOB_CONCURRENCY_DIRECTML_MAX = 3
export const STEM_SYSTEM_MEMORY_GB_FOR_GPU_CONCURRENCY_2 = 16
export const STEM_SYSTEM_MEMORY_GB_FOR_GPU_CONCURRENCY_3 = 24
export const STEM_FREE_MEMORY_GB_FOR_GPU_CONCURRENCY_2 = 5
export const STEM_FREE_MEMORY_GB_FOR_GPU_CONCURRENCY_3 = 8
export const STEM_CPU_JOB_CONCURRENCY_MAX = 4
export const STEM_CPU_JOB_CORE_DIVISOR = 2
export const STEM_PROCESS_TIMEOUT_MS = 60 * 60 * 1000
export const STEM_PROCESS_TIMEOUT_MAX_MS = 2 * 60 * 60 * 1000
export const STEM_CPU_PROCESS_TIMEOUT_CAP_MS = 8 * 60 * 1000
export const STEM_GPU_PROCESS_TIMEOUT_CAP_MS = STEM_PROCESS_TIMEOUT_MS
export const STEM_CPU_PROCESS_TIMEOUT_MIN_MS = 4 * 60 * 1000
export const STEM_GPU_PROCESS_TIMEOUT_MIN_MS = 3 * 60 * 1000
export const STEM_FFPROBE_TIMEOUT_MS = 20_000
export const STEM_DEVICE_PROBE_TIMEOUT_MS = 15_000
export const STEM_DEVICE_COMPATIBILITY_TIMEOUT_MS = 12_000
export const STEM_DEVICE_PROBE_CACHE_TTL_MS = 5 * 60 * 1000
export const STEM_WINDOWS_GPU_ADAPTER_PROBE_TIMEOUT_MS = 6_000
export const DEMUCS_NO_SPLIT_MAX_DURATION_SECONDS = 7 * 60
export const DEMUCS_HTDEMUCS_MAX_SEGMENT_SECONDS = 7.8
export const DEMUCS_PROFILE_OPTIONS: Record<
  MixtapeStemProfile,
  { shifts: string; overlap: string; segmentSec: string }
> = {
  quality: {
    shifts: '1',
    overlap: '0.25',
    segmentSec: '11'
  }
}
export const DEFAULT_STEM_MODEL = resolveMixtapeStemModelByProfile(DEFAULT_MIXTAPE_STEM_PROFILE)
export const DEFAULT_STEM_VERSION = 'demucs-cli-builtin-20260309-stem-v1'
export const STEM_CACHE_DIR_NAME = 'stems'

export type MixtapeStemQueueTarget = {
  playlistId: string
  itemIds: string[]
}

export type MixtapeStemQueueJob = {
  key: string
  filePath: string
  stemMode: MixtapeStemMode
  model: string
  stemVersion: string
  listRoot: string
  targets: Map<string, Set<string>>
}

export type MixtapeStemSeparationResult = {
  vocalPath?: string | null
  instPath?: string | null
  bassPath?: string | null
  drumsPath?: string | null
}

export type MixtapeStemComputeDevice = 'cuda' | 'mps' | 'xpu' | 'directml' | 'cpu'
export type MixtapeStemCpuFallbackReasonCode =
  | 'gpu_unavailable'
  | 'gpu_failed'
  | 'gpu_backend_missing'
export type MixtapeStemRuntimeProgress = {
  device: MixtapeStemComputeDevice
  percent: number
  processedSec: number | null
  totalSec: number | null
  etaSec: number | null
}

export type MixtapeStemDeviceProbeSnapshot = {
  checkedAt: number
  runtimeKey: string
  runtimeDir: string
  pythonPath: string
  devices: MixtapeStemComputeDevice[]
  cudaAvailable: boolean
  mpsAvailable: boolean
  xpuAvailable: boolean
  xpuBackendInstalled: boolean
  xpuDemucsCompatible: boolean
  anyXpuBackendInstalled: boolean
  directmlAvailable: boolean
  directmlBackendInstalled: boolean
  directmlDemucsCompatible: boolean
  anyDirectmlBackendInstalled: boolean
  directmlDevice: string
  windowsAdapterNames: string[]
  windowsHasIntelAdapter: boolean
  windowsHasAmdAdapter: boolean
  windowsHasNvidiaAdapter: boolean
}

export const resolveStemProcessTimeoutMs = (params: {
  device: MixtapeStemComputeDevice
  inputDurationSec: number | null
}): number => {
  const isCpu = params.device === 'cpu'
  const timeoutCapMs = isCpu ? STEM_CPU_PROCESS_TIMEOUT_CAP_MS : STEM_GPU_PROCESS_TIMEOUT_CAP_MS
  const timeoutMinMs = isCpu ? STEM_CPU_PROCESS_TIMEOUT_MIN_MS : STEM_GPU_PROCESS_TIMEOUT_MIN_MS
  if (!Number.isFinite(params.inputDurationSec) || Number(params.inputDurationSec) <= 0) {
    return timeoutCapMs
  }
  const factor = isCpu ? 2.8 : 8
  const durationBasedMs = Math.round(Number(params.inputDurationSec) * 1000 * factor)
  return Math.max(timeoutMinMs, Math.min(timeoutCapMs, durationBasedMs))
}

export type MixtapeStemEnqueueParams = {
  playlistId: string
  filePaths: string[]
  stemMode: MixtapeStemMode
  force?: boolean
  profile?: MixtapeStemProfile
  model?: string
  stemVersion?: string
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

export const pendingQueue: MixtapeStemQueueJob[] = []
export const pendingJobMap = new Map<string, MixtapeStemQueueJob>()
export const inFlightJobMap = new Map<string, MixtapeStemQueueJob>()
export let activeWorkers = 0
export let stemDeviceProbeSnapshot: MixtapeStemDeviceProbeSnapshot | null = null
export let stemDeviceProbePromise: Promise<MixtapeStemDeviceProbeSnapshot> | null = null
export let stemQueueConcurrencySnapshot = 0
export const cpuSlowHintNotifiedPlaylistIdSet = new Set<string>()

export const normalizeStemMode = (_value: unknown): MixtapeStemMode => FIXED_MIXTAPE_STEM_MODE

export const normalizeText = (value: unknown, maxLen = 2000): string => {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.length <= maxLen ? trimmed : trimmed.slice(0, maxLen)
}

export const normalizeNumberOrNull = (value: unknown): number | null => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return parsed
}

export const normalizeNonNegativeInt = (value: unknown): number => {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return parsed
}

export const normalizePositiveTimestamp = (value: unknown): number => {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return parsed
}

export const toDemucsSegmentSecArg = (value: number): string => {
  const parsed = Number(value)
  const safeValue = Number.isFinite(parsed) && parsed > 0 ? parsed : 7
  return String(Math.max(1, Math.floor(safeValue)))
}

export const resolveDemucsSegmentSec = (params: {
  demucsModel: string
  requestedSegmentSec: string
}): string => {
  const requested = Number(params.requestedSegmentSec)
  const safeRequested = Number.isFinite(requested) && requested > 0 ? requested : 7
  const model = normalizeText(params.demucsModel, 128).toLowerCase()
  const capped = model.includes('htdemucs')
    ? Math.min(safeRequested, DEMUCS_HTDEMUCS_MAX_SEGMENT_SECONDS)
    : safeRequested
  return toDemucsSegmentSecArg(capped)
}

export const normalizeFilePath = (value: unknown): string => normalizeText(value, 4000)

export const normalizePlaylistId = (value: unknown): string => normalizeText(value, 80)

export const normalizeStemProfile = (
  value: unknown,
  fallback: MixtapeStemProfile = DEFAULT_MIXTAPE_STEM_PROFILE
): MixtapeStemProfile => normalizeMixtapeStemProfile(normalizeText(value, 24), fallback)

export const normalizeModel = (
  value: unknown,
  fallbackProfile: MixtapeStemProfile = DEFAULT_MIXTAPE_STEM_PROFILE
): string => {
  const parsed = parseMixtapeStemModel(normalizeText(value, 128), fallbackProfile)
  return normalizeText(parsed.requestedModel, 128) || DEFAULT_STEM_MODEL
}

export const normalizeStemVersion = (value: unknown, model?: string): string => {
  const normalized = normalizeText(value, 128)
  if (!normalized) return DEFAULT_STEM_VERSION
  return normalized
}

export const normalizePathKey = (value: string): string => {
  const normalized = normalizeFilePath(value)
  if (!normalized) return ''
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export const buildJobKey = (params: {
  listRoot: string
  filePath: string
  stemMode: MixtapeStemMode
  model: string
}) => {
  const rootKey = normalizePathKey(params.listRoot)
  const fileKey = normalizePathKey(params.filePath)
  return `${rootKey}::${fileKey}::${params.stemMode}::${params.model}`
}

export const notifyStemStatusUpdated = (params: {
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

export const notifyStemCpuSlowHint = (params: {
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

export const notifyStemRuntimeProgress = (params: {
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

export const collectTargetsForFilePaths = (playlistId: string, filePaths: string[]) => {
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

export const upsertItemStemStatus = (
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

export const buildQueueTargets = (job: MixtapeStemQueueJob): MixtapeStemQueueTarget[] => {
  const targets: MixtapeStemQueueTarget[] = []
  for (const [playlistId, itemIds] of job.targets.entries()) {
    targets.push({
      playlistId,
      itemIds: Array.from(itemIds)
    })
  }
  return targets
}

export const resolveAssetRequiredPaths = (
  _stemMode: MixtapeStemMode,
  result: MixtapeStemSeparationResult
): string[] => {
  return [result.vocalPath, result.instPath, result.bassPath, result.drumsPath]
    .map((item) => normalizeFilePath(item))
    .filter(Boolean)
}

export const hasReadyStemAssets = (
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

export const prewarmStemWaveformBundleFromPaths = (params: {
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

export const createStemError = (code: string, message: string): Error & { code: string } => {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

export const toSafePathSegment = (value: string, fallback = 'default') => {
  const cleaned = normalizeText(value, 128)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .trim()
  return cleaned || fallback
}

export const buildStemSourceHash = async (filePath: string): Promise<string> => {
  const stat = await fs.promises.stat(filePath)
  const source = [
    normalizePathKey(filePath),
    String(Math.max(0, Number(stat.size) || 0)),
    String(Math.max(0, Math.floor(Number(stat.mtimeMs) || 0)))
  ].join('\n')
  return crypto.createHash('sha1').update(source).digest('hex')
}

export const resolveStemCacheDir = async (params: {
  filePath: string
  model: string
  stemMode: MixtapeStemMode
}) => {
  const sourceHash = await buildStemSourceHash(params.filePath)
  const modelDirName = toSafePathSegment(params.model, DEFAULT_STEM_MODEL)
  return path.join(
    app.getPath('userData'),
    STEM_CACHE_DIR_NAME,
    sourceHash,
    modelDirName,
    params.stemMode
  )
}

export const resolveDemucsRawStemPath = (params: {
  rawOutputRoot: string
  model: string
  filePath: string
  stemName: 'vocals' | 'drums' | 'bass' | 'other'
}) => {
  const trackName = path.parse(params.filePath).name
  const candidates = [
    path.join(params.rawOutputRoot, params.model, `${params.stemName}.wav`),
    path.join(params.rawOutputRoot, params.model, trackName, `${params.stemName}.wav`)
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return ''
}

export const runProcess = async (
  command: string,
  args: string[],
  options?: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
    absoluteTimeoutMs?: number
    traceLabel?: string
    progressIntervalMs?: number
    onStdoutChunk?: (chunk: string) => void
    onStderrChunk?: (chunk: string) => void
  }
) => {
  await new Promise<void>((resolve, reject) => {
    const traceLabel = normalizeText(options?.traceLabel, 120) || 'mixtape-stem-process'
    const startedAt = Date.now()
    let lastActivityAt = startedAt
    const progressIntervalMs = Math.max(10_000, Number(options?.progressIntervalMs) || 30_000)
    const child = childProcess.spawn(command, args, {
      cwd: options?.cwd,
      env: options?.env,
      windowsHide: true
    })
    let stderrText = ''
    let stdoutText = ''
    let timedOut = false
    let timeoutReason: 'idle' | 'absolute' | null = null
    const timeoutMs = Math.max(10_000, Number(options?.timeoutMs) || STEM_PROCESS_TIMEOUT_MS)
    const absoluteTimeoutMs = Math.max(
      timeoutMs,
      Math.min(
        STEM_PROCESS_TIMEOUT_MAX_MS,
        Math.max(Number(options?.absoluteTimeoutMs) || 0, timeoutMs * 4)
      )
    )
    const progressTimer = setInterval(() => {
      const now = Date.now()
      log.info(`[${traceLabel}] process running`, {
        elapsedMs: now - startedAt,
        idleMs: now - lastActivityAt,
        timeoutMs,
        absoluteTimeoutMs
      })
    }, progressIntervalMs)
    const timeoutWatcher = setInterval(() => {
      if (timedOut) return
      const now = Date.now()
      if (now - startedAt >= absoluteTimeoutMs) {
        timedOut = true
        timeoutReason = 'absolute'
        try {
          child.kill()
        } catch {}
        return
      }
      if (now - lastActivityAt >= timeoutMs) {
        timedOut = true
        timeoutReason = 'idle'
        try {
          child.kill()
        } catch {}
      }
    }, 1000)

    child.stdout?.on('data', (chunk) => {
      const text = String(chunk || '')
      if (!text) return
      lastActivityAt = Date.now()
      stdoutText += text
      if (stdoutText.length > 4000) {
        stdoutText = stdoutText.slice(-4000)
      }
      try {
        options?.onStdoutChunk?.(text)
      } catch {}
    })
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk || '')
      if (!text) return
      lastActivityAt = Date.now()
      stderrText += text
      if (stderrText.length > 6000) {
        stderrText = stderrText.slice(-6000)
      }
      try {
        options?.onStderrChunk?.(text)
      } catch {}
    })
    child.on('error', (error) => {
      clearInterval(timeoutWatcher)
      clearInterval(progressTimer)
      reject(error)
    })
    child.on('exit', (code) => {
      clearInterval(timeoutWatcher)
      clearInterval(progressTimer)
      if (timedOut) {
        const output = normalizeText(`${stderrText}\n${stdoutText}`, 3000)
        const timeoutText =
          timeoutReason === 'idle'
            ? `分离超时（空闲 ${Math.round(timeoutMs / 1000)} 秒）`
            : `分离超时（总时长 ${Math.round(absoluteTimeoutMs / 1000)} 秒）`
        reject(
          createStemError('STEM_SPLIT_TIMEOUT', `${timeoutText}${output ? `: ${output}` : ''}`)
        )
        return
      }
      if (code === 0) {
        log.info(`[${traceLabel}] process done`, {
          elapsedMs: Date.now() - startedAt
        })
        resolve()
        return
      }
      const output = normalizeText(`${stderrText}\n${stdoutText}`, 3000)
      reject(
        createStemError(
          'STEM_SPLIT_FAILED',
          `Demucs 进程退出码 ${code ?? -1}${output ? `: ${output}` : ''}`
        )
      )
    })
  })
}

export const resolveBundledFfprobePath = () => {
  const ffmpegPath = resolveBundledFfmpegPath()
  const ffprobeName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  return path.join(path.dirname(ffmpegPath), ffprobeName)
}

export const runProbeProcess = async (params: {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  maxStdoutLen?: number
  maxStderrLen?: number
}) =>
  await new Promise<{
    status: number | null
    stdout: string
    stderr: string
    timedOut: boolean
    error?: string
  }>((resolve) => {
    let stdoutText = ''
    let stderrText = ''
    let finished = false
    let timedOut = false
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null
    const maxStdoutLen = Math.max(256, Number(params.maxStdoutLen) || 6000)
    const maxStderrLen = Math.max(256, Number(params.maxStderrLen) || 6000)
    const finalize = (status: number | null, error?: string) => {
      if (finished) return
      finished = true
      if (timeoutTimer) {
        clearTimeout(timeoutTimer)
      }
      resolve({
        status,
        stdout: stdoutText,
        stderr: stderrText,
        timedOut,
        error: normalizeText(error, 800) || undefined
      })
    }
    let child: childProcess.ChildProcessWithoutNullStreams
    try {
      child = childProcess.spawn(params.command, params.args, {
        windowsHide: true,
        env: params.env
      })
    } catch (error) {
      finalize(null, error instanceof Error ? error.message : String(error || 'spawn failed'))
      return
    }
    timeoutTimer = setTimeout(
      () => {
        timedOut = true
        try {
          child.kill()
        } catch {}
      },
      Math.max(1000, Number(params.timeoutMs) || 10_000)
    )
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const text = String(chunk || '')
      if (!text) return
      stdoutText += text
      if (stdoutText.length > maxStdoutLen) {
        stdoutText = stdoutText.slice(-maxStdoutLen)
      }
    })
    child.stderr.on('data', (chunk: string) => {
      const text = String(chunk || '')
      if (!text) return
      stderrText += text
      if (stderrText.length > maxStderrLen) {
        stderrText = stderrText.slice(-maxStderrLen)
      }
    })
    child.on('error', (error) => {
      finalize(null, error instanceof Error ? error.message : String(error || 'process error'))
    })
    child.on('close', (code) => {
      finalize(typeof code === 'number' ? code : null)
    })
  })

export const probeAudioDurationSeconds = async (
  ffprobePath: string,
  filePath: string
): Promise<number | null> => {
  if (!ffprobePath || !filePath) return null
  if (!fs.existsSync(ffprobePath)) return null
  try {
    const result = await runProbeProcess({
      command: ffprobePath,
      args: [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=nokey=1:noprint_wrappers=1',
        filePath
      ],
      timeoutMs: STEM_FFPROBE_TIMEOUT_MS,
      maxStdoutLen: 256,
      maxStderrLen: 256
    })
    if (result.status !== 0 || result.timedOut) return null
    const output = normalizeText(result.stdout, 120) || ''
    const seconds = Number(output)
    if (!Number.isFinite(seconds) || seconds <= 0) return null
    return seconds
  } catch {
    return null
  }
}

export const buildStemProcessEnv = (runtimeDir: string, ffmpegPath: string): NodeJS.ProcessEnv => {
  const ffmpegDir = path.dirname(ffmpegPath)
  const pathEntries =
    process.platform === 'win32'
      ? [path.join(runtimeDir, 'Scripts'), path.join(runtimeDir, 'Library', 'bin'), ffmpegDir]
      : [path.join(runtimeDir, 'bin'), ffmpegDir]
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [...pathEntries, process.env.PATH || ''].filter(Boolean).join(path.delimiter),
    PYTHONIOENCODING: 'utf-8'
  }
  if (process.platform === 'linux') {
    env.LD_LIBRARY_PATH = [path.join(runtimeDir, 'lib'), process.env.LD_LIBRARY_PATH || '']
      .filter(Boolean)
      .join(path.delimiter)
  } else if (process.platform === 'darwin') {
    env.DYLD_LIBRARY_PATH = [path.join(runtimeDir, 'lib'), process.env.DYLD_LIBRARY_PATH || '']
      .filter(Boolean)
      .join(path.delimiter)
  }
  return env
}

export const resolveStemDevicePriority = (): MixtapeStemComputeDevice[] => {
  if (process.platform === 'darwin') {
    return ['mps', 'cuda', 'cpu']
  }
  if (process.platform === 'win32') {
    return ['cuda', 'xpu', 'directml', 'cpu']
  }
  return ['cuda', 'xpu', 'mps', 'cpu']
}
