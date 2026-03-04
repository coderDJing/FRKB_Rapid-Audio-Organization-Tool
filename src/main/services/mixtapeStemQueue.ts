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
  resolveBundledDemucsOnnxPath,
  resolveBundledDemucsPythonPath,
  resolveBundledDemucsRuntimeCandidates,
  resolveBundledDemucsRuntimeDir,
  type BundledDemucsRuntimeCandidate
} from '../demucs'
import {
  DEFAULT_MIXTAPE_STEM_BASE_MODEL,
  DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE,
  normalizeMixtapeStemProfile,
  parseMixtapeStemModel,
  resolveMixtapeStemBaseModelByProfile,
  resolveMixtapeStemModelByProfile,
  type MixtapeStemProfile
} from '../../shared/mixtapeStemProfiles'
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

const STEM_GPU_JOB_CONCURRENCY_MIN = 1
const STEM_GPU_JOB_CONCURRENCY_MAX = 3
const STEM_GPU_JOB_CONCURRENCY_DIRECTML_MAX = 3
const STEM_ONNX_DIRECTML_CONCURRENCY_WARMUP_SUCCESS = 3
const STEM_ONNX_DIRECTML_CONCURRENCY_HIGH_SUCCESS = 12
const STEM_SYSTEM_MEMORY_GB_FOR_GPU_CONCURRENCY_2 = 16
const STEM_SYSTEM_MEMORY_GB_FOR_GPU_CONCURRENCY_3 = 24
const STEM_FREE_MEMORY_GB_FOR_GPU_CONCURRENCY_2 = 5
const STEM_FREE_MEMORY_GB_FOR_GPU_CONCURRENCY_3 = 8
const STEM_CPU_JOB_CONCURRENCY_MAX = 4
const STEM_CPU_JOB_CORE_DIVISOR = 2
const STEM_PROCESS_TIMEOUT_MS = 60 * 60 * 1000
const STEM_PROCESS_TIMEOUT_MAX_MS = 2 * 60 * 60 * 1000
const STEM_CPU_PROCESS_TIMEOUT_CAP_MS = 8 * 60 * 1000
const STEM_GPU_PROCESS_TIMEOUT_CAP_MS = STEM_PROCESS_TIMEOUT_MS
const STEM_CPU_PROCESS_TIMEOUT_MIN_MS = 4 * 60 * 1000
const STEM_GPU_PROCESS_TIMEOUT_MIN_MS = 3 * 60 * 1000
const STEM_FFPROBE_TIMEOUT_MS = 20_000
const STEM_DEVICE_PROBE_TIMEOUT_MS = 15_000
const STEM_DEVICE_COMPATIBILITY_TIMEOUT_MS = 12_000
const STEM_DEVICE_PROBE_CACHE_TTL_MS = 5 * 60 * 1000
const STEM_WINDOWS_GPU_ADAPTER_PROBE_TIMEOUT_MS = 6_000
const ONNX_DIRECTML_FAILURE_COOLDOWN_MS = 30 * 60 * 1000
const STEM_RUNTIME_STATE_FILE_NAME = 'mixtape-stem-runtime-state-v1.json'
const DEMUCS_NO_SPLIT_MAX_DURATION_SECONDS = 7 * 60
const DEMUCS_HTDEMUCS_MAX_SEGMENT_SECONDS = 7.8
const DEMUCS_PROFILE_OPTIONS: Record<
  MixtapeStemProfile,
  { shifts: string; overlap: string; segmentSec: string }
> = {
  fast: {
    shifts: '0',
    overlap: '0.1',
    segmentSec: '7'
  },
  quality: {
    shifts: '1',
    overlap: '0.25',
    segmentSec: '11'
  }
}
const ONNX_FAST_SCRIPT_FILE_NAME = 'fast_separate.py'
const ONNX_FAST_MODEL_FILE_NAME = 'htdemucs_6s.onnx'
const ONNX_FAST_PROGRESS_PREFIX = 'FRKB_ONNX_PROGRESS='
const ONNX_FAST_RESULT_PREFIX = 'FRKB_ONNX_RESULT='
const DEFAULT_STEM_MODEL = resolveMixtapeStemModelByProfile(DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE)
const DEFAULT_STEM_VERSION = 'demucs-cli-builtin-20260227'
const STEM_CACHE_DIR_NAME = 'stems'

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
  listRoot: string
  targets: Map<string, Set<string>>
}

type MixtapeStemSeparationResult = {
  vocalPath?: string | null
  instPath?: string | null
  bassPath?: string | null
  drumsPath?: string | null
}

type MixtapeStemComputeDevice = 'cuda' | 'mps' | 'xpu' | 'directml' | 'cpu'
type MixtapeStemCpuFallbackReasonCode = 'gpu_unavailable' | 'gpu_failed' | 'gpu_backend_missing'
type MixtapeStemRuntimeProgress = {
  device: MixtapeStemComputeDevice
  percent: number
  processedSec: number | null
  totalSec: number | null
  etaSec: number | null
}

type MixtapeStemOnnxProvider = 'directml' | 'cpu'

type MixtapeStemOnnxProgressPayload = {
  percent?: unknown
  provider?: unknown
  chunkIndex?: unknown
  totalChunks?: unknown
}

type MixtapeStemOnnxResultPayload = {
  provider?: unknown
  vocalPath?: unknown
  instPath?: unknown
  bassPath?: unknown
  drumsPath?: unknown
}

type MixtapeStemOnnxRuntimeProbeEntry = {
  runtimeKey: string
  runtimeDir: string
  pythonPath: string
  providerNames: string[]
  providerCandidates: MixtapeStemOnnxProvider[]
  probeError: string
}

type MixtapeStemOnnxRuntimeProbeSnapshot = {
  checkedAt: number
  runtimeKey: string
  runtimeDir: string
  pythonPath: string
  providerCandidates: MixtapeStemOnnxProvider[]
  runtimeCandidates: Array<{
    runtimeKey: string
    providerNames: string[]
    providerCandidates: MixtapeStemOnnxProvider[]
    probeError: string | null
  }>
}

type MixtapeStemOnnxDirectmlRuntimeStats = {
  successCount: number
  failureCount: number
  consecutiveSuccessCount: number
  lastSuccessAt: number
  lastFailureAt: number
}

type MixtapeStemDeviceProbeSnapshot = {
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

const resolveStemProcessTimeoutMs = (params: {
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

const pendingQueue: MixtapeStemQueueJob[] = []
const pendingJobMap = new Map<string, MixtapeStemQueueJob>()
const inFlightJobMap = new Map<string, MixtapeStemQueueJob>()
let activeWorkers = 0
let stemDeviceProbeSnapshot: MixtapeStemDeviceProbeSnapshot | null = null
let stemDeviceProbePromise: Promise<MixtapeStemDeviceProbeSnapshot> | null = null
let stemOnnxRuntimeProbeSnapshot: MixtapeStemOnnxRuntimeProbeSnapshot | null = null
let stemOnnxRuntimeProbePromise: Promise<MixtapeStemOnnxRuntimeProbeSnapshot> | null = null
let stemOnnxDirectmlFailureAt = 0
let stemOnnxDirectmlFailureReason = ''
let stemOnnxDirectmlAttemptGate: Promise<void> | null = null
let stemOnnxDirectmlAttemptGateResolve: (() => void) | null = null
let stemOnnxDirectmlRuntimeStats: MixtapeStemOnnxDirectmlRuntimeStats = {
  successCount: 0,
  failureCount: 0,
  consecutiveSuccessCount: 0,
  lastSuccessAt: 0,
  lastFailureAt: 0
}
let stemRuntimeStateLoaded = false
let stemRuntimeStatePersistTimer: NodeJS.Timeout | null = null
let stemRuntimeStatePersisting = false
let stemQueueConcurrencySnapshot = 0
const cpuSlowHintNotifiedPlaylistIdSet = new Set<string>()

const normalizeStemMode = (_value: unknown): MixtapeStemMode => '4stems'

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

const normalizeNonNegativeInt = (value: unknown): number => {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return parsed
}

const normalizePositiveTimestamp = (value: unknown): number => {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return parsed
}

const resolveStemRuntimeStateFilePath = (): string => {
  try {
    const userDataDir = app.getPath('userData')
    if (!userDataDir) return ''
    return path.join(userDataDir, 'cache', STEM_RUNTIME_STATE_FILE_NAME)
  } catch {
    return ''
  }
}

const schedulePersistStemRuntimeState = () => {
  if (stemRuntimeStatePersistTimer) return
  stemRuntimeStatePersistTimer = setTimeout(() => {
    stemRuntimeStatePersistTimer = null
    void persistStemRuntimeState()
  }, 800)
}

const persistStemRuntimeState = async () => {
  if (stemRuntimeStatePersisting) return
  stemRuntimeStatePersisting = true
  try {
    const filePath = resolveStemRuntimeStateFilePath()
    if (!filePath) return
    const payload = {
      version: 1,
      updatedAt: Date.now(),
      onnxDirectmlFailureAt: stemOnnxDirectmlFailureAt,
      onnxDirectmlFailureReason: stemOnnxDirectmlFailureReason || '',
      onnxDirectmlRuntimeStats: {
        successCount: Math.max(0, stemOnnxDirectmlRuntimeStats.successCount || 0),
        failureCount: Math.max(0, stemOnnxDirectmlRuntimeStats.failureCount || 0),
        consecutiveSuccessCount: Math.max(
          0,
          stemOnnxDirectmlRuntimeStats.consecutiveSuccessCount || 0
        ),
        lastSuccessAt: Math.max(0, stemOnnxDirectmlRuntimeStats.lastSuccessAt || 0),
        lastFailureAt: Math.max(0, stemOnnxDirectmlRuntimeStats.lastFailureAt || 0)
      }
    }
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
    await fs.promises.writeFile(filePath, JSON.stringify(payload), 'utf8')
  } catch (error) {
    log.warn('[mixtape-stem] persist runtime state failed', {
      error: normalizeText(error instanceof Error ? error.message : String(error || ''), 500)
    })
  } finally {
    stemRuntimeStatePersisting = false
  }
}

const loadStemRuntimeStateOnce = () => {
  if (stemRuntimeStateLoaded) return
  stemRuntimeStateLoaded = true
  try {
    const filePath = resolveStemRuntimeStateFilePath()
    if (!filePath || !fs.existsSync(filePath)) return
    const raw = fs.readFileSync(filePath, 'utf8')
    if (!raw) return
    const parsed = JSON.parse(raw) as {
      onnxDirectmlFailureAt?: unknown
      onnxDirectmlFailureReason?: unknown
      onnxDirectmlRuntimeStats?: {
        successCount?: unknown
        failureCount?: unknown
        consecutiveSuccessCount?: unknown
        lastSuccessAt?: unknown
        lastFailureAt?: unknown
      }
    }
    stemOnnxDirectmlFailureAt = normalizePositiveTimestamp(parsed?.onnxDirectmlFailureAt)
    stemOnnxDirectmlFailureReason = normalizeText(parsed?.onnxDirectmlFailureReason, 600)
    const stats = parsed?.onnxDirectmlRuntimeStats || {}
    stemOnnxDirectmlRuntimeStats = {
      successCount: normalizeNonNegativeInt(stats.successCount),
      failureCount: normalizeNonNegativeInt(stats.failureCount),
      consecutiveSuccessCount: normalizeNonNegativeInt(stats.consecutiveSuccessCount),
      lastSuccessAt: normalizePositiveTimestamp(stats.lastSuccessAt),
      lastFailureAt: normalizePositiveTimestamp(stats.lastFailureAt)
    }
    log.info('[mixtape-stem] loaded runtime state cache', {
      failureAt: stemOnnxDirectmlFailureAt || null,
      failureReason: stemOnnxDirectmlFailureReason || null,
      stats: stemOnnxDirectmlRuntimeStats
    })
  } catch (error) {
    log.warn('[mixtape-stem] load runtime state failed', {
      error: normalizeText(error instanceof Error ? error.message : String(error || ''), 500)
    })
  }
}

const toDemucsSegmentSecArg = (value: number): string => {
  const parsed = Number(value)
  const safeValue = Number.isFinite(parsed) && parsed > 0 ? parsed : 7
  return String(Math.max(1, Math.floor(safeValue)))
}

const resolveDemucsSegmentSec = (params: {
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

const normalizeFilePath = (value: unknown): string => normalizeText(value, 4000)

const normalizePlaylistId = (value: unknown): string => normalizeText(value, 80)

const normalizeStemProfile = (
  value: unknown,
  fallback: MixtapeStemProfile = DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE
): MixtapeStemProfile => normalizeMixtapeStemProfile(normalizeText(value, 24), fallback)

const normalizeModel = (
  value: unknown,
  fallbackProfile: MixtapeStemProfile = DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE
): string => {
  const parsed = parseMixtapeStemModel(normalizeText(value, 128), fallbackProfile)
  return normalizeText(parsed.requestedModel, 128) || DEFAULT_STEM_MODEL
}

const normalizeStemVersion = (value: unknown): string =>
  normalizeText(value, 128) || DEFAULT_STEM_VERSION

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

const isFastStemModel = (model: string): boolean => {
  const parsed = parseMixtapeStemModel(
    normalizeText(model, 128),
    DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE
  )
  const profile = normalizeStemProfile(parsed.profile, DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE)
  return profile === 'fast'
}

const hasFastStemJobInQueue = (): boolean => {
  if (pendingQueue.some((job) => isFastStemModel(job.model))) return true
  for (const job of inFlightJobMap.values()) {
    if (isFastStemModel(job.model)) return true
  }
  return false
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

const createStemError = (code: string, message: string): Error & { code: string } => {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

const toSafePathSegment = (value: string, fallback = 'default') => {
  const cleaned = normalizeText(value, 128)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .trim()
  return cleaned || fallback
}

const buildStemSourceHash = async (filePath: string): Promise<string> => {
  const stat = await fs.promises.stat(filePath)
  const source = [
    normalizePathKey(filePath),
    String(Math.max(0, Number(stat.size) || 0)),
    String(Math.max(0, Math.floor(Number(stat.mtimeMs) || 0)))
  ].join('\n')
  return crypto.createHash('sha1').update(source).digest('hex')
}

const resolveStemCacheDir = async (params: {
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

const resolveDemucsRawStemPath = (params: {
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

const runProcess = async (
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

const resolveBundledFfprobePath = () => {
  const ffmpegPath = resolveBundledFfmpegPath()
  const ffprobeName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  return path.join(path.dirname(ffmpegPath), ffprobeName)
}

const runProbeProcess = async (params: {
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

const probeAudioDurationSeconds = async (
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

const buildStemProcessEnv = (runtimeDir: string, ffmpegPath: string): NodeJS.ProcessEnv => {
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

const resolveStemDevicePriority = (): MixtapeStemComputeDevice[] => {
  if (process.platform === 'darwin') {
    return ['mps', 'cuda', 'cpu']
  }
  if (process.platform === 'win32') {
    return ['cuda', 'xpu', 'directml', 'cpu']
  }
  return ['cuda', 'xpu', 'mps', 'cpu']
}

const probeWindowsGpuAdapters = async () => {
  const emptyResult = {
    names: [] as string[],
    hasIntel: false,
    hasAmd: false,
    hasNvidia: false
  }
  if (process.platform !== 'win32') return emptyResult
  try {
    const result = await runProbeProcess({
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-Command',
        '$ErrorActionPreference="SilentlyContinue"; Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }'
      ],
      timeoutMs: STEM_WINDOWS_GPU_ADAPTER_PROBE_TIMEOUT_MS,
      maxStdoutLen: 3000,
      maxStderrLen: 1500
    })
    const stdoutText = normalizeText(result.stdout, 2400)
    const stderrText = normalizeText(result.stderr, 1200)
    if ((result.status !== 0 || result.timedOut) && !stdoutText) {
      log.warn('[mixtape-stem] windows gpu adapter probe failed', {
        error: result.error || stderrText || `exit=${result.status ?? -1}`
      })
      return emptyResult
    }
    const names = Array.from(
      new Set(
        stdoutText
          .split(/\r?\n/)
          .map((line) => normalizeText(line, 200))
          .filter(Boolean)
      )
    )
    const effectiveNames = names.filter((name) => {
      const lowered = name.toLowerCase()
      if (!lowered) return false
      if (lowered.includes('microsoft basic render')) return false
      if (lowered.includes('microsoft remote display')) return false
      return true
    })
    const hasIntel = effectiveNames.some((name) => {
      const lowered = name.toLowerCase()
      return lowered.includes(' intel') || lowered.startsWith('intel')
    })
    const hasAmd = effectiveNames.some((name) => {
      const lowered = name.toLowerCase()
      return lowered.includes(' amd') || lowered.includes('radeon')
    })
    const hasNvidia = effectiveNames.some((name) => name.toLowerCase().includes('nvidia'))
    return {
      names: effectiveNames,
      hasIntel,
      hasAmd,
      hasNvidia
    }
  } catch (error) {
    log.warn('[mixtape-stem] windows gpu adapter probe exception', {
      error: normalizeText(error instanceof Error ? error.message : String(error || ''), 400)
    })
    return emptyResult
  }
}

const probeTorchDeviceCompatibility = async (params: {
  pythonPath: string
  env: NodeJS.ProcessEnv
  scriptLines: string[]
}) => {
  try {
    const result = await runProbeProcess({
      command: params.pythonPath,
      args: ['-c', params.scriptLines.join('\n')],
      env: params.env,
      timeoutMs: STEM_DEVICE_COMPATIBILITY_TIMEOUT_MS,
      maxStdoutLen: 1000,
      maxStderrLen: 1000
    })
    const stdoutText = normalizeText(result.stdout, 600)
    const stderrText = normalizeText(result.stderr, 600)
    if (result.status === 0 && !result.timedOut) {
      return {
        ok: true,
        error: ''
      }
    }
    return {
      ok: false,
      error: result.error || stderrText || stdoutText || `compatibility exit ${result.status ?? -1}`
    }
  } catch (error) {
    return {
      ok: false,
      error: normalizeText(error instanceof Error ? error.message : String(error || ''), 600)
    }
  }
}

const probeDirectmlDemucsCompatibility = async (params: {
  pythonPath: string
  env: NodeJS.ProcessEnv
  directmlDevice: string
}) => {
  const device = normalizeText(params.directmlDevice, 80) || 'privateuseone:0'
  return await probeTorchDeviceCompatibility({
    pythonPath: params.pythonPath,
    env: params.env,
    scriptLines: [
      'import torch',
      'import torch_directml',
      `device = ${JSON.stringify(device)}`,
      'x = torch.randn(2048, device=device)',
      '_ = torch.fft.rfft(x)',
      'print("ok")'
    ]
  })
}

const probeXpuDemucsCompatibility = async (params: {
  pythonPath: string
  env: NodeJS.ProcessEnv
}) =>
  await probeTorchDeviceCompatibility({
    pythonPath: params.pythonPath,
    env: params.env,
    scriptLines: [
      'import torch',
      'xpu_api = getattr(torch, "xpu", None)',
      'assert xpu_api and xpu_api.is_available()',
      'x = torch.randn(2048, device="xpu")',
      '_ = torch.fft.rfft(x)',
      'print("ok")'
    ]
  })

const probeDemucsDevicesForRuntime = async (params: {
  checkedAt: number
  runtimeCandidate: BundledDemucsRuntimeCandidate
  ffmpegPath: string
  windowsAdapterNames: string[]
  windowsHasIntelAdapter: boolean
  windowsHasAmdAdapter: boolean
  windowsHasNvidiaAdapter: boolean
}): Promise<MixtapeStemDeviceProbeSnapshot> => {
  const priority = resolveStemDevicePriority()
  const env = buildStemProcessEnv(params.runtimeCandidate.runtimeDir, params.ffmpegPath)
  let cudaAvailable = false
  let mpsAvailable = false
  let xpuAvailable = false
  let xpuBackendInstalled = false
  let xpuDemucsCompatible = false
  let directmlAvailable = false
  let directmlBackendInstalled = false
  let directmlDemucsCompatible = false
  let directmlDevice = ''
  let probeError = ''
  try {
    const result = await runProbeProcess({
      command: params.runtimeCandidate.pythonPath,
      args: [
        '-c',
        [
          'import json',
          'payload = {',
          '  "cuda": False,',
          '  "mps": False,',
          '  "xpu": False,',
          '  "xpu_backend_installed": False,',
          '  "directml": False,',
          '  "directml_backend_installed": False,',
          '  "directml_device": "",',
          '  "torch_version": ""',
          '}',
          'try:',
          '  import torch',
          '  torch_version = str(getattr(torch, "__version__", ""))',
          '  payload["torch_version"] = torch_version',
          '  cuda_api = getattr(torch, "cuda", None)',
          '  payload["cuda"] = bool(cuda_api and cuda_api.is_available())',
          '  mps_backend = getattr(getattr(torch, "backends", None), "mps", None)',
          '  payload["mps"] = bool(mps_backend and mps_backend.is_available())',
          '  xpu_api = getattr(torch, "xpu", None)',
          '  xpu_backend_installed = bool(xpu_api) and ("+cpu" not in torch_version.lower())',
          '  payload["xpu_backend_installed"] = xpu_backend_installed',
          '  payload["xpu"] = bool(xpu_backend_installed and xpu_api and xpu_api.is_available())',
          'except Exception as exc:',
          '  payload["error"] = str(exc)',
          'try:',
          '  import torch_directml',
          '  payload["directml_backend_installed"] = True',
          '  try:',
          '    dml_device = torch_directml.device()',
          '    payload["directml"] = bool(dml_device)',
          '    payload["directml_device"] = str(dml_device)',
          '  except Exception as exc:',
          '    payload["directml_error"] = str(exc)',
          'except Exception as exc:',
          '  payload["directml_import_error"] = str(exc)',
          'print(json.dumps(payload))'
        ].join('\n')
      ],
      env,
      timeoutMs: STEM_DEVICE_PROBE_TIMEOUT_MS,
      maxStdoutLen: 2000,
      maxStderrLen: 1600
    })
    const stdoutText = normalizeText(result.stdout, 1200)
    const stderrText = normalizeText(result.stderr, 1200)
    if (result.status === 0 && !result.timedOut && stdoutText) {
      const lines = stdoutText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      const lastLine = lines.at(-1) || ''
      const parsed = JSON.parse(lastLine) as {
        cuda?: unknown
        mps?: unknown
        xpu?: unknown
        xpu_backend_installed?: unknown
        directml?: unknown
        directml_backend_installed?: unknown
        directml_device?: unknown
        error?: unknown
        directml_error?: unknown
        directml_import_error?: unknown
      }
      cudaAvailable = !!parsed?.cuda
      mpsAvailable = !!parsed?.mps
      xpuAvailable = !!parsed?.xpu
      xpuBackendInstalled = !!parsed?.xpu_backend_installed
      directmlAvailable = !!parsed?.directml
      directmlBackendInstalled = !!parsed?.directml_backend_installed
      directmlDevice = normalizeText(parsed?.directml_device, 80)
      probeError = normalizeText(
        parsed?.error || parsed?.directml_error || parsed?.directml_import_error,
        400
      )
      if (xpuAvailable) {
        const xpuCompatibility = await probeXpuDemucsCompatibility({
          pythonPath: params.runtimeCandidate.pythonPath,
          env
        })
        xpuDemucsCompatible = xpuCompatibility.ok
        if (!xpuCompatibility.ok) {
          xpuAvailable = false
          probeError = probeError || normalizeText(xpuCompatibility.error, 400)
        }
      }
      if (directmlAvailable) {
        const directmlCompatibility = await probeDirectmlDemucsCompatibility({
          pythonPath: params.runtimeCandidate.pythonPath,
          env,
          directmlDevice: directmlDevice || 'privateuseone:0'
        })
        directmlDemucsCompatible = directmlCompatibility.ok
        if (!directmlCompatibility.ok) {
          directmlAvailable = false
          probeError = probeError || normalizeText(directmlCompatibility.error, 400)
        }
      }
    } else {
      probeError = result.error || stderrText || stdoutText || `probe exit ${result.status ?? -1}`
    }
  } catch (error) {
    probeError = normalizeText(error instanceof Error ? error.message : String(error || ''), 400)
  }
  const available = new Set<MixtapeStemComputeDevice>(['cpu'])
  if (cudaAvailable) available.add('cuda')
  if (mpsAvailable) available.add('mps')
  if (xpuAvailable) available.add('xpu')
  if (directmlAvailable) available.add('directml')
  const devices = priority.filter((device) => available.has(device))
  if (!devices.includes('cpu')) devices.push('cpu')
  const snapshot: MixtapeStemDeviceProbeSnapshot = {
    checkedAt: params.checkedAt,
    runtimeKey: normalizeText(params.runtimeCandidate.key, 64) || 'runtime',
    runtimeDir: params.runtimeCandidate.runtimeDir,
    pythonPath: params.runtimeCandidate.pythonPath,
    devices,
    cudaAvailable,
    mpsAvailable,
    xpuAvailable,
    xpuBackendInstalled,
    xpuDemucsCompatible,
    anyXpuBackendInstalled: xpuBackendInstalled,
    directmlAvailable,
    directmlBackendInstalled,
    directmlDemucsCompatible,
    anyDirectmlBackendInstalled: directmlBackendInstalled,
    directmlDevice: directmlDevice || 'privateuseone:0',
    windowsAdapterNames: params.windowsAdapterNames,
    windowsHasIntelAdapter: params.windowsHasIntelAdapter,
    windowsHasAmdAdapter: params.windowsHasAmdAdapter,
    windowsHasNvidiaAdapter: params.windowsHasNvidiaAdapter
  }
  log.info('[mixtape-stem] demucs runtime probe', {
    runtimeKey: snapshot.runtimeKey,
    runtimeDir: snapshot.runtimeDir,
    pythonPath: snapshot.pythonPath,
    devices: snapshot.devices,
    cudaAvailable,
    mpsAvailable,
    xpuAvailable,
    xpuBackendInstalled,
    xpuDemucsCompatible,
    directmlAvailable,
    directmlBackendInstalled,
    directmlDemucsCompatible,
    directmlDevice: snapshot.directmlDevice,
    probeError: probeError || null
  })
  return snapshot
}

const resolveProbeSnapshotDeviceScore = (snapshot: MixtapeStemDeviceProbeSnapshot): number => {
  const priority = resolveStemDevicePriority()
  const targetDevice = snapshot.devices.find((device) => device !== 'cpu') || 'cpu'
  const score = priority.findIndex((device) => device === targetDevice)
  if (score >= 0) return score
  return Number.MAX_SAFE_INTEGER
}

const resolveProbeSnapshotTieBreakScore = (snapshot: MixtapeStemDeviceProbeSnapshot): number => {
  const hasNonCpuDevice = snapshot.devices.some((device) => device !== 'cpu')
  if (hasNonCpuDevice) return 0
  const runtimeKey = normalizeText(snapshot.runtimeKey, 64).toLowerCase()
  if (runtimeKey.includes('cpu')) return 0
  if (runtimeKey === 'runtime') return 1
  return 2
}

const probeDemucsDevices = async (ffmpegPath: string): Promise<MixtapeStemDeviceProbeSnapshot> => {
  const now = Date.now()
  if (
    stemDeviceProbeSnapshot &&
    now - stemDeviceProbeSnapshot.checkedAt <= STEM_DEVICE_PROBE_CACHE_TTL_MS
  ) {
    return stemDeviceProbeSnapshot
  }
  if (stemDeviceProbePromise) return await stemDeviceProbePromise
  stemDeviceProbePromise = (async () => {
    const windowsAdapterProbe = await probeWindowsGpuAdapters()
    const runtimeCandidates = resolveBundledDemucsRuntimeCandidates()
    const runtimeSnapshots: MixtapeStemDeviceProbeSnapshot[] = []
    for (const runtimeCandidate of runtimeCandidates) {
      if (!runtimeCandidate.runtimeDir || !runtimeCandidate.pythonPath) continue
      if (!fs.existsSync(runtimeCandidate.pythonPath)) continue
      const runtimeSnapshot = await probeDemucsDevicesForRuntime({
        checkedAt: now,
        runtimeCandidate,
        ffmpegPath,
        windowsAdapterNames: windowsAdapterProbe.names,
        windowsHasIntelAdapter: windowsAdapterProbe.hasIntel,
        windowsHasAmdAdapter: windowsAdapterProbe.hasAmd,
        windowsHasNvidiaAdapter: windowsAdapterProbe.hasNvidia
      })
      runtimeSnapshots.push(runtimeSnapshot)
    }
    const fallbackCandidate: BundledDemucsRuntimeCandidate = {
      key: 'runtime',
      runtimeDir: resolveBundledDemucsRuntimeDir(),
      pythonPath: resolveBundledDemucsPythonPath(resolveBundledDemucsRuntimeDir())
    }
    const selectedRuntimeSnapshot = runtimeSnapshots.reduce<MixtapeStemDeviceProbeSnapshot | null>(
      (best, current) => {
        if (!best) return current
        const bestScore = resolveProbeSnapshotDeviceScore(best)
        const currentScore = resolveProbeSnapshotDeviceScore(current)
        if (currentScore < bestScore) return current
        if (currentScore > bestScore) return best
        const bestNonCpuCount = best.devices.filter((device) => device !== 'cpu').length
        const currentNonCpuCount = current.devices.filter((device) => device !== 'cpu').length
        if (currentNonCpuCount > bestNonCpuCount) return current
        if (currentNonCpuCount < bestNonCpuCount) return best
        const bestTieBreakScore = resolveProbeSnapshotTieBreakScore(best)
        const currentTieBreakScore = resolveProbeSnapshotTieBreakScore(current)
        if (currentTieBreakScore < bestTieBreakScore) return current
        return best
      },
      null
    ) || {
      checkedAt: now,
      runtimeKey: fallbackCandidate.key,
      runtimeDir: fallbackCandidate.runtimeDir,
      pythonPath: fallbackCandidate.pythonPath,
      devices: ['cpu'],
      cudaAvailable: false,
      mpsAvailable: false,
      xpuAvailable: false,
      xpuBackendInstalled: false,
      xpuDemucsCompatible: false,
      anyXpuBackendInstalled: false,
      directmlAvailable: false,
      directmlBackendInstalled: false,
      directmlDemucsCompatible: false,
      anyDirectmlBackendInstalled: false,
      directmlDevice: 'privateuseone:0',
      windowsAdapterNames: windowsAdapterProbe.names,
      windowsHasIntelAdapter: windowsAdapterProbe.hasIntel,
      windowsHasAmdAdapter: windowsAdapterProbe.hasAmd,
      windowsHasNvidiaAdapter: windowsAdapterProbe.hasNvidia
    }
    const anyXpuBackendInstalled =
      runtimeSnapshots.some((item) => item.xpuBackendInstalled) ||
      selectedRuntimeSnapshot.xpuBackendInstalled
    const anyDirectmlBackendInstalled =
      runtimeSnapshots.some((item) => item.directmlBackendInstalled) ||
      selectedRuntimeSnapshot.directmlBackendInstalled
    const snapshot: MixtapeStemDeviceProbeSnapshot = {
      ...selectedRuntimeSnapshot,
      checkedAt: now,
      anyXpuBackendInstalled,
      anyDirectmlBackendInstalled
    }
    stemDeviceProbeSnapshot = snapshot
    log.info('[mixtape-stem] demucs runtime selected', {
      runtimeKey: snapshot.runtimeKey,
      runtimeDir: snapshot.runtimeDir,
      pythonPath: snapshot.pythonPath,
      devices: snapshot.devices,
      runtimeCandidates: runtimeSnapshots.map((item) => ({
        runtimeKey: item.runtimeKey,
        devices: item.devices,
        xpuDemucsCompatible: item.xpuDemucsCompatible,
        directmlDemucsCompatible: item.directmlDemucsCompatible
      })),
      anyXpuBackendInstalled,
      anyDirectmlBackendInstalled,
      windowsAdapterNames: snapshot.windowsAdapterNames,
      windowsHasIntelAdapter: snapshot.windowsHasIntelAdapter,
      windowsHasAmdAdapter: snapshot.windowsHasAmdAdapter,
      windowsHasNvidiaAdapter: snapshot.windowsHasNvidiaAdapter
    })
    return snapshot
  })().finally(() => {
    stemDeviceProbePromise = null
  })
  return await stemDeviceProbePromise
}

const resolveOnnxProviderCandidatesFromNames = (
  providerNames: string[]
): MixtapeStemOnnxProvider[] => {
  const normalizedNames = providerNames
    .map((name) => normalizeText(name, 80).toLowerCase())
    .filter(Boolean)
  const providers: MixtapeStemOnnxProvider[] = []
  if (normalizedNames.some((name) => name.includes('dml') || name.includes('directml'))) {
    providers.push('directml')
  }
  if (normalizedNames.some((name) => name.includes('cpu'))) {
    providers.push('cpu')
  }
  return Array.from(new Set(providers))
}

const probeOnnxRuntimeForRuntime = async (params: {
  runtimeCandidate: BundledDemucsRuntimeCandidate
  ffmpegPath: string
  onnxModelPath: string
}): Promise<MixtapeStemOnnxRuntimeProbeEntry> => {
  const runtimeKey = normalizeText(params.runtimeCandidate.key, 64) || 'runtime'
  const runtimeDir = normalizeFilePath(params.runtimeCandidate.runtimeDir)
  const pythonPath = normalizeFilePath(params.runtimeCandidate.pythonPath)
  const env = buildStemProcessEnv(runtimeDir, params.ffmpegPath)
  let providerNames: string[] = []
  let probeError = ''
  try {
    const result = await runProbeProcess({
      command: pythonPath,
      args: [
        '-c',
        [
          'import json',
          `onnx_model_path = ${JSON.stringify(normalizeFilePath(params.onnxModelPath))}`,
          'payload = {"providers": []}',
          'try:',
          '  import onnxruntime as ort',
          '  payload["providers"] = [str(item) for item in ort.get_available_providers()]',
          '  if "DmlExecutionProvider" in payload["providers"] and onnx_model_path:',
          '    try:',
          '      sess_opt = ort.SessionOptions()',
          '      sess_opt.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL',
          '      sess_opt.enable_mem_pattern = False',
          '      sess = ort.InferenceSession(',
          '        onnx_model_path,',
          '        sess_options=sess_opt,',
          '        providers=["DmlExecutionProvider", "CPUExecutionProvider"]',
          '      )',
          '      active = sess.get_providers()[0] if sess.get_providers() else ""',
          '      payload["directml_session_provider"] = str(active)',
          '      payload["directml_session_ok"] = active == "DmlExecutionProvider"',
          '      if not payload["directml_session_ok"]:',
          '        payload["directml_session_error"] = f"active provider: {active}"',
          '    except Exception as dml_exc:',
          '      payload["directml_session_ok"] = False',
          '      payload["directml_session_error"] = str(dml_exc)',
          'except Exception as exc:',
          '  payload["error"] = str(exc)',
          'print(json.dumps(payload))'
        ].join('\n')
      ],
      env,
      timeoutMs: STEM_DEVICE_PROBE_TIMEOUT_MS,
      maxStdoutLen: 2000,
      maxStderrLen: 1200
    })
    const stdoutText = normalizeText(result.stdout, 1400)
    const stderrText = normalizeText(result.stderr, 800)
    if (result.status === 0 && !result.timedOut && stdoutText) {
      const lines = stdoutText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      const lastLine = lines.at(-1) || ''
      const parsed = JSON.parse(lastLine) as {
        providers?: unknown
        error?: unknown
        directml_session_ok?: unknown
        directml_session_error?: unknown
      }
      providerNames = Array.isArray(parsed.providers)
        ? parsed.providers.map((item) => normalizeText(item, 80)).filter(Boolean)
        : []
      probeError = normalizeText(parsed.error || parsed.directml_session_error, 400)
      const directmlSessionOk = parsed.directml_session_ok !== false
      if (
        providerNames.some(
          (name) =>
            normalizeText(name, 80).toLowerCase().includes('dml') ||
            normalizeText(name, 80).toLowerCase().includes('directml')
        ) &&
        !directmlSessionOk
      ) {
        providerNames = providerNames.filter((name) => {
          const normalized = normalizeText(name, 80).toLowerCase()
          return !normalized.includes('dml') && !normalized.includes('directml')
        })
      }
    } else {
      probeError = result.error || stderrText || stdoutText || `probe exit ${result.status ?? -1}`
    }
  } catch (error) {
    probeError = normalizeText(error instanceof Error ? error.message : String(error || ''), 400)
  }
  const providerCandidates = resolveOnnxProviderCandidatesFromNames(providerNames)
  const entry: MixtapeStemOnnxRuntimeProbeEntry = {
    runtimeKey,
    runtimeDir,
    pythonPath,
    providerNames,
    providerCandidates,
    probeError
  }
  log.info('[mixtape-stem] onnx runtime probe', {
    runtimeKey: entry.runtimeKey,
    runtimeDir: entry.runtimeDir,
    pythonPath: entry.pythonPath,
    providers: entry.providerNames,
    providerCandidates: entry.providerCandidates,
    probeError: entry.probeError || null
  })
  return entry
}

const resolveOnnxRuntimeProbeScore = (entry: MixtapeStemOnnxRuntimeProbeEntry): number => {
  const hasDirectml = entry.providerCandidates.includes('directml')
  const hasCpu = entry.providerCandidates.includes('cpu')
  const runtimeKey = normalizeText(entry.runtimeKey, 64).toLowerCase()
  if (process.platform === 'win32') {
    if (hasDirectml && runtimeKey.includes('directml')) return 0
    if (hasDirectml) return 1
    if (hasCpu && runtimeKey.includes('cpu')) return 10
    if (hasCpu) return 11
    return 30
  }
  if (hasCpu && runtimeKey.includes('cpu')) return 0
  if (hasCpu) return 1
  return 20
}

const probeOnnxRuntime = async (
  ffmpegPath: string
): Promise<MixtapeStemOnnxRuntimeProbeSnapshot> => {
  const now = Date.now()
  if (
    stemOnnxRuntimeProbeSnapshot &&
    now - stemOnnxRuntimeProbeSnapshot.checkedAt <= STEM_DEVICE_PROBE_CACHE_TTL_MS
  ) {
    return stemOnnxRuntimeProbeSnapshot
  }
  if (stemOnnxRuntimeProbePromise) return await stemOnnxRuntimeProbePromise
  stemOnnxRuntimeProbePromise = (async () => {
    const runtimeCandidates = resolveBundledDemucsRuntimeCandidates()
    const onnxModelPath = path.join(resolveBundledDemucsOnnxPath(), ONNX_FAST_MODEL_FILE_NAME)
    const runtimeSnapshots: MixtapeStemOnnxRuntimeProbeEntry[] = []
    for (const runtimeCandidate of runtimeCandidates) {
      if (!runtimeCandidate.runtimeDir || !runtimeCandidate.pythonPath) continue
      if (!fs.existsSync(runtimeCandidate.pythonPath)) continue
      const runtimeSnapshot = await probeOnnxRuntimeForRuntime({
        runtimeCandidate,
        ffmpegPath,
        onnxModelPath
      })
      runtimeSnapshots.push(runtimeSnapshot)
    }
    const fallbackCandidate: BundledDemucsRuntimeCandidate = {
      key: 'runtime',
      runtimeDir: resolveBundledDemucsRuntimeDir(),
      pythonPath: resolveBundledDemucsPythonPath(resolveBundledDemucsRuntimeDir())
    }
    const selectedRuntime = runtimeSnapshots.reduce<MixtapeStemOnnxRuntimeProbeEntry | null>(
      (best, current) => {
        if (!best) return current
        const bestScore = resolveOnnxRuntimeProbeScore(best)
        const currentScore = resolveOnnxRuntimeProbeScore(current)
        if (currentScore < bestScore) return current
        if (currentScore > bestScore) return best
        return best
      },
      null
    ) || {
      runtimeKey: fallbackCandidate.key,
      runtimeDir: fallbackCandidate.runtimeDir,
      pythonPath: fallbackCandidate.pythonPath,
      providerNames: [],
      providerCandidates: ['cpu' as MixtapeStemOnnxProvider],
      probeError: ''
    }
    const providerCandidates: MixtapeStemOnnxProvider[] = selectedRuntime.providerCandidates.length
      ? selectedRuntime.providerCandidates
      : ['cpu']
    const suppressDirectmlByFailure = shouldSuppressOnnxDirectmlByRecentFailure()
    const finalProviderCandidates: MixtapeStemOnnxProvider[] = suppressDirectmlByFailure
      ? providerCandidates.filter(
          (provider): provider is MixtapeStemOnnxProvider => provider !== 'directml'
        )
      : providerCandidates
    const selectedProviderCandidates: MixtapeStemOnnxProvider[] = finalProviderCandidates.length
      ? finalProviderCandidates
      : ['cpu']
    const snapshot: MixtapeStemOnnxRuntimeProbeSnapshot = {
      checkedAt: now,
      runtimeKey: selectedRuntime.runtimeKey,
      runtimeDir: selectedRuntime.runtimeDir,
      pythonPath: selectedRuntime.pythonPath,
      providerCandidates: selectedProviderCandidates,
      runtimeCandidates: runtimeSnapshots.map((item) => ({
        runtimeKey: item.runtimeKey,
        providerNames: item.providerNames,
        providerCandidates: item.providerCandidates,
        probeError: item.probeError || null
      }))
    }
    stemOnnxRuntimeProbeSnapshot = snapshot
    if (suppressDirectmlByFailure) {
      log.info('[mixtape-stem] onnx directml suppressed by recent runtime failure', {
        runtimeKey: snapshot.runtimeKey,
        cooldownMs: ONNX_DIRECTML_FAILURE_COOLDOWN_MS,
        failureReason: stemOnnxDirectmlFailureReason || null
      })
    }
    try {
      runQueueLoop()
    } catch {}
    log.info('[mixtape-stem] onnx runtime selected', {
      runtimeKey: snapshot.runtimeKey,
      runtimeDir: snapshot.runtimeDir,
      pythonPath: snapshot.pythonPath,
      providerCandidates: snapshot.providerCandidates,
      runtimeCandidates: snapshot.runtimeCandidates.map((item) => ({
        runtimeKey: item.runtimeKey,
        providerNames: item.providerNames,
        providerCandidates: item.providerCandidates,
        probeError: item.probeError
      }))
    })
    return snapshot
  })().finally(() => {
    stemOnnxRuntimeProbePromise = null
  })
  return await stemOnnxRuntimeProbePromise
}

const resolveCpuFallbackReason = (params: {
  deviceSnapshot: MixtapeStemDeviceProbeSnapshot
  firstFailure: {
    device: MixtapeStemComputeDevice
    errorCode: string
    errorMessage: string
  } | null
}): { reasonCode: MixtapeStemCpuFallbackReasonCode; reasonDetail: string } => {
  const firstFailure = params.firstFailure
  if (firstFailure) {
    return {
      reasonCode: 'gpu_failed',
      reasonDetail: [firstFailure.device, firstFailure.errorCode, firstFailure.errorMessage]
        .filter(Boolean)
        .join(' | ')
    }
  }
  const snapshot = params.deviceSnapshot
  const mayNeedAmdIntelBackend =
    process.platform === 'win32' &&
    (snapshot.windowsHasAmdAdapter || snapshot.windowsHasIntelAdapter) &&
    !snapshot.windowsHasNvidiaAdapter &&
    !snapshot.cudaAvailable &&
    !snapshot.xpuAvailable &&
    !snapshot.directmlAvailable &&
    !snapshot.anyXpuBackendInstalled &&
    !snapshot.anyDirectmlBackendInstalled
  if (mayNeedAmdIntelBackend) {
    const adapterNames = snapshot.windowsAdapterNames.join(',')
    return {
      reasonCode: 'gpu_backend_missing',
      reasonDetail: `adapters=${adapterNames || 'unknown'}`
    }
  }
  return {
    reasonCode: 'gpu_unavailable',
    reasonDetail: `detected-devices=${snapshot.devices.join(',')}`
  }
}

const resolveDemucsDeviceArg = (
  device: MixtapeStemComputeDevice,
  deviceSnapshot: MixtapeStemDeviceProbeSnapshot
) => {
  if (device === 'directml') {
    return normalizeText(deviceSnapshot.directmlDevice, 80) || 'privateuseone:0'
  }
  if (device === 'xpu') return 'xpu'
  if (device === 'mps') return 'mps'
  if (device === 'cuda') return 'cuda'
  return 'cpu'
}

const parseClockTokenToSeconds = (token: string): number | null => {
  const value = normalizeText(token, 20)
  if (!value) return null
  const chunks = value
    .split(':')
    .map((part) => normalizeNumberOrNull(part))
    .filter((part): part is number => part !== null)
  if (!chunks.length) return null
  if (chunks.length === 1) {
    return chunks[0] >= 0 ? chunks[0] : null
  }
  if (chunks.length === 2) {
    const [minutes, seconds] = chunks
    if (minutes < 0 || seconds < 0) return null
    return minutes * 60 + seconds
  }
  const [hours, minutes, seconds] = chunks.slice(-3)
  if (hours < 0 || minutes < 0 || seconds < 0) return null
  return hours * 3600 + minutes * 60 + seconds
}

const parseDemucsProgressText = (
  text: string
): {
  percent: number
  processedSec: number | null
  totalSec: number | null
  etaSec: number | null
} | null => {
  const normalized = normalizeText(text, 600)
  if (!normalized) return null
  let percent: number | null = null
  const percentMatch = normalized.match(/(\d{1,3})%\|/)
  if (percentMatch) {
    const parsed = normalizeNumberOrNull(percentMatch[1])
    if (parsed !== null) {
      percent = Math.max(0, Math.min(100, Math.round(parsed)))
    }
  }
  let processedSec: number | null = null
  let totalSec: number | null = null
  const durationMatch = normalized.match(
    /(?:^|\s|\|)(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)(?=\s|\||$)/
  )
  if (durationMatch) {
    const processed = normalizeNumberOrNull(durationMatch[1])
    const total = normalizeNumberOrNull(durationMatch[2])
    if (processed !== null && processed >= 0) processedSec = processed
    if (total !== null && total > 0) totalSec = total
  }
  if (percent === null && processedSec !== null && totalSec !== null && totalSec > 0) {
    percent = Math.max(0, Math.min(100, Math.round((processedSec / totalSec) * 100)))
  }
  const etaMatch = normalized.match(/<([0-9:.]+)/)
  const etaSec = etaMatch ? parseClockTokenToSeconds(etaMatch[1]) : null
  if (percent === null && processedSec === null && totalSec === null) return null
  return {
    percent: percent === null ? 0 : percent,
    processedSec,
    totalSec,
    etaSec
  }
}

const parseOnnxFastProgressText = (
  text: string
): {
  percent: number
  provider: MixtapeStemOnnxProvider
  chunkIndex: number | null
  totalChunks: number | null
} | null => {
  const normalized = normalizeText(text, 1200)
  if (!normalized || !normalized.startsWith(ONNX_FAST_PROGRESS_PREFIX)) {
    return null
  }
  const payloadRaw = normalized.slice(ONNX_FAST_PROGRESS_PREFIX.length).trim()
  if (!payloadRaw) return null
  try {
    const parsed = JSON.parse(payloadRaw) as MixtapeStemOnnxProgressPayload
    const rawProvider = normalizeText(parsed?.provider, 40).toLowerCase()
    const provider: MixtapeStemOnnxProvider =
      rawProvider.includes('dml') || rawProvider.includes('directml') ? 'directml' : 'cpu'
    const maybePercent = Number(parsed?.percent)
    const percent = Number.isFinite(maybePercent)
      ? Math.max(0, Math.min(100, Math.round(maybePercent)))
      : 0
    const chunkIndexRaw = Number(parsed?.chunkIndex)
    const totalChunksRaw = Number(parsed?.totalChunks)
    const chunkIndex =
      Number.isFinite(chunkIndexRaw) && chunkIndexRaw > 0 ? Math.floor(chunkIndexRaw) : null
    const totalChunks =
      Number.isFinite(totalChunksRaw) && totalChunksRaw > 0 ? Math.floor(totalChunksRaw) : null
    return {
      percent,
      provider,
      chunkIndex,
      totalChunks
    }
  } catch {
    return null
  }
}

const parseOnnxFastResultText = (
  text: string
): {
  provider: MixtapeStemOnnxProvider
  vocalPath: string
  instPath: string
  bassPath: string
  drumsPath: string
} | null => {
  const normalized = normalizeText(text, 2000)
  if (!normalized || !normalized.startsWith(ONNX_FAST_RESULT_PREFIX)) {
    return null
  }
  const payloadRaw = normalized.slice(ONNX_FAST_RESULT_PREFIX.length).trim()
  if (!payloadRaw) return null
  try {
    const parsed = JSON.parse(payloadRaw) as MixtapeStemOnnxResultPayload
    const rawProvider = normalizeText(parsed?.provider, 40).toLowerCase()
    return {
      provider:
        rawProvider.includes('dml') || rawProvider.includes('directml') ? 'directml' : 'cpu',
      vocalPath: normalizeFilePath(parsed?.vocalPath),
      instPath: normalizeFilePath(parsed?.instPath),
      bassPath: normalizeFilePath(parsed?.bassPath),
      drumsPath: normalizeFilePath(parsed?.drumsPath)
    }
  } catch {
    return null
  }
}

const summarizeOnnxErrorForLog = (message: string): string => {
  const normalized = normalizeText(message, 4000)
  if (!normalized) return ''
  const cleaned = normalized.replace(/\u0000/g, '').replace(/\u001b\[[0-9;]*m/g, '')
  const lines = cleaned
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return ''
  const preferred =
    lines.find((line) => /^runtimeerror:/i.test(line)) ||
    lines.find((line) => /^modulenotfounderror:/i.test(line)) ||
    lines.find((line) => /^demucs .*退出码/i.test(line)) ||
    lines.find((line) => /directml/i.test(line)) ||
    lines.find((line) => /onnxruntime/i.test(line)) ||
    lines[lines.length - 1]
  const trimmedPreferred = normalizeText(preferred, 320)
  if (/^runtimeerror:\s*$/i.test(trimmedPreferred)) {
    const runtimeErrorLineIndex = lines.findIndex((line) => /^runtimeerror:/i.test(line))
    if (runtimeErrorLineIndex >= 0 && runtimeErrorLineIndex + 1 < lines.length) {
      return normalizeText(lines[runtimeErrorLineIndex + 1], 320)
    }
  }
  return trimmedPreferred
}

const shouldSuppressOnnxDirectmlByRecentFailure = (): boolean => {
  loadStemRuntimeStateOnce()
  if (!stemOnnxDirectmlFailureAt) return false
  return Date.now() - stemOnnxDirectmlFailureAt <= ONNX_DIRECTML_FAILURE_COOLDOWN_MS
}

const resolveSystemMemoryGiB = (): number => {
  return Math.max(0, os.totalmem() / (1024 * 1024 * 1024))
}

const resolveSystemFreeMemoryGiB = (): number => {
  return Math.max(0, os.freemem() / (1024 * 1024 * 1024))
}

const resolveGpuConcurrencyCapByResources = (cpuParallel: number): number => {
  const totalMemoryGiB = resolveSystemMemoryGiB()
  const freeMemoryGiB = resolveSystemFreeMemoryGiB()
  let cap = STEM_GPU_JOB_CONCURRENCY_MIN
  if (
    cpuParallel >= 3 &&
    totalMemoryGiB >= STEM_SYSTEM_MEMORY_GB_FOR_GPU_CONCURRENCY_2 &&
    freeMemoryGiB >= STEM_FREE_MEMORY_GB_FOR_GPU_CONCURRENCY_2
  ) {
    cap = Math.max(cap, 2)
  }
  if (
    cpuParallel >= 4 &&
    totalMemoryGiB >= STEM_SYSTEM_MEMORY_GB_FOR_GPU_CONCURRENCY_3 &&
    freeMemoryGiB >= STEM_FREE_MEMORY_GB_FOR_GPU_CONCURRENCY_3
  ) {
    cap = Math.max(cap, 3)
  }
  return Math.max(STEM_GPU_JOB_CONCURRENCY_MIN, Math.min(STEM_GPU_JOB_CONCURRENCY_MAX, cap))
}

const resolveOnnxDirectmlDynamicConcurrency = (cpuParallel: number): number => {
  loadStemRuntimeStateOnce()
  if (shouldSuppressOnnxDirectmlByRecentFailure()) {
    return cpuParallel
  }
  const capByResources = Math.min(
    STEM_GPU_JOB_CONCURRENCY_DIRECTML_MAX,
    resolveGpuConcurrencyCapByResources(cpuParallel)
  )
  const successStreak = Math.max(0, stemOnnxDirectmlRuntimeStats.consecutiveSuccessCount || 0)
  if (successStreak >= STEM_ONNX_DIRECTML_CONCURRENCY_HIGH_SUCCESS) {
    return Math.max(STEM_GPU_JOB_CONCURRENCY_MIN, Math.min(capByResources, 3))
  }
  if (successStreak >= STEM_ONNX_DIRECTML_CONCURRENCY_WARMUP_SUCCESS) {
    return Math.max(STEM_GPU_JOB_CONCURRENCY_MIN, Math.min(capByResources, 2))
  }
  return STEM_GPU_JOB_CONCURRENCY_MIN
}

const shouldSerializeOnnxDirectmlAttempts = (): boolean => {
  loadStemRuntimeStateOnce()
  if (shouldSuppressOnnxDirectmlByRecentFailure()) return true
  const successStreak = Math.max(0, stemOnnxDirectmlRuntimeStats.consecutiveSuccessCount || 0)
  return successStreak < STEM_ONNX_DIRECTML_CONCURRENCY_WARMUP_SUCCESS
}

const acquireOnnxDirectmlAttemptLease = async (): Promise<{
  skip: boolean
  release: () => void
}> => {
  while (stemOnnxDirectmlAttemptGate) {
    await stemOnnxDirectmlAttemptGate
    if (shouldSuppressOnnxDirectmlByRecentFailure()) {
      return {
        skip: true,
        release: () => {}
      }
    }
  }
  stemOnnxDirectmlAttemptGate = new Promise<void>((resolve) => {
    stemOnnxDirectmlAttemptGateResolve = resolve
  })
  let released = false
  return {
    skip: false,
    release: () => {
      if (released) return
      released = true
      const resolve = stemOnnxDirectmlAttemptGateResolve
      stemOnnxDirectmlAttemptGateResolve = null
      stemOnnxDirectmlAttemptGate = null
      try {
        resolve?.()
      } catch {}
    }
  }
}

const markOnnxDirectmlRuntimeFailure = (reason: string) => {
  loadStemRuntimeStateOnce()
  const summary = normalizeText(reason, 600)
  stemOnnxDirectmlFailureAt = Date.now()
  stemOnnxDirectmlFailureReason = summary
  stemOnnxDirectmlRuntimeStats = {
    ...stemOnnxDirectmlRuntimeStats,
    failureCount: stemOnnxDirectmlRuntimeStats.failureCount + 1,
    consecutiveSuccessCount: 0,
    lastFailureAt: Date.now()
  }
  const current = stemOnnxRuntimeProbeSnapshot
  if (!current || !current.providerCandidates.includes('directml')) return
  const providerCandidates: MixtapeStemOnnxProvider[] = current.providerCandidates.filter(
    (provider): provider is MixtapeStemOnnxProvider => provider !== 'directml'
  )
  const nextCandidates: MixtapeStemOnnxProvider[] = providerCandidates.length
    ? providerCandidates
    : ['cpu']
  stemOnnxRuntimeProbeSnapshot = {
    ...current,
    checkedAt: Date.now(),
    providerCandidates: nextCandidates
  }
  log.info('[mixtape-stem] onnx directml temporarily disabled after runtime failure', {
    runtimeKey: current.runtimeKey,
    cooldownMs: ONNX_DIRECTML_FAILURE_COOLDOWN_MS,
    reason: summary || null
  })
  schedulePersistStemRuntimeState()
  try {
    runQueueLoop()
  } catch {}
}

const markOnnxDirectmlRuntimeSuccess = () => {
  loadStemRuntimeStateOnce()
  stemOnnxDirectmlRuntimeStats = {
    ...stemOnnxDirectmlRuntimeStats,
    successCount: stemOnnxDirectmlRuntimeStats.successCount + 1,
    consecutiveSuccessCount: stemOnnxDirectmlRuntimeStats.consecutiveSuccessCount + 1,
    lastSuccessAt: Date.now()
  }
  schedulePersistStemRuntimeState()
}

const resolveOnnxFastProviderCandidates = (
  runtimeSnapshot: MixtapeStemOnnxRuntimeProbeSnapshot
): MixtapeStemOnnxProvider[] => {
  const providers = runtimeSnapshot.providerCandidates.filter(
    (provider): provider is MixtapeStemOnnxProvider => provider === 'directml' || provider === 'cpu'
  )
  if (!providers.length) return ['cpu']
  return Array.from(new Set(providers))
}

const copyOnnxStemOutputsToCache = async (params: {
  sourceVocalPath: string
  sourceInstPath: string
  sourceBassPath: string
  sourceDrumsPath: string
  stemCacheDir: string
}): Promise<MixtapeStemSeparationResult> => {
  const sourceVocalPath = normalizeFilePath(params.sourceVocalPath)
  const sourceInstPath = normalizeFilePath(params.sourceInstPath)
  const sourceBassPath = normalizeFilePath(params.sourceBassPath)
  const sourceDrumsPath = normalizeFilePath(params.sourceDrumsPath)
  if (!sourceVocalPath || !sourceInstPath || !sourceBassPath || !sourceDrumsPath) {
    throw createStemError('FAST_ONNX_OUTPUT_INVALID', 'ONNX 输出路径无效')
  }
  const required = [sourceVocalPath, sourceInstPath, sourceBassPath, sourceDrumsPath]
  if (!required.every((item) => fs.existsSync(item))) {
    throw createStemError('FAST_ONNX_OUTPUT_MISSING', 'ONNX 输出不完整')
  }
  await fs.promises.mkdir(params.stemCacheDir, { recursive: true })
  const vocalOutputPath = path.join(params.stemCacheDir, 'vocal.wav')
  const instOutputPath = path.join(params.stemCacheDir, 'inst.wav')
  const bassOutputPath = path.join(params.stemCacheDir, 'bass.wav')
  const drumsOutputPath = path.join(params.stemCacheDir, 'drums.wav')
  await fs.promises.copyFile(sourceVocalPath, vocalOutputPath)
  await fs.promises.copyFile(sourceInstPath, instOutputPath)
  await fs.promises.copyFile(sourceBassPath, bassOutputPath)
  await fs.promises.copyFile(sourceDrumsPath, drumsOutputPath)
  return {
    vocalPath: vocalOutputPath,
    instPath: instOutputPath,
    bassPath: bassOutputPath,
    drumsPath: drumsOutputPath
  }
}

const runOnnxFastSeparation = async (params: {
  filePath: string
  stemCacheDir: string
  onnxRuntimeSnapshot: MixtapeStemOnnxRuntimeProbeSnapshot
  pythonPath: string
  env: NodeJS.ProcessEnv
  modelRepoPath: string
  ffmpegPath: string
  deviceSnapshot: MixtapeStemDeviceProbeSnapshot
  inputDurationSec: number | null
  onDeviceStart?: (
    device: MixtapeStemComputeDevice,
    context?: {
      reasonCode?: MixtapeStemCpuFallbackReasonCode
      reasonDetail?: string
    }
  ) => void
  onProgress?: (progress: MixtapeStemRuntimeProgress) => void
}): Promise<MixtapeStemSeparationResult> => {
  const onnxRootPath = resolveBundledDemucsOnnxPath()
  const onnxModelPath = path.join(onnxRootPath, ONNX_FAST_MODEL_FILE_NAME)
  const onnxScriptPath = path.join(onnxRootPath, ONNX_FAST_SCRIPT_FILE_NAME)
  if (!fs.existsSync(onnxScriptPath)) {
    throw createStemError('FAST_ONNX_SCRIPT_MISSING', `未找到 ONNX 脚本: ${onnxScriptPath}`)
  }
  if (!fs.existsSync(onnxModelPath)) {
    throw createStemError('FAST_ONNX_MODEL_MISSING', `未找到 ONNX 模型: ${onnxModelPath}`)
  }

  const providerCandidates = resolveOnnxFastProviderCandidates(params.onnxRuntimeSnapshot)
  const onnxRawOutputRoot = path.join(params.stemCacheDir, '__onnx_raw')
  await fs.promises.rm(onnxRawOutputRoot, { recursive: true, force: true }).catch(() => {})
  await fs.promises.mkdir(onnxRawOutputRoot, { recursive: true })

  let lastError: unknown = null
  for (let providerIndex = 0; providerIndex < providerCandidates.length; providerIndex += 1) {
    const provider = providerCandidates[providerIndex]
    let releaseDirectmlLease: (() => void) | null = null
    if (provider === 'directml') {
      if (shouldSuppressOnnxDirectmlByRecentFailure()) {
        continue
      }
      if (shouldSerializeOnnxDirectmlAttempts()) {
        const directmlLease = await acquireOnnxDirectmlAttemptLease()
        if (directmlLease.skip || shouldSuppressOnnxDirectmlByRecentFailure()) {
          directmlLease.release()
          continue
        }
        releaseDirectmlLease = directmlLease.release
      }
    }
    const providerOutputDir = path.join(onnxRawOutputRoot, provider)
    const device: MixtapeStemComputeDevice = provider === 'directml' ? 'directml' : 'cpu'
    const timeoutMs = resolveStemProcessTimeoutMs({
      device,
      inputDurationSec: params.inputDurationSec
    })

    try {
      if (device === 'cpu') {
        const { reasonCode, reasonDetail } = resolveCpuFallbackReason({
          deviceSnapshot: params.deviceSnapshot,
          firstFailure: null
        })
        params.onDeviceStart?.(device, { reasonCode, reasonDetail })
      } else {
        params.onDeviceStart?.(device)
      }
    } catch {}

    try {
      await fs.promises.rm(providerOutputDir, { recursive: true, force: true }).catch(() => {})
      await fs.promises.mkdir(providerOutputDir, { recursive: true })
      let onnxResultMarked = false
      let onnxResultProvider: MixtapeStemOnnxProvider = provider

      const handleOutputChunk = (chunk: string) => {
        const lines = chunk.split(/[\r\n]+/)
        for (const line of lines) {
          const progress = parseOnnxFastProgressText(line)
          if (progress) {
            const percent = Math.max(0, Math.min(100, Math.round(progress.percent)))
            const totalSec =
              Number.isFinite(params.inputDurationSec) && Number(params.inputDurationSec) > 0
                ? params.inputDurationSec
                : null
            const processedSec = totalSec !== null ? Math.round((totalSec * percent) / 100) : null
            const etaSec =
              totalSec !== null ? Math.max(0, Math.round((totalSec * (100 - percent)) / 100)) : null
            params.onProgress?.({
              device: progress.provider === 'directml' ? 'directml' : 'cpu',
              percent,
              processedSec,
              totalSec,
              etaSec
            })
            continue
          }
          const resultPayload = parseOnnxFastResultText(line)
          if (resultPayload) {
            onnxResultMarked = true
            onnxResultProvider = resultPayload.provider
          }
        }
      }

      await runProcess(
        params.pythonPath,
        [
          onnxScriptPath,
          '--input',
          params.filePath,
          '--output-dir',
          providerOutputDir,
          '--onnx-model',
          onnxModelPath,
          '--demucs-model-repo',
          params.modelRepoPath,
          '--ffmpeg-path',
          params.ffmpegPath,
          '--provider',
          provider,
          '--helper-model',
          'htdemucs',
          '--overlap',
          '0.2',
          '--torch-threads',
          '1'
        ],
        {
          env: params.env,
          timeoutMs,
          traceLabel: `mixtape-stem-onnx:${provider}`,
          progressIntervalMs: 30_000,
          onStdoutChunk: handleOutputChunk,
          onStderrChunk: handleOutputChunk
        }
      )

      if (!onnxResultMarked) {
        throw createStemError('FAST_ONNX_RESULT_MISSING', 'ONNX 未返回输出结果')
      }
      const copied = await copyOnnxStemOutputsToCache({
        sourceVocalPath: path.join(providerOutputDir, 'vocal.wav'),
        sourceInstPath: path.join(providerOutputDir, 'inst.wav'),
        sourceBassPath: path.join(providerOutputDir, 'bass.wav'),
        sourceDrumsPath: path.join(providerOutputDir, 'drums.wav'),
        stemCacheDir: params.stemCacheDir
      })
      log.info('[mixtape-stem] onnx fast split done', {
        file: params.filePath,
        runtimeKey: params.onnxRuntimeSnapshot.runtimeKey,
        provider: onnxResultProvider,
        onnxModel: onnxModelPath,
        outputDir: params.stemCacheDir
      })
      if (onnxResultProvider === 'directml') {
        markOnnxDirectmlRuntimeSuccess()
        try {
          runQueueLoop()
        } catch {}
      }
      await fs.promises.rm(onnxRawOutputRoot, { recursive: true, force: true }).catch(() => {})
      return copied
    } catch (error) {
      const rawMessage = normalizeText(
        error instanceof Error ? error.message : String(error || ''),
        2000
      )
      const lowered = rawMessage.toLowerCase()
      const isDirectmlUnavailable =
        lowered.includes('directml provider unavailable') ||
        (lowered.includes('dmlexecutionprovider') &&
          (lowered.includes('not available') ||
            lowered.includes('not in available provider names') ||
            lowered.includes('available providers')))
      const normalizedError = lowered.includes("no module named 'onnxruntime'")
        ? createStemError(
            'FAST_ONNX_RUNTIME_MISSING',
            'Fast ONNX 运行时缺少 onnxruntime，请重新执行 demucs 运行时确保流程'
          )
        : isDirectmlUnavailable
          ? createStemError('FAST_ONNX_DIRECTML_UNAVAILABLE', rawMessage || 'DirectML 不可用')
          : error
      lastError = normalizedError
      const errorCode = normalizeText((normalizedError as any)?.code, 80) || null
      const errorMessage = normalizeText(
        normalizedError instanceof Error
          ? normalizedError.message
          : String(normalizedError || rawMessage),
        1200
      )
      const summaryMessage = summarizeOnnxErrorForLog(errorMessage || rawMessage)
      const fallbackProvider =
        providerIndex + 1 < providerCandidates.length ? providerCandidates[providerIndex + 1] : null
      const shouldMarkDirectmlFailure =
        provider === 'directml' &&
        (errorCode === 'FAST_ONNX_DIRECTML_UNAVAILABLE' ||
          (fallbackProvider &&
            errorCode !== 'FAST_ONNX_RUNTIME_MISSING' &&
            errorCode !== 'FAST_ONNX_MODEL_MISSING'))
      if (shouldMarkDirectmlFailure) {
        markOnnxDirectmlRuntimeFailure(summaryMessage || errorMessage || rawMessage)
      }
      if (errorCode === 'FAST_ONNX_DIRECTML_UNAVAILABLE' && fallbackProvider) {
        log.info('[mixtape-stem] onnx directml unavailable, fallback to next provider', {
          file: params.filePath,
          runtimeKey: params.onnxRuntimeSnapshot.runtimeKey,
          provider,
          fallbackProvider,
          errorCode,
          errorSummary: summaryMessage || 'DirectML provider unavailable'
        })
      } else if (fallbackProvider) {
        log.warn('[mixtape-stem] onnx provider failed, fallback to next provider', {
          file: params.filePath,
          runtimeKey: params.onnxRuntimeSnapshot.runtimeKey,
          provider,
          fallbackProvider,
          errorCode,
          errorSummary: summaryMessage || errorMessage || null
        })
      } else {
        log.warn('[mixtape-stem] onnx fast failed', {
          file: params.filePath,
          runtimeKey: params.onnxRuntimeSnapshot.runtimeKey,
          provider,
          errorCode,
          errorSummary: summaryMessage || errorMessage || null
        })
      }
      if (
        (errorCode === 'FAST_ONNX_RUNTIME_MISSING' || errorCode === 'FAST_ONNX_MODEL_MISSING') &&
        !fallbackProvider
      ) {
        log.error('[mixtape-stem] onnx fast terminal failure', {
          file: params.filePath,
          runtimeKey: params.onnxRuntimeSnapshot.runtimeKey,
          provider,
          errorCode,
          errorSummary: summaryMessage || errorMessage || null
        })
      }
    } finally {
      try {
        releaseDirectmlLease?.()
      } catch {}
      await fs.promises.rm(providerOutputDir, { recursive: true, force: true }).catch(() => {})
    }
  }
  await fs.promises.rm(onnxRawOutputRoot, { recursive: true, force: true }).catch(() => {})
  throw lastError || createStemError('FAST_ONNX_FAILED', 'ONNX fast 分离失败：未找到可用执行后端')
}

const runDemucsSeparate = async (params: {
  pythonPath: string
  demucsArgs: string[]
  env: NodeJS.ProcessEnv
  timeoutMs: number
  traceLabel: string
  useDirectmlBootstrap: boolean
  onStderrChunk?: (chunk: string) => void
}) => {
  if (!params.useDirectmlBootstrap) {
    await runProcess(params.pythonPath, ['-m', 'demucs.separate', ...params.demucsArgs], {
      env: params.env,
      timeoutMs: params.timeoutMs,
      traceLabel: params.traceLabel,
      progressIntervalMs: 30_000,
      onStderrChunk: params.onStderrChunk
    })
    return
  }
  const argvPayload = JSON.stringify(['demucs.separate', ...params.demucsArgs])
  const bootstrapScript = [
    'import json',
    'import runpy',
    'import sys',
    'import torch_directml',
    `sys.argv = json.loads(${JSON.stringify(argvPayload)})`,
    "runpy.run_module('demucs.separate', run_name='__main__')"
  ].join('\n')
  await runProcess(params.pythonPath, ['-c', bootstrapScript], {
    env: params.env,
    timeoutMs: params.timeoutMs,
    traceLabel: params.traceLabel,
    progressIntervalMs: 30_000,
    onStderrChunk: params.onStderrChunk
  })
}

const shouldRetryWithNextDevice = (error: unknown): boolean => {
  const message = normalizeText(
    error instanceof Error ? error.message : String(error || ''),
    4000
  ).toLowerCase()
  if (!message) return false
  const patterns = [
    'torch not compiled with cuda enabled',
    'cuda unavailable',
    'no cuda gpus are available',
    'invalid device string',
    'expected one of cpu',
    'mps backend',
    'device type mps',
    'is not available for this process',
    'out of memory',
    'cudnn',
    'hip',
    'xpu',
    'oneapi',
    'level zero',
    'directml',
    'privateuseone',
    'dml'
  ]
  return patterns.some((pattern) => message.includes(pattern))
}

const shouldRetryWithFallbackModel = (error: unknown): boolean => {
  const message = normalizeText(
    error instanceof Error ? error.message : String(error || ''),
    4000
  ).toLowerCase()
  if (!message) return false
  const patterns = [
    'unknown model',
    'could not find pre-trained model',
    'model not found',
    'no such file or directory',
    'diffq is not installed',
    'trying to use diffq'
  ]
  return patterns.some((pattern) => message.includes(pattern))
}

const listLocalDemucsWeightFiles = (modelRepoPath: string): string[] => {
  try {
    return fs
      .readdirSync(modelRepoPath)
      .map((name) => normalizeText(name, 300).toLowerCase())
      .filter((name) => name.endsWith('.th'))
  } catch {
    return []
  }
}

const parseLocalDemucsYamlModelIds = (yamlRaw: string): string[] => {
  const matches = Array.from(String(yamlRaw || '').matchAll(/['"]([0-9a-f]{8})['"]/gi))
  return Array.from(new Set(matches.map((match) => String(match[1] || '').toLowerCase())))
}

const inspectLocalDemucsModel = (params: {
  modelRepoPath: string
  demucsModelName: string
  localWeightFiles: string[]
}): {
  available: boolean
  reason: string
} => {
  const modelRepoPath = normalizeFilePath(params.modelRepoPath)
  const demucsModelName = normalizeText(params.demucsModelName, 128)
  if (!modelRepoPath || !demucsModelName) {
    return {
      available: false,
      reason: 'MODEL_NAME_EMPTY'
    }
  }
  const localModelYaml = path.join(modelRepoPath, `${demucsModelName}.yaml`)
  if (!fs.existsSync(localModelYaml)) {
    return {
      available: false,
      reason: 'MODEL_YAML_MISSING'
    }
  }
  const yamlRaw = fs.readFileSync(localModelYaml, 'utf8')
  const modelIds = parseLocalDemucsYamlModelIds(yamlRaw)
  if (!modelIds.length) {
    return {
      available: true,
      reason: 'MODEL_YAML_NO_WEIGHT_ID'
    }
  }
  const localWeightFiles = Array.isArray(params.localWeightFiles) ? params.localWeightFiles : []
  const missingModelIds = modelIds.filter(
    (id) =>
      !localWeightFiles.some((filename) => filename.startsWith(`${id}-`) || filename === `${id}.th`)
  )
  if (missingModelIds.length > 0) {
    return {
      available: false,
      reason: `MODEL_WEIGHT_MISSING:${missingModelIds.join(',')}`
    }
  }
  return {
    available: true,
    reason: 'OK'
  }
}

const resolveDemucsModelCandidates = (params: {
  requestedModel: string
  stemProfile: MixtapeStemProfile
  modelRepoPath: string
}): string[] => {
  const requestedCandidates: string[] = []
  const pushCandidate = (model: string) => {
    const normalized = normalizeText(model, 128)
    if (!normalized) return
    if (requestedCandidates.includes(normalized)) return
    requestedCandidates.push(normalized)
  }
  pushCandidate(params.requestedModel)
  if (params.stemProfile === 'fast') {
    pushCandidate(resolveMixtapeStemBaseModelByProfile('fast', 'fast'))
  }
  pushCandidate(resolveMixtapeStemBaseModelByProfile('quality', 'quality'))

  const localWeightFiles = listLocalDemucsWeightFiles(params.modelRepoPath)
  const availableCandidates: string[] = []
  const skippedDetails: Array<{ model: string; reason: string }> = []
  for (const candidate of requestedCandidates) {
    const inspected = inspectLocalDemucsModel({
      modelRepoPath: params.modelRepoPath,
      demucsModelName: candidate,
      localWeightFiles
    })
    if (inspected.available) {
      availableCandidates.push(candidate)
      continue
    }
    skippedDetails.push({
      model: candidate,
      reason: inspected.reason
    })
  }
  if (!availableCandidates.length) {
    const reason = skippedDetails.map((item) => `${item.model}:${item.reason}`).join(' | ')
    throw createStemError(
      'STEM_MODEL_MISSING',
      `未找到可用的本地 Demucs 模型，请检查 vendor/demucs/models: ${reason || 'none'}`
    )
  }
  if (skippedDetails.length > 0) {
    log.warn('[mixtape-stem] skip non-local demucs model', {
      requestedCandidates,
      skipped: skippedDetails
    })
  }
  return availableCandidates
}

const runStemSeparation = async (params: {
  filePath: string
  stemMode: MixtapeStemMode
  model: string
  onDeviceStart?: (
    device: MixtapeStemComputeDevice,
    context?: {
      reasonCode?: MixtapeStemCpuFallbackReasonCode
      reasonDetail?: string
    }
  ) => void
  onProgress?: (progress: MixtapeStemRuntimeProgress) => void
}): Promise<MixtapeStemSeparationResult> => {
  const filePath = normalizeFilePath(params.filePath)
  if (!filePath || !fs.existsSync(filePath)) {
    throw createStemError('STEM_SOURCE_MISSING', 'Stem 源文件不存在')
  }
  const modelRepoPath = resolveBundledDemucsModelsPath()
  const ffmpegPath = resolveBundledFfmpegPath()
  const ffprobePath = resolveBundledFfprobePath()
  if (!fs.existsSync(modelRepoPath)) {
    throw createStemError('STEM_MODEL_MISSING', `未找到 Demucs 模型目录: ${modelRepoPath}`)
  }
  if (!fs.existsSync(ffmpegPath)) {
    throw createStemError('STEM_FFMPEG_MISSING', `未找到 ffmpeg: ${ffmpegPath}`)
  }
  if (!fs.existsSync(ffprobePath)) {
    throw createStemError('STEM_FFPROBE_MISSING', `未找到 ffprobe: ${ffprobePath}`)
  }
  const deviceSnapshot = await probeDemucsDevices(ffmpegPath)

  const stemCacheDir = await resolveStemCacheDir({
    filePath,
    model: params.model,
    stemMode: params.stemMode
  })
  const rawOutputRoot = path.join(stemCacheDir, '__raw')
  await fs.promises.rm(rawOutputRoot, { recursive: true, force: true }).catch(() => {})
  await fs.promises.mkdir(rawOutputRoot, { recursive: true })

  const inputDurationSec = await probeAudioDurationSeconds(ffprobePath, filePath)
  const preferNoSplit =
    Number.isFinite(inputDurationSec) &&
    Number(inputDurationSec) > 0 &&
    Number(inputDurationSec) <= DEMUCS_NO_SPLIT_MAX_DURATION_SECONDS
  const parsedModel = parseMixtapeStemModel(params.model, DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE)
  const requestedDemucsModelName =
    normalizeText(parsedModel.demucsModel, 128) || DEFAULT_MIXTAPE_STEM_BASE_MODEL
  const stemProfile = normalizeStemProfile(
    parsedModel.profile,
    DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE
  )

  if (stemProfile === 'fast') {
    const onnxRuntimeSnapshot = await probeOnnxRuntime(ffmpegPath)
    const onnxRuntimeDir =
      normalizeFilePath(onnxRuntimeSnapshot.runtimeDir) || resolveBundledDemucsRuntimeDir()
    const onnxPythonPath =
      normalizeFilePath(onnxRuntimeSnapshot.pythonPath) ||
      resolveBundledDemucsPythonPath(onnxRuntimeDir)
    if (!fs.existsSync(onnxPythonPath)) {
      throw createStemError(
        'FAST_ONNX_RUNTIME_MISSING',
        `未找到 Fast ONNX 运行时: ${onnxPythonPath} (runtime=${onnxRuntimeSnapshot.runtimeKey})`
      )
    }
    const onnxEnv = buildStemProcessEnv(onnxRuntimeDir, ffmpegPath)
    log.info('[mixtape-stem] onnx runtime dispatch', {
      file: filePath,
      runtimeKey: onnxRuntimeSnapshot.runtimeKey,
      runtimeDir: onnxRuntimeDir,
      pythonPath: onnxPythonPath,
      providers: onnxRuntimeSnapshot.providerCandidates
    })
    const onnxResult = await runOnnxFastSeparation({
      filePath,
      stemCacheDir,
      onnxRuntimeSnapshot,
      pythonPath: onnxPythonPath,
      env: onnxEnv,
      modelRepoPath,
      ffmpegPath,
      deviceSnapshot,
      inputDurationSec,
      onDeviceStart: params.onDeviceStart,
      onProgress: params.onProgress
    })
    await fs.promises.rm(rawOutputRoot, { recursive: true, force: true }).catch(() => {})
    return onnxResult
  }

  const runtimeDir =
    normalizeFilePath(deviceSnapshot.runtimeDir) || resolveBundledDemucsRuntimeDir()
  const pythonPath =
    normalizeFilePath(deviceSnapshot.pythonPath) || resolveBundledDemucsPythonPath(runtimeDir)
  if (!fs.existsSync(pythonPath)) {
    throw createStemError(
      'STEM_ENGINE_MISSING',
      `未找到 Demucs 运行时: ${pythonPath} (runtime=${deviceSnapshot.runtimeKey})`
    )
  }
  const env = buildStemProcessEnv(runtimeDir, ffmpegPath)

  const demucsModelCandidates = resolveDemucsModelCandidates({
    requestedModel: requestedDemucsModelName,
    stemProfile,
    modelRepoPath
  })
  const deviceCandidates: MixtapeStemComputeDevice[] =
    deviceSnapshot.devices.length > 0 ? deviceSnapshot.devices : ['cpu']
  const timeoutHintMsByDevice = Object.fromEntries(
    deviceCandidates.map((device) => [
      device,
      resolveStemProcessTimeoutMs({
        device,
        inputDurationSec
      })
    ])
  )
  let selectedDevice: MixtapeStemComputeDevice | null = null
  let selectedDemucsModelName = ''
  let lastModelError: unknown = null
  try {
    for (let modelIndex = 0; modelIndex < demucsModelCandidates.length; modelIndex += 1) {
      const demucsModelName = demucsModelCandidates[modelIndex]
      const profileOptions = DEMUCS_PROFILE_OPTIONS[stemProfile] || DEMUCS_PROFILE_OPTIONS.fast
      const demucsSegmentSec = resolveDemucsSegmentSec({
        demucsModel: demucsModelName,
        requestedSegmentSec: profileOptions.segmentSec
      })
      log.info('[mixtape-stem] demucs profile', {
        file: filePath,
        model: params.model,
        demucsModel: demucsModelName,
        stemProfile,
        runtimeKey: deviceSnapshot.runtimeKey,
        runtimeDir: deviceSnapshot.runtimeDir,
        preferNoSplit,
        cpuNoSplitEnabledForFast: false,
        modelRepo: modelRepoPath,
        inputDurationSec,
        deviceCandidates,
        timeoutHintMsByDevice,
        shifts: Number(profileOptions.shifts),
        overlap: Number(profileOptions.overlap),
        requestedSegmentSec: Number(profileOptions.segmentSec),
        segmentSec: Number(demucsSegmentSec)
      })
      const runDemucsForDevice = async (device: MixtapeStemComputeDevice) => {
        const processTimeoutMs = resolveStemProcessTimeoutMs({
          device,
          inputDurationSec
        })
        const demucsDeviceArg = resolveDemucsDeviceArg(device, deviceSnapshot)
        const demucsBaseArgs = [
          '-n',
          demucsModelName,
          '--repo',
          modelRepoPath,
          '-d',
          demucsDeviceArg,
          '-j',
          '1',
          '--filename',
          '{stem}.{ext}',
          '-o',
          rawOutputRoot,
          '--shifts',
          profileOptions.shifts
        ]
        const demucsSplitArgs = [
          ...demucsBaseArgs,
          '--overlap',
          profileOptions.overlap,
          '--segment',
          demucsSegmentSec,
          filePath
        ]
        const demucsNoSplitArgs = [...demucsBaseArgs, '--no-split', filePath]
        await fs.promises.rm(rawOutputRoot, { recursive: true, force: true }).catch(() => {})
        await fs.promises.mkdir(rawOutputRoot, { recursive: true })
        log.info('[mixtape-stem] demucs split start', {
          file: filePath,
          stemMode: params.stemMode,
          model: params.model,
          demucsModel: demucsModelName,
          stemProfile,
          device,
          demucsDeviceArg,
          timeoutMs: processTimeoutMs
        })
        let lastProgressEmitAt = 0
        let lastProgressPercent = -1
        const emitProgress = (parsed: {
          percent: number
          processedSec: number | null
          totalSec: number | null
          etaSec: number | null
        }) => {
          const now = Date.now()
          const percent = Math.max(0, Math.min(100, Math.round(parsed.percent)))
          const shouldForceEmit = percent === 0 || percent === 100
          if (!shouldForceEmit) {
            const noPercentChange = percent === lastProgressPercent
            if (noPercentChange && now - lastProgressEmitAt < 2000) return
          }
          lastProgressEmitAt = now
          lastProgressPercent = percent
          params.onProgress?.({
            device,
            percent,
            processedSec: parsed.processedSec,
            totalSec: parsed.totalSec,
            etaSec: parsed.etaSec
          })
        }
        const handleStderrChunk = (chunk: string) => {
          const chunks = chunk.split(/[\r\n]+/)
          for (const line of chunks) {
            const parsed = parseDemucsProgressText(line)
            if (!parsed) continue
            emitProgress(parsed)
          }
        }
        emitProgress({
          percent: 0,
          processedSec: 0,
          totalSec:
            Number.isFinite(inputDurationSec) && Number(inputDurationSec) > 0
              ? inputDurationSec
              : null,
          etaSec: null
        })
        const allowNoSplit = preferNoSplit && device !== 'cpu'
        if (!allowNoSplit) {
          await runDemucsSeparate({
            pythonPath,
            demucsArgs: demucsSplitArgs,
            env,
            timeoutMs: processTimeoutMs,
            traceLabel: `mixtape-stem-demucs:${demucsModelName}:${device}`,
            useDirectmlBootstrap: device === 'directml',
            onStderrChunk: handleStderrChunk
          })
          emitProgress({
            percent: 100,
            processedSec:
              Number.isFinite(inputDurationSec) && Number(inputDurationSec) > 0
                ? inputDurationSec
                : null,
            totalSec:
              Number.isFinite(inputDurationSec) && Number(inputDurationSec) > 0
                ? inputDurationSec
                : null,
            etaSec: 0
          })
          return
        }
        try {
          await runDemucsSeparate({
            pythonPath,
            demucsArgs: demucsNoSplitArgs,
            env,
            timeoutMs: processTimeoutMs,
            traceLabel: `mixtape-stem-demucs:${demucsModelName}:${device}`,
            useDirectmlBootstrap: device === 'directml',
            onStderrChunk: handleStderrChunk
          })
          emitProgress({
            percent: 100,
            processedSec:
              Number.isFinite(inputDurationSec) && Number(inputDurationSec) > 0
                ? inputDurationSec
                : null,
            totalSec:
              Number.isFinite(inputDurationSec) && Number(inputDurationSec) > 0
                ? inputDurationSec
                : null,
            etaSec: 0
          })
        } catch (error) {
          log.warn('[mixtape-stem] demucs no-split failed, fallback to split', {
            file: filePath,
            model: params.model,
            demucsModel: demucsModelName,
            stemProfile,
            device,
            errorCode: normalizeText((error as any)?.code, 80) || null,
            errorMessage: normalizeText(
              error instanceof Error ? error.message : String(error || ''),
              600
            )
          })
          await runDemucsSeparate({
            pythonPath,
            demucsArgs: demucsSplitArgs,
            env,
            timeoutMs: processTimeoutMs,
            traceLabel: `mixtape-stem-demucs:${demucsModelName}:${device}`,
            useDirectmlBootstrap: device === 'directml',
            onStderrChunk: handleStderrChunk
          })
          emitProgress({
            percent: 100,
            processedSec:
              Number.isFinite(inputDurationSec) && Number(inputDurationSec) > 0
                ? inputDurationSec
                : null,
            totalSec:
              Number.isFinite(inputDurationSec) && Number(inputDurationSec) > 0
                ? inputDurationSec
                : null,
            etaSec: 0
          })
        }
      }
      let currentSelectedDevice: MixtapeStemComputeDevice | null = null
      let lastDeviceError: unknown = null
      const retryableDeviceFailures: Array<{
        device: MixtapeStemComputeDevice
        errorCode: string
        errorMessage: string
      }> = []
      try {
        for (let index = 0; index < deviceCandidates.length; index += 1) {
          const device = deviceCandidates[index]
          try {
            if (device === 'cpu') {
              const firstFailure = retryableDeviceFailures[0] || null
              const { reasonCode, reasonDetail } = resolveCpuFallbackReason({
                deviceSnapshot,
                firstFailure
              })
              params.onDeviceStart?.(device, {
                reasonCode,
                reasonDetail
              })
            } else {
              params.onDeviceStart?.(device)
            }
          } catch {}
          try {
            await runDemucsForDevice(device)
            currentSelectedDevice = device
            break
          } catch (error) {
            lastDeviceError = error
            const hasNext = index < deviceCandidates.length - 1
            const retryable = hasNext && shouldRetryWithNextDevice(error)
            const normalizedErrorCode = normalizeText((error as any)?.code, 80)
            const normalizedErrorMessage = normalizeText(
              error instanceof Error ? error.message : String(error || ''),
              800
            )
            log.warn('[mixtape-stem] demucs device failed', {
              file: filePath,
              model: params.model,
              demucsModel: demucsModelName,
              stemProfile,
              device,
              errorCode: normalizedErrorCode || null,
              errorMessage: normalizedErrorMessage,
              retryWithNextDevice: retryable
            })
            if (retryable) {
              retryableDeviceFailures.push({
                device,
                errorCode: normalizedErrorCode,
                errorMessage: normalizedErrorMessage
              })
            }
            if (!retryable) {
              throw error
            }
          }
        }
        if (!currentSelectedDevice) {
          throw (
            lastDeviceError ||
            createStemError('STEM_SPLIT_FAILED', 'Demucs 分离失败：未找到可用设备')
          )
        }
        selectedDevice = currentSelectedDevice
        selectedDemucsModelName = demucsModelName
        break
      } catch (error) {
        lastModelError = error
        const hasNextModel = modelIndex < demucsModelCandidates.length - 1
        const retryWithFallbackModel = hasNextModel && shouldRetryWithFallbackModel(error)
        log.warn('[mixtape-stem] demucs model failed', {
          file: filePath,
          requestedModel: requestedDemucsModelName,
          demucsModel: demucsModelName,
          stemProfile,
          errorCode: normalizeText((error as any)?.code, 80) || null,
          errorMessage: normalizeText(
            error instanceof Error ? error.message : String(error || ''),
            800
          ),
          retryWithFallbackModel
        })
        if (retryWithFallbackModel) {
          continue
        }
        throw error
      }
    }
    if (!selectedDevice || !selectedDemucsModelName) {
      throw (
        lastModelError || createStemError('STEM_SPLIT_FAILED', 'Demucs 分离失败：未找到可用模型')
      )
    }
  } catch (error) {
    await fs.promises.rm(rawOutputRoot, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  try {
    const vocalsPath = resolveDemucsRawStemPath({
      rawOutputRoot,
      model: selectedDemucsModelName,
      filePath,
      stemName: 'vocals'
    })
    const drumsPath = resolveDemucsRawStemPath({
      rawOutputRoot,
      model: selectedDemucsModelName,
      filePath,
      stemName: 'drums'
    })
    const bassPath = resolveDemucsRawStemPath({
      rawOutputRoot,
      model: selectedDemucsModelName,
      filePath,
      stemName: 'bass'
    })
    const otherPath = resolveDemucsRawStemPath({
      rawOutputRoot,
      model: selectedDemucsModelName,
      filePath,
      stemName: 'other'
    })

    if (!vocalsPath || !drumsPath || !bassPath || !otherPath) {
      throw createStemError('STEM_SPLIT_OUTPUT_MISSING', 'Demucs 输出不完整，缺少 stems 文件')
    }

    await fs.promises.mkdir(stemCacheDir, { recursive: true })
    const vocalOutputPath = path.join(stemCacheDir, 'vocal.wav')
    const instOutputPath = path.join(stemCacheDir, 'inst.wav')
    const drumsOutputPath = path.join(stemCacheDir, 'drums.wav')
    const bassOutputPath = path.join(stemCacheDir, 'bass.wav')
    await fs.promises.copyFile(vocalsPath, vocalOutputPath)
    await fs.promises.copyFile(drumsPath, drumsOutputPath)

    await fs.promises.copyFile(otherPath, instOutputPath)
    await fs.promises.copyFile(bassPath, bassOutputPath)

    log.info('[mixtape-stem] demucs split done', {
      file: filePath,
      stemMode: params.stemMode,
      model: params.model,
      demucsModel: selectedDemucsModelName,
      stemProfile,
      device: selectedDevice,
      outputDir: stemCacheDir
    })
    return {
      vocalPath: vocalOutputPath,
      instPath: instOutputPath,
      bassPath: bassOutputPath,
      drumsPath: drumsOutputPath
    }
  } finally {
    await fs.promises.rm(rawOutputRoot, { recursive: true, force: true }).catch(() => {})
  }
}

const resolveStemQueueConcurrency = (): number => {
  loadStemRuntimeStateOnce()
  const cpuCount = Math.max(1, os.cpus().length || 1)
  const cpuParallel = Math.max(
    1,
    Math.min(STEM_CPU_JOB_CONCURRENCY_MAX, Math.floor(cpuCount / STEM_CPU_JOB_CORE_DIVISOR))
  )
  const hasFastJobs = hasFastStemJobInQueue()
  const onnxSnapshot = stemOnnxRuntimeProbeSnapshot
  const onnxSnapshotFresh =
    !!onnxSnapshot && Date.now() - onnxSnapshot.checkedAt <= STEM_DEVICE_PROBE_CACHE_TTL_MS
  if (hasFastJobs && !onnxSnapshotFresh) {
    return STEM_GPU_JOB_CONCURRENCY_MIN
  }
  if (hasFastJobs && onnxSnapshotFresh) {
    const hasOnnxGpu = !!onnxSnapshot && onnxSnapshot.providerCandidates.includes('directml')
    if (hasOnnxGpu) return resolveOnnxDirectmlDynamicConcurrency(cpuParallel)
    return cpuParallel
  }
  const snapshot = stemDeviceProbeSnapshot
  const snapshotFresh =
    !!snapshot && Date.now() - snapshot.checkedAt <= STEM_DEVICE_PROBE_CACHE_TTL_MS
  const hasDemucsGpu =
    !!snapshotFresh &&
    !!snapshot &&
    (snapshot.devices.includes('cuda') ||
      snapshot.devices.includes('mps') ||
      snapshot.devices.includes('xpu') ||
      snapshot.devices.includes('directml'))
  if (hasDemucsGpu) {
    const hasCuda = snapshot.devices.includes('cuda')
    if (hasCuda) {
      return Math.max(
        STEM_GPU_JOB_CONCURRENCY_MIN,
        Math.min(2, resolveGpuConcurrencyCapByResources(cpuParallel))
      )
    }
    return STEM_GPU_JOB_CONCURRENCY_MIN
  }
  return cpuParallel
}

const runQueueLoop = () => {
  const maxWorkers = Math.max(1, resolveStemQueueConcurrency())
  if (stemQueueConcurrencySnapshot !== maxWorkers) {
    stemQueueConcurrencySnapshot = maxWorkers
    log.info('[mixtape-stem] queue concurrency updated', {
      maxWorkers,
      cpuCount: Math.max(1, os.cpus().length || 1)
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
  const profile = normalizeStemProfile(params?.profile, DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE)
  const model = normalizeModel(params?.model, profile)
  const stemVersion = normalizeStemVersion(params?.stemVersion)
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
    if (!force) {
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
      merged += 1
      continue
    }
    const inFlightJob = inFlightJobMap.get(jobKey)
    if (inFlightJob) {
      mergeJobTargets(inFlightJob, queueTargets)
      merged += 1
      continue
    }
    const job: MixtapeStemQueueJob = {
      key: jobKey,
      filePath,
      stemMode,
      model,
      stemVersion,
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
  const profile = normalizeStemProfile(params?.profile, DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE)
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
