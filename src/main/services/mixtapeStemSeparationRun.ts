import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveBundledFfmpegPath } from '../ffmpeg'
import {
  resolveBundledDemucsModelsPath,
  resolveBundledDemucsOnnxPath,
  resolveBundledDemucsPythonPath,
  resolveBundledDemucsRuntimeDir
} from '../demucs'
import type { MixtapeStemMode } from '../mixtapeDb'
import {
  DEFAULT_MIXTAPE_STEM_BASE_MODEL,
  DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE,
  parseMixtapeStemModel,
  type MixtapeStemProfile,
  resolveMixtapeStemBaseModelByProfile
} from '../../shared/mixtapeStemProfiles'
import { log } from '../log'
import * as shared from './mixtapeStemSeparationShared'
import * as probe from './mixtapeStemSeparationProbe'
import type {
  MixtapeStemComputeDevice,
  MixtapeStemCpuFallbackReasonCode,
  MixtapeStemDeviceProbeSnapshot,
  MixtapeStemOnnxProvider,
  MixtapeStemOnnxRuntimeProbeSnapshot,
  MixtapeStemRuntimeProgress,
  MixtapeStemSeparationResult
} from './mixtapeStemSeparationShared'

const {
  DEFAULT_STEM_MODEL,
  DEMUCS_NO_SPLIT_MAX_DURATION_SECONDS,
  DEMUCS_PROFILE_OPTIONS,
  ONNX_FAST_MODEL_FILE_NAME,
  ONNX_FAST_SCRIPT_FILE_NAME,
  buildStemProcessEnv,
  createStemError,
  normalizeFilePath,
  normalizeText,
  normalizeStemProfile,
  probeAudioDurationSeconds,
  resolveBundledFfprobePath,
  resolveDemucsSegmentSec,
  resolveDemucsRawStemPath,
  resolveStemCacheDir,
  resolveStemProcessTimeoutMs,
  runProcess
} = shared

const {
  acquireOnnxDirectmlAttemptLease,
  markOnnxDirectmlRuntimeFailure,
  markOnnxDirectmlRuntimeSuccess,
  parseDemucsProgressText,
  parseOnnxFastProgressText,
  parseOnnxFastResultText,
  probeDemucsDevices,
  probeOnnxRuntime,
  resolveCpuFallbackReason,
  resolveDemucsDeviceArg,
  resolveOnnxFastProviderCandidates,
  shouldSerializeOnnxDirectmlAttempts,
  shouldSuppressOnnxDirectmlByRecentFailure,
  summarizeOnnxErrorForLog
} = probe

export const copyOnnxStemOutputsToCache = async (params: {
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

type OnnxFastExecutionOptions = {
  overlap: string
  torchThreads: string
  refineTopkRatio: string
  refineMaxChunks: string
  refineOffsetRatio: string
  refineMinScore: string
}

const resolveOnnxFastExecutionOptions = (params: {
  provider: MixtapeStemOnnxProvider
  inputDurationSec: number | null
}): OnnxFastExecutionOptions => {
  const isDirectml = params.provider === 'directml'
  const durationSec =
    Number.isFinite(params.inputDurationSec) && Number(params.inputDurationSec) > 0
      ? Number(params.inputDurationSec)
      : null
  const isShortTrack = durationSec !== null && durationSec <= 4 * 60
  const isLongTrack = durationSec !== null && durationSec >= 9 * 60
  const cpuCount = Math.max(1, os.cpus()?.length || 1)
  const toArgFloat = (value: number): string => String(Number(value.toFixed(4)))

  const overlap = isDirectml
    ? isShortTrack
      ? 0.5
      : isLongTrack
        ? 0.42
        : 0.46
    : isShortTrack
      ? 0.43
      : isLongTrack
        ? 0.34
        : 0.38
  const torchThreads = isDirectml ? (cpuCount >= 12 ? 3 : cpuCount >= 6 ? 2 : 1) : 1
  const refineTopkRatio = isDirectml
    ? isShortTrack
      ? 0.2
      : isLongTrack
        ? 0.12
        : 0.16
    : isShortTrack
      ? 0.1
      : isLongTrack
        ? 0.04
        : 0.07
  const refineMaxChunks = isDirectml
    ? isShortTrack
      ? 26
      : isLongTrack
        ? 14
        : 20
    : isLongTrack
      ? 6
      : 10
  const refineOffsetRatio = isDirectml ? 0.5 : 0.45
  const refineMinScore = isDirectml ? 0.03 : 0.05

  return {
    overlap: toArgFloat(overlap),
    torchThreads: String(torchThreads),
    refineTopkRatio: toArgFloat(refineTopkRatio),
    refineMaxChunks: String(refineMaxChunks),
    refineOffsetRatio: toArgFloat(refineOffsetRatio),
    refineMinScore: toArgFloat(refineMinScore)
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
    const onnxExecutionOptions = resolveOnnxFastExecutionOptions({
      provider,
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
      log.info('[mixtape-stem] onnx fast tuning', {
        file: params.filePath,
        runtimeKey: params.onnxRuntimeSnapshot.runtimeKey,
        provider,
        inputDurationSec: params.inputDurationSec,
        overlap: onnxExecutionOptions.overlap,
        torchThreads: Number(onnxExecutionOptions.torchThreads),
        refineTopkRatio: Number(onnxExecutionOptions.refineTopkRatio),
        refineMaxChunks: Number(onnxExecutionOptions.refineMaxChunks),
        refineOffsetRatio: Number(onnxExecutionOptions.refineOffsetRatio),
        refineMinScore: Number(onnxExecutionOptions.refineMinScore)
      })

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
          onnxExecutionOptions.overlap,
          '--torch-threads',
          onnxExecutionOptions.torchThreads,
          '--refine-topk-ratio',
          onnxExecutionOptions.refineTopkRatio,
          '--refine-max-chunks',
          onnxExecutionOptions.refineMaxChunks,
          '--refine-offset-ratio',
          onnxExecutionOptions.refineOffsetRatio,
          '--refine-min-score',
          onnxExecutionOptions.refineMinScore
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

export const runStemSeparation = async (params: {
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
