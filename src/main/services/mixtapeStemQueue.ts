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
  DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE,
  normalizeMixtapeStemProfile,
  parseMixtapeStemModel,
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

const STEM_GPU_JOB_CONCURRENCY = 1
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
const DEFAULT_STEM_MODEL = `${DEFAULT_MIXTAPE_STEM_BASE_MODEL}@${DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE}`
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

const toDemucsSegmentSecArg = (value: number): string => {
  const parsed = Number(value)
  const safeValue = Number.isFinite(parsed) && parsed > 0 ? parsed : 7
  return String(Math.max(1, Math.floor(safeValue)))
}

const resolveDemucsSegmentSec = (params: { demucsModel: string; requestedSegmentSec: string }): string => {
  const requested = Number(params.requestedSegmentSec)
  const safeRequested = Number.isFinite(requested) && requested > 0 ? requested : 7
  const model = normalizeText(params.demucsModel, 128).toLowerCase()
  const capped =
    model.includes('htdemucs')
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
          createStemError(
            'STEM_SPLIT_TIMEOUT',
            `${timeoutText}${output ? `: ${output}` : ''}`
          )
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
    timeoutTimer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {}
    }, Math.max(1000, Number(params.timeoutMs) || 10_000))
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

const probeAudioDurationSeconds = async (ffprobePath: string, filePath: string): Promise<number | null> => {
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
    const selectedRuntimeSnapshot =
      runtimeSnapshots.reduce<MixtapeStemDeviceProbeSnapshot | null>((best, current) => {
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
      }, null) ||
      {
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
): { percent: number; processedSec: number | null; totalSec: number | null; etaSec: number | null } | null => {
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
  const runtimeDir = normalizeFilePath(deviceSnapshot.runtimeDir) || resolveBundledDemucsRuntimeDir()
  const pythonPath =
    normalizeFilePath(deviceSnapshot.pythonPath) || resolveBundledDemucsPythonPath(runtimeDir)
  if (!fs.existsSync(pythonPath)) {
    throw createStemError(
      'STEM_ENGINE_MISSING',
      `未找到 Demucs 运行时: ${pythonPath} (runtime=${deviceSnapshot.runtimeKey})`
    )
  }

  const stemCacheDir = await resolveStemCacheDir({
    filePath,
    model: params.model,
    stemMode: params.stemMode
  })
  const rawOutputRoot = path.join(stemCacheDir, '__raw')
  await fs.promises.rm(rawOutputRoot, { recursive: true, force: true }).catch(() => {})
  await fs.promises.mkdir(rawOutputRoot, { recursive: true })

  const env = buildStemProcessEnv(runtimeDir, ffmpegPath)

  const inputDurationSec = await probeAudioDurationSeconds(ffprobePath, filePath)
  const preferNoSplit =
    Number.isFinite(inputDurationSec) &&
    Number(inputDurationSec) > 0 &&
    Number(inputDurationSec) <= DEMUCS_NO_SPLIT_MAX_DURATION_SECONDS
  const parsedModel = parseMixtapeStemModel(params.model, DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE)
  const demucsModelName =
    normalizeText(parsedModel.demucsModel, 128) || DEFAULT_MIXTAPE_STEM_BASE_MODEL
  const stemProfile = normalizeStemProfile(
    parsedModel.profile,
    DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE
  )
  const profileOptions = DEMUCS_PROFILE_OPTIONS[stemProfile] || DEMUCS_PROFILE_OPTIONS.fast
  const demucsSegmentSec = resolveDemucsSegmentSec({
    demucsModel: demucsModelName,
    requestedSegmentSec: profileOptions.segmentSec
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
  log.info('[mixtape-stem] demucs profile', {
    file: filePath,
    model: params.model,
    demucsModel: demucsModelName,
    stemProfile,
    runtimeKey: deviceSnapshot.runtimeKey,
    runtimeDir: deviceSnapshot.runtimeDir,
    preferNoSplit,
    cpuNoSplitDisabled: true,
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
      totalSec: Number.isFinite(inputDurationSec) && Number(inputDurationSec) > 0 ? inputDurationSec : null,
      etaSec: null
    })
    const allowNoSplit = preferNoSplit && device !== 'cpu'
    if (!allowNoSplit) {
      await runDemucsSeparate({
        pythonPath,
        demucsArgs: demucsSplitArgs,
        env,
        timeoutMs: processTimeoutMs,
        traceLabel: `mixtape-stem-demucs:${device}`,
        useDirectmlBootstrap: device === 'directml',
        onStderrChunk: handleStderrChunk
      })
      emitProgress({
        percent: 100,
        processedSec: Number.isFinite(inputDurationSec) && Number(inputDurationSec) > 0 ? inputDurationSec : null,
        totalSec: Number.isFinite(inputDurationSec) && Number(inputDurationSec) > 0 ? inputDurationSec : null,
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
        traceLabel: `mixtape-stem-demucs:${device}`,
        useDirectmlBootstrap: device === 'directml',
        onStderrChunk: handleStderrChunk
      })
      emitProgress({
        percent: 100,
        processedSec: Number.isFinite(inputDurationSec) && Number(inputDurationSec) > 0 ? inputDurationSec : null,
        totalSec: Number.isFinite(inputDurationSec) && Number(inputDurationSec) > 0 ? inputDurationSec : null,
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
        traceLabel: `mixtape-stem-demucs:${device}`,
        useDirectmlBootstrap: device === 'directml',
        onStderrChunk: handleStderrChunk
      })
      emitProgress({
        percent: 100,
        processedSec: Number.isFinite(inputDurationSec) && Number(inputDurationSec) > 0 ? inputDurationSec : null,
        totalSec: Number.isFinite(inputDurationSec) && Number(inputDurationSec) > 0 ? inputDurationSec : null,
        etaSec: 0
      })
    }
  }

  let selectedDevice: MixtapeStemComputeDevice | null = null
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
        selectedDevice = device
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
    if (!selectedDevice) {
      throw (
        lastDeviceError || createStemError('STEM_SPLIT_FAILED', 'Demucs 分离失败：未找到可用设备')
      )
    }
  } catch (error) {
    await fs.promises.rm(rawOutputRoot, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  try {
    const vocalsPath = resolveDemucsRawStemPath({
      rawOutputRoot,
      model: demucsModelName,
      filePath,
      stemName: 'vocals'
    })
    const drumsPath = resolveDemucsRawStemPath({
      rawOutputRoot,
      model: demucsModelName,
      filePath,
      stemName: 'drums'
    })
    const bassPath = resolveDemucsRawStemPath({
      rawOutputRoot,
      model: demucsModelName,
      filePath,
      stemName: 'bass'
    })
    const otherPath = resolveDemucsRawStemPath({
      rawOutputRoot,
      model: demucsModelName,
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
      demucsModel: demucsModelName,
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
  const cpuCount = Math.max(1, os.cpus().length || 1)
  const cpuParallel = Math.max(
    1,
    Math.min(STEM_CPU_JOB_CONCURRENCY_MAX, Math.floor(cpuCount / STEM_CPU_JOB_CORE_DIVISOR))
  )
  const snapshot = stemDeviceProbeSnapshot
  const snapshotFresh =
    !!snapshot && Date.now() - snapshot.checkedAt <= STEM_DEVICE_PROBE_CACHE_TTL_MS
  if (!snapshotFresh) return cpuParallel
  const hasGpu =
    snapshot.devices.includes('cuda') ||
    snapshot.devices.includes('mps') ||
    snapshot.devices.includes('xpu') ||
    snapshot.devices.includes('directml')
  return hasGpu ? STEM_GPU_JOB_CONCURRENCY : cpuParallel
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
    log.error('[mixtape-stem] demucs split failed', {
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
