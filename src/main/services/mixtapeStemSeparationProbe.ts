import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  resolveBundledDemucsOnnxPath,
  resolveBundledDemucsPythonPath,
  resolveBundledDemucsRuntimeCandidates,
  resolveBundledDemucsRuntimeDir,
  type BundledDemucsRuntimeCandidate
} from '../demucs'
import { log } from '../log'
import * as shared from './mixtapeStemSeparationShared'
import type {
  MixtapeStemComputeDevice,
  MixtapeStemCpuFallbackReasonCode,
  MixtapeStemDeviceProbeSnapshot,
  MixtapeStemOnnxDirectmlRuntimeStats,
  MixtapeStemOnnxProgressPayload,
  MixtapeStemOnnxProvider,
  MixtapeStemOnnxResultPayload,
  MixtapeStemOnnxRuntimeProbeEntry,
  MixtapeStemOnnxRuntimeProbeSnapshot
} from './mixtapeStemSeparationShared'
const {
  ONNX_DIRECTML_FAILURE_COOLDOWN_MS,
  ONNX_FAST_MODEL_FILE_NAME,
  ONNX_FAST_PROGRESS_PREFIX,
  ONNX_FAST_RESULT_PREFIX,
  STEM_DEVICE_COMPATIBILITY_TIMEOUT_MS,
  STEM_DEVICE_PROBE_CACHE_TTL_MS,
  STEM_DEVICE_PROBE_TIMEOUT_MS,
  STEM_FREE_MEMORY_GB_FOR_GPU_CONCURRENCY_2,
  STEM_FREE_MEMORY_GB_FOR_GPU_CONCURRENCY_3,
  STEM_GPU_JOB_CONCURRENCY_DIRECTML_MAX,
  STEM_GPU_JOB_CONCURRENCY_MAX,
  STEM_GPU_JOB_CONCURRENCY_MIN,
  STEM_ONNX_DIRECTML_CONCURRENCY_HIGH_SUCCESS,
  STEM_ONNX_DIRECTML_CONCURRENCY_WARMUP_SUCCESS,
  STEM_SYSTEM_MEMORY_GB_FOR_GPU_CONCURRENCY_2,
  STEM_SYSTEM_MEMORY_GB_FOR_GPU_CONCURRENCY_3,
  STEM_WINDOWS_GPU_ADAPTER_PROBE_TIMEOUT_MS,
  buildStemProcessEnv,
  loadStemRuntimeStateOnce,
  normalizeFilePath,
  normalizeNumberOrNull,
  normalizeText,
  runProbeProcess,
  schedulePersistStemRuntimeState,
  resolveStemDevicePriority
} = shared
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
export const probeWindowsGpuAdapters = async () => {
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
export {
  probeTorchDeviceCompatibility,
  probeDirectmlDemucsCompatibility,
  probeXpuDemucsCompatibility,
  probeDemucsDevicesForRuntime,
  resolveProbeSnapshotDeviceScore,
  resolveProbeSnapshotTieBreakScore,
  probeDemucsDevices,
  resolveOnnxProviderCandidatesFromNames,
  probeOnnxRuntimeForRuntime,
  resolveOnnxRuntimeProbeScore,
  probeOnnxRuntime,
  resolveCpuFallbackReason,
  resolveDemucsDeviceArg,
  parseClockTokenToSeconds,
  parseDemucsProgressText,
  parseOnnxFastProgressText,
  parseOnnxFastResultText,
  summarizeOnnxErrorForLog,
  shouldSuppressOnnxDirectmlByRecentFailure,
  resolveSystemMemoryGiB,
  resolveSystemFreeMemoryGiB,
  resolveGpuConcurrencyCapByResources,
  resolveOnnxDirectmlDynamicConcurrency,
  shouldSerializeOnnxDirectmlAttempts,
  acquireOnnxDirectmlAttemptLease,
  markOnnxDirectmlRuntimeFailure,
  markOnnxDirectmlRuntimeSuccess,
  resolveOnnxFastProviderCandidates
}
