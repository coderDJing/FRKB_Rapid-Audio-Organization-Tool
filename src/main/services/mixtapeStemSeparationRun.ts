import fs from 'node:fs'
import path from 'node:path'
import { resolveBundledFfmpegPath } from '../ffmpeg'
import {
  resolveBundledDemucsModelsPath,
  resolveBundledDemucsPythonPath,
  resolveBundledDemucsRootPath,
  resolveBundledDemucsRuntimeDir
} from '../demucs'
import type { MixtapeStemMode } from '../mixtapeDb'
import {
  DEFAULT_MIXTAPE_STEM_BASE_MODEL,
  DEFAULT_MIXTAPE_STEM_PROFILE,
  parseMixtapeStemModel,
  resolveMixtapeStemBaseModelByProfile
} from '../../shared/mixtapeStemProfiles'
import { log } from '../log'
import * as shared from './mixtapeStemSeparationShared'
import * as probe from './mixtapeStemSeparationProbe'
import { decodeAudioShared } from './audioDecodePool'
import { runPersistentXpuStemInference } from './mixtapeStemPersistentXpuWorker'
import type {
  MixtapeStemComputeDevice,
  MixtapeStemCpuFallbackReasonCode,
  MixtapeStemDeviceProbeSnapshot,
  MixtapeStemRuntimeProgress,
  MixtapeStemSeparationResult
} from './mixtapeStemSeparationShared'

const {
  DEFAULT_STEM_MODEL,
  DEMUCS_NO_SPLIT_MAX_DURATION_SECONDS,
  DEMUCS_PROFILE_OPTIONS,
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
  parseDemucsProgressText,
  probeDemucsDevices,
  resolveCpuFallbackReason,
  resolveDemucsDeviceArg
} = probe

const resolveDemucsBootstrapPath = () =>
  path.join(resolveBundledDemucsRootPath(), 'bootstrap', 'mixtape_demucs_bootstrap.py')

type DemucsWaveformBootstrapInput = {
  pcmPath: string
  inputSampleRate: number
  inputChannels: number
  inputFrames: number
  pcmBytes: number
  decoderBackend: string
}

type DemucsWaveformBootstrapPayload = {
  mode: 'waveform_inference'
  inputPcmPath: string
  inputSampleRate: number
  inputChannels: number
  inputFrames: number
  device: string
  modelName: string
  modelRepoPath: string
  outputDir: string
  shifts: number
  overlap: number
  split: boolean
  segmentSec: number | null
  jobs: number
  sourcePath: string
}

const runDemucsSeparate = async (params: {
  pythonPath: string
  demucsArgs: string[]
  env: NodeJS.ProcessEnv
  timeoutMs: number
  traceLabel: string
  useBootstrap: boolean
  onStderrChunk?: (chunk: string) => void
}) => {
  if (!params.useBootstrap) {
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
  const bootstrapPath = resolveDemucsBootstrapPath()
  if (!fs.existsSync(bootstrapPath)) {
    await runProcess(params.pythonPath, ['-m', 'demucs.separate', ...params.demucsArgs], {
      env: params.env,
      timeoutMs: params.timeoutMs,
      traceLabel: params.traceLabel,
      progressIntervalMs: 30_000,
      onStderrChunk: params.onStderrChunk
    })
    return
  }
  await runProcess(params.pythonPath, [bootstrapPath, argvPayload], {
    env: params.env,
    timeoutMs: params.timeoutMs,
    traceLabel: params.traceLabel,
    progressIntervalMs: 30_000,
    onStderrChunk: params.onStderrChunk
  })
}

const prepareDemucsWaveformBootstrapInput = async (params: {
  filePath: string
  inputDir: string
}): Promise<DemucsWaveformBootstrapInput> => {
  const decoded = await decodeAudioShared(params.filePath, {
    traceLabel: 'mixtape-stem-waveform-bootstrap',
    priority: 'high'
  })
  const pcmData = Buffer.isBuffer(decoded.pcmData) ? decoded.pcmData : Buffer.from(decoded.pcmData)
  const inputSampleRate = Math.max(0, Math.floor(Number(decoded.sampleRate) || 0))
  const inputChannels = Math.max(0, Math.floor(Number(decoded.channels) || 0))
  const inputFrames = Math.max(0, Math.floor(Number(decoded.totalFrames) || 0))
  const expectedBytes = inputFrames * inputChannels * 4
  if (!pcmData.byteLength || inputSampleRate <= 0 || inputChannels <= 0 || inputFrames <= 0) {
    throw createStemError('STEM_DECODE_INVALID', 'Stem 输入解码结果无效')
  }
  if (expectedBytes > 0 && pcmData.byteLength !== expectedBytes) {
    throw createStemError(
      'STEM_DECODE_INVALID',
      `Stem 输入 PCM 字节数异常: expected=${expectedBytes} actual=${pcmData.byteLength}`
    )
  }
  await fs.promises.mkdir(params.inputDir, { recursive: true })
  const pcmPath = path.join(params.inputDir, 'input.f32')
  await fs.promises.writeFile(pcmPath, pcmData)
  return {
    pcmPath,
    inputSampleRate,
    inputChannels,
    inputFrames,
    pcmBytes: pcmData.byteLength,
    decoderBackend: normalizeText(decoded.decoderBackend, 80) || 'unknown'
  }
}

const runDemucsWaveformInference = async (params: {
  pythonPath: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  traceLabel: string
  payload: DemucsWaveformBootstrapPayload
  onStderrChunk?: (chunk: string) => void
}) => {
  const bootstrapPath = resolveDemucsBootstrapPath()
  if (!fs.existsSync(bootstrapPath)) {
    throw createStemError('STEM_BOOTSTRAP_MISSING', `未找到 Demucs bootstrap: ${bootstrapPath}`)
  }
  const payloadJson = JSON.stringify(params.payload)
  await runProcess(params.pythonPath, [bootstrapPath, payloadJson], {
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
    'weights_only',
    'weights only load failed',
    'unpickler',
    'unsupported global',
    'mps backend',
    'device type mps',
    'is not available for this process',
    'out of memory',
    'cudnn',
    'hip',
    'torchcodec',
    'libtorchcodec',
    'libtorio',
    'ffmpeg',
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
  const bootstrapInputDir = path.join(stemCacheDir, '__input')
  await fs.promises.rm(rawOutputRoot, { recursive: true, force: true }).catch(() => {})
  await fs.promises.rm(bootstrapInputDir, { recursive: true, force: true }).catch(() => {})
  await fs.promises.mkdir(rawOutputRoot, { recursive: true })

  const inputDurationSec = await probeAudioDurationSeconds(ffprobePath, filePath)
  const preferNoSplit =
    Number.isFinite(inputDurationSec) &&
    Number(inputDurationSec) > 0 &&
    Number(inputDurationSec) <= DEMUCS_NO_SPLIT_MAX_DURATION_SECONDS
  const parsedModel = parseMixtapeStemModel(params.model, DEFAULT_MIXTAPE_STEM_PROFILE)
  const requestedDemucsModelName =
    normalizeText(parsedModel.demucsModel, 128) || DEFAULT_MIXTAPE_STEM_BASE_MODEL
  const stemProfile = normalizeStemProfile(parsedModel.profile, DEFAULT_MIXTAPE_STEM_PROFILE)

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
  let waveformBootstrapInput: DemucsWaveformBootstrapInput | null = null
  let waveformBootstrapReady = false
  try {
    waveformBootstrapInput = await prepareDemucsWaveformBootstrapInput({
      filePath,
      inputDir: bootstrapInputDir
    })
    waveformBootstrapReady = fs.existsSync(resolveDemucsBootstrapPath())
    log.info('[mixtape-stem] waveform bootstrap input ready', {
      file: filePath,
      runtimeKey: deviceSnapshot.runtimeKey,
      sampleRate: waveformBootstrapInput.inputSampleRate,
      channels: waveformBootstrapInput.inputChannels,
      totalFrames: waveformBootstrapInput.inputFrames,
      pcmBytes: waveformBootstrapInput.pcmBytes,
      decoderBackend: waveformBootstrapInput.decoderBackend,
      bootstrapReady: waveformBootstrapReady
    })
  } catch (error) {
    log.warn('[mixtape-stem] waveform bootstrap input unavailable, fallback to cli', {
      file: filePath,
      runtimeKey: deviceSnapshot.runtimeKey,
      errorCode: normalizeText((error as any)?.code, 80) || null,
      errorMessage: normalizeText(error instanceof Error ? error.message : String(error || ''), 600)
    })
  }

  const demucsModelCandidates = resolveDemucsModelCandidates({
    requestedModel: requestedDemucsModelName,
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
      const profileOptions = DEMUCS_PROFILE_OPTIONS[stemProfile] || DEMUCS_PROFILE_OPTIONS.quality
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
        cpuNoSplitEnabled: false,
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
        const allowNoSplit = preferNoSplit && device !== 'cpu' && device !== 'xpu'
        const runWaveformBootstrap = async (split: boolean) => {
          if (!waveformBootstrapInput || !waveformBootstrapReady) {
            throw createStemError('STEM_BOOTSTRAP_UNAVAILABLE', 'Waveform bootstrap 不可用')
          }
          const payload: DemucsWaveformBootstrapPayload = {
            mode: 'waveform_inference',
            inputPcmPath: waveformBootstrapInput.pcmPath,
            inputSampleRate: waveformBootstrapInput.inputSampleRate,
            inputChannels: waveformBootstrapInput.inputChannels,
            inputFrames: waveformBootstrapInput.inputFrames,
            device: demucsDeviceArg,
            modelName: demucsModelName,
            modelRepoPath,
            outputDir: rawOutputRoot,
            shifts: Math.max(1, Number(profileOptions.shifts) || 1),
            overlap: Math.max(0, Number(profileOptions.overlap) || 0),
            split,
            segmentSec: split ? Math.max(1, Number(demucsSegmentSec) || 1) : null,
            jobs: 1,
            sourcePath: filePath
          }
          if (device === 'xpu') {
            try {
              await runPersistentXpuStemInference({
                pythonPath,
                env,
                timeoutMs: processTimeoutMs,
                traceLabel: `mixtape-stem-waveform:${demucsModelName}:${device}`,
                payload,
                onStderrChunk: handleStderrChunk
              })
              return
            } catch (error) {
              const errorCode = normalizeText((error as any)?.code, 80) || 'XPU_WORKER_FALLBACK'
              const errorMessage = normalizeText(
                error instanceof Error
                  ? error.message
                  : String(error || 'persistent xpu worker failed'),
                800
              )
              log.warn('[mixtape-stem] persistent xpu worker fallback to legacy process', {
                file: filePath,
                demucsModel: demucsModelName,
                errorCode,
                errorMessage
              })
              await fs.promises.rm(rawOutputRoot, { recursive: true, force: true }).catch(() => {})
              await fs.promises.mkdir(rawOutputRoot, { recursive: true })
            }
          }
          await runDemucsWaveformInference({
            pythonPath,
            env,
            timeoutMs: processTimeoutMs,
            traceLabel: `mixtape-stem-waveform:${demucsModelName}:${device}`,
            payload,
            onStderrChunk: handleStderrChunk
          })
        }
        const runDeviceInference = async (split: boolean) => {
          if (waveformBootstrapInput && waveformBootstrapReady) {
            await runWaveformBootstrap(split)
            return
          }
          await runDemucsSeparate({
            pythonPath,
            demucsArgs: split ? demucsSplitArgs : demucsNoSplitArgs,
            env,
            timeoutMs: processTimeoutMs,
            traceLabel: `mixtape-stem-demucs:${demucsModelName}:${device}`,
            useBootstrap: device !== 'cpu',
            onStderrChunk: handleStderrChunk
          })
        }
        if (!allowNoSplit) {
          await runDeviceInference(true)
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
          await runDeviceInference(false)
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
          await runDeviceInference(true)
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
    await fs.promises.rm(bootstrapInputDir, { recursive: true, force: true }).catch(() => {})
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
    await fs.promises.copyFile(bassPath, bassOutputPath)
    await fs.promises.copyFile(otherPath, instOutputPath)

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
    await fs.promises.rm(bootstrapInputDir, { recursive: true, force: true }).catch(() => {})
  }
}
