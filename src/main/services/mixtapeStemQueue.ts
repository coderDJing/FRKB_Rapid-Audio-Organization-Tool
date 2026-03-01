import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
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

const STEM_JOB_CONCURRENCY = 1
const STEM_PROCESS_TIMEOUT_MS = 60 * 60 * 1000
const STEM_CPU_PROCESS_TIMEOUT_CAP_MS = 8 * 60 * 1000
const STEM_GPU_PROCESS_TIMEOUT_CAP_MS = STEM_PROCESS_TIMEOUT_MS
const STEM_CPU_PROCESS_TIMEOUT_MIN_MS = 4 * 60 * 1000
const STEM_GPU_PROCESS_TIMEOUT_MIN_MS = 3 * 60 * 1000
const STEM_FFPROBE_TIMEOUT_MS = 20_000
const STEM_DEVICE_PROBE_TIMEOUT_MS = 15_000
const STEM_DEVICE_PROBE_CACHE_TTL_MS = 5 * 60 * 1000
const DEMUCS_NO_SPLIT_MAX_DURATION_SECONDS = 7 * 60
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
  harmonicPath?: string | null
  bassPath?: string | null
  drumsPath?: string | null
}

type MixtapeStemComputeDevice = 'cuda' | 'mps' | 'cpu'

type MixtapeStemDeviceProbeSnapshot = {
  checkedAt: number
  devices: MixtapeStemComputeDevice[]
  cudaAvailable: boolean
  mpsAvailable: boolean
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

const normalizeStemMode = (_value: unknown): MixtapeStemMode => '4stems'

const normalizeText = (value: unknown, maxLen = 2000): string => {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.length <= maxLen ? trimmed : trimmed.slice(0, maxLen)
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
    stemHarmonicPath?: string | null
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
        stemHarmonicPath: Object.prototype.hasOwnProperty.call(extra || {}, 'stemHarmonicPath')
          ? extra?.stemHarmonicPath || null
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
  return [result.vocalPath, result.harmonicPath, result.bassPath, result.drumsPath]
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
    harmonicPath: asset.harmonicPath,
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
  harmonicPath?: string | null
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
      harmonicPath: params.harmonicPath || null,
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
    traceLabel?: string
    progressIntervalMs?: number
  }
) => {
  await new Promise<void>((resolve, reject) => {
    const traceLabel = normalizeText(options?.traceLabel, 120) || 'mixtape-stem-process'
    const startedAt = Date.now()
    const progressIntervalMs = Math.max(10_000, Number(options?.progressIntervalMs) || 30_000)
    const child = childProcess.spawn(command, args, {
      cwd: options?.cwd,
      env: options?.env,
      windowsHide: true
    })
    let stderrText = ''
    let stdoutText = ''
    let timedOut = false
    const timeoutMs = Math.max(10_000, Number(options?.timeoutMs) || STEM_PROCESS_TIMEOUT_MS)
    const progressTimer = setInterval(() => {
      log.info(`[${traceLabel}] process running`, {
        elapsedMs: Date.now() - startedAt,
        timeoutMs
      })
    }, progressIntervalMs)
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {}
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => {
      const text = String(chunk || '')
      if (!text) return
      stdoutText += text
      if (stdoutText.length > 4000) {
        stdoutText = stdoutText.slice(-4000)
      }
    })
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk || '')
      if (!text) return
      stderrText += text
      if (stderrText.length > 6000) {
        stderrText = stderrText.slice(-6000)
      }
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      clearInterval(progressTimer)
      reject(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      clearInterval(progressTimer)
      if (timedOut) {
        const output = normalizeText(`${stderrText}\n${stdoutText}`, 3000)
        reject(
          createStemError(
            'STEM_SPLIT_TIMEOUT',
            `分离超时（${Math.round(timeoutMs / 1000)} 秒）${output ? `: ${output}` : ''}`
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

const probeAudioDurationSeconds = (ffprobePath: string, filePath: string): number | null => {
  if (!ffprobePath || !filePath) return null
  if (!fs.existsSync(ffprobePath)) return null
  try {
    const result = childProcess.spawnSync(
      ffprobePath,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=nokey=1:noprint_wrappers=1',
        filePath
      ],
      {
        windowsHide: true,
        encoding: 'utf8',
        timeout: STEM_FFPROBE_TIMEOUT_MS
      }
    )
    if (result?.status !== 0) return null
    const output = normalizeText(result?.stdout, 120) || ''
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
  return ['cuda', 'mps', 'cpu']
}

const probeDemucsDevices = (
  pythonPath: string,
  env: NodeJS.ProcessEnv
): MixtapeStemDeviceProbeSnapshot => {
  const now = Date.now()
  if (
    stemDeviceProbeSnapshot &&
    now - stemDeviceProbeSnapshot.checkedAt <= STEM_DEVICE_PROBE_CACHE_TTL_MS
  ) {
    return stemDeviceProbeSnapshot
  }
  const priority = resolveStemDevicePriority()
  let cudaAvailable = false
  let mpsAvailable = false
  let probeError = ''
  try {
    const result = childProcess.spawnSync(
      pythonPath,
      [
        '-c',
        [
          'import json',
          'try:',
          '  import torch',
          '  cuda = bool(getattr(torch, "cuda", None) and torch.cuda.is_available())',
          '  mps_backend = getattr(torch.backends, "mps", None)',
          '  mps = bool(mps_backend and mps_backend.is_available())',
          '  print(json.dumps({"cuda": cuda, "mps": mps}))',
          'except Exception as exc:',
          '  print(json.dumps({"cuda": False, "mps": False, "error": str(exc)}))'
        ].join('\n')
      ],
      {
        windowsHide: true,
        encoding: 'utf8',
        timeout: STEM_DEVICE_PROBE_TIMEOUT_MS,
        env
      }
    )
    const stdoutText = normalizeText(result?.stdout, 1200)
    const stderrText = normalizeText(result?.stderr, 1200)
    if (result?.status === 0 && stdoutText) {
      const lines = stdoutText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      const lastLine = lines.at(-1) || ''
      const parsed = JSON.parse(lastLine) as { cuda?: unknown; mps?: unknown; error?: unknown }
      cudaAvailable = !!parsed?.cuda
      mpsAvailable = !!parsed?.mps
      probeError = normalizeText(parsed?.error, 400)
    } else {
      probeError = stderrText || stdoutText || `probe exit ${result?.status ?? -1}`
    }
  } catch (error) {
    probeError = normalizeText(error instanceof Error ? error.message : String(error || ''), 400)
  }

  const available = new Set<MixtapeStemComputeDevice>(['cpu'])
  if (cudaAvailable) available.add('cuda')
  if (mpsAvailable) available.add('mps')
  const devices = priority.filter((device) => available.has(device))
  if (!devices.includes('cpu')) devices.push('cpu')
  const snapshot: MixtapeStemDeviceProbeSnapshot = {
    checkedAt: now,
    devices,
    cudaAvailable,
    mpsAvailable
  }
  stemDeviceProbeSnapshot = snapshot
  log.info('[mixtape-stem] demucs device probe', {
    devices,
    cudaAvailable,
    mpsAvailable,
    probeError: probeError || null
  })
  return snapshot
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
    'hip'
  ]
  return patterns.some((pattern) => message.includes(pattern))
}

const runStemSeparation = async (params: {
  filePath: string
  stemMode: MixtapeStemMode
  model: string
}): Promise<MixtapeStemSeparationResult> => {
  const filePath = normalizeFilePath(params.filePath)
  if (!filePath || !fs.existsSync(filePath)) {
    throw createStemError('STEM_SOURCE_MISSING', 'Stem 源文件不存在')
  }
  const pythonPath = resolveBundledDemucsPythonPath()
  const runtimeDir = resolveBundledDemucsRuntimeDir()
  const modelRepoPath = resolveBundledDemucsModelsPath()
  const ffmpegPath = resolveBundledFfmpegPath()
  const ffprobePath = resolveBundledFfprobePath()
  if (!fs.existsSync(pythonPath)) {
    throw createStemError('STEM_ENGINE_MISSING', `未找到 Demucs 运行时: ${pythonPath}`)
  }
  if (!fs.existsSync(modelRepoPath)) {
    throw createStemError('STEM_MODEL_MISSING', `未找到 Demucs 模型目录: ${modelRepoPath}`)
  }
  if (!fs.existsSync(ffmpegPath)) {
    throw createStemError('STEM_FFMPEG_MISSING', `未找到 ffmpeg: ${ffmpegPath}`)
  }
  if (!fs.existsSync(ffprobePath)) {
    throw createStemError('STEM_FFPROBE_MISSING', `未找到 ffprobe: ${ffprobePath}`)
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

  const inputDurationSec = probeAudioDurationSeconds(ffprobePath, filePath)
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
  const deviceSnapshot = probeDemucsDevices(pythonPath, env)
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
    preferNoSplit,
    cpuNoSplitDisabled: true,
    inputDurationSec,
    deviceCandidates,
    timeoutHintMsByDevice,
    shifts: Number(profileOptions.shifts),
    overlap: Number(profileOptions.overlap),
    segmentSec: Number(profileOptions.segmentSec)
  })

  const runDemucsForDevice = async (device: MixtapeStemComputeDevice) => {
    const processTimeoutMs = resolveStemProcessTimeoutMs({
      device,
      inputDurationSec
    })
    const demucsBaseArgs = [
      '-m',
      'demucs.separate',
      '-n',
      demucsModelName,
      '--repo',
      modelRepoPath,
      '-d',
      device,
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
      profileOptions.segmentSec,
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
      timeoutMs: processTimeoutMs
    })
    const allowNoSplit = preferNoSplit && device !== 'cpu'
    if (!allowNoSplit) {
      await runProcess(pythonPath, demucsSplitArgs, {
        env,
        timeoutMs: processTimeoutMs,
        traceLabel: `mixtape-stem-demucs:${device}`,
        progressIntervalMs: 30_000
      })
      return
    }
    try {
      await runProcess(pythonPath, demucsNoSplitArgs, {
        env,
        timeoutMs: processTimeoutMs,
        traceLabel: `mixtape-stem-demucs:${device}`,
        progressIntervalMs: 30_000
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
      await runProcess(pythonPath, demucsSplitArgs, {
        env,
        timeoutMs: processTimeoutMs,
        traceLabel: `mixtape-stem-demucs:${device}`,
        progressIntervalMs: 30_000
      })
    }
  }

  let selectedDevice: MixtapeStemComputeDevice | null = null
  let lastDeviceError: unknown = null
  try {
    for (let index = 0; index < deviceCandidates.length; index += 1) {
      const device = deviceCandidates[index]
      try {
        await runDemucsForDevice(device)
        selectedDevice = device
        break
      } catch (error) {
        lastDeviceError = error
        const hasNext = index < deviceCandidates.length - 1
        const retryable = hasNext && shouldRetryWithNextDevice(error)
        log.warn('[mixtape-stem] demucs device failed', {
          file: filePath,
          model: params.model,
          demucsModel: demucsModelName,
          stemProfile,
          device,
          errorCode: normalizeText((error as any)?.code, 80) || null,
          errorMessage: normalizeText(
            error instanceof Error ? error.message : String(error || ''),
            800
          ),
          retryWithNextDevice: retryable
        })
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
    const harmonicOutputPath = path.join(stemCacheDir, 'harmonic.wav')
    const drumsOutputPath = path.join(stemCacheDir, 'drums.wav')
    const bassOutputPath = path.join(stemCacheDir, 'bass.wav')
    await fs.promises.copyFile(vocalsPath, vocalOutputPath)
    await fs.promises.copyFile(drumsPath, drumsOutputPath)

    await fs.promises.copyFile(otherPath, harmonicOutputPath)
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
      harmonicPath: harmonicOutputPath,
      bassPath: bassOutputPath,
      drumsPath: drumsOutputPath
    }
  } finally {
    await fs.promises.rm(rawOutputRoot, { recursive: true, force: true }).catch(() => {})
  }
}

const runQueueLoop = () => {
  while (activeWorkers < STEM_JOB_CONCURRENCY && pendingQueue.length > 0) {
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
    stemHarmonicPath: null,
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
      model: job.model
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
      harmonicPath: separation.harmonicPath || null,
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
      stemHarmonicPath: separation.harmonicPath || null,
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
      harmonicPath: separation.harmonicPath || null,
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
      stemHarmonicPath: null,
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
          stemHarmonicPath: cachedAsset?.harmonicPath || null,
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
          harmonicPath: cachedAsset?.harmonicPath || null,
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
      stemHarmonicPath: null,
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
