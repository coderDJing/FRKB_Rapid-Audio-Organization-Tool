import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  resolveBundledDemucsPythonPath,
  resolveBundledDemucsRuntimeCandidates,
  resolveBundledDemucsRuntimeDir,
  type BundledDemucsRuntimeCandidate
} from '../demucs'
import * as shared from './mixtapeStemSeparationShared'
import {
  probeDirectmlDemucsCompatibility,
  probeTorchDeviceCompatibility,
  probeXpuDemucsCompatibility
} from './mixtapeStemSeparationCompat'
import type {
  MixtapeStemComputeDevice,
  MixtapeStemCpuFallbackReasonCode,
  MixtapeStemDeviceProbeSnapshot
} from './mixtapeStemSeparationShared'
const {
  STEM_DEVICE_COMPATIBILITY_TIMEOUT_MS,
  STEM_DEVICE_PROBE_CACHE_TTL_MS,
  STEM_DEVICE_PROBE_TIMEOUT_MS,
  STEM_FREE_MEMORY_GB_FOR_GPU_CONCURRENCY_2,
  STEM_FREE_MEMORY_GB_FOR_GPU_CONCURRENCY_3,
  STEM_GPU_JOB_CONCURRENCY_DIRECTML_MAX,
  STEM_GPU_JOB_CONCURRENCY_MAX,
  STEM_GPU_JOB_CONCURRENCY_MIN,
  STEM_SYSTEM_MEMORY_GB_FOR_GPU_CONCURRENCY_2,
  STEM_SYSTEM_MEMORY_GB_FOR_GPU_CONCURRENCY_3,
  STEM_WINDOWS_GPU_ADAPTER_PROBE_TIMEOUT_MS,
  buildStemProcessEnv,
  normalizeFilePath,
  normalizeNumberOrNull,
  normalizeText,
  runProbeProcess,
  resolveStemDevicePriority
} = shared
let stemDeviceProbeSnapshot: MixtapeStemDeviceProbeSnapshot | null = null
let stemDeviceProbePromise: Promise<MixtapeStemDeviceProbeSnapshot> | null = null
const getCachedStemDeviceProbeSnapshot = () => stemDeviceProbeSnapshot
const invalidateStemDeviceProbeCache = () => {
  stemDeviceProbeSnapshot = null
  stemDeviceProbePromise = null
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
    return emptyResult
  }
}
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
  let runtimeUsable = false
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
      const torchImportError = normalizeText(parsed?.error, 400)
      cudaAvailable = !!parsed?.cuda
      mpsAvailable = !!parsed?.mps
      xpuAvailable = !!parsed?.xpu
      xpuBackendInstalled = !!parsed?.xpu_backend_installed
      directmlAvailable = !!parsed?.directml
      directmlBackendInstalled = !!parsed?.directml_backend_installed
      directmlDevice = normalizeText(parsed?.directml_device, 80)
      runtimeUsable = !torchImportError
      probeError = normalizeText(
        torchImportError || parsed?.directml_error || parsed?.directml_import_error,
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
      probeError = result.timedOut
        ? `probe timed out after ${STEM_DEVICE_PROBE_TIMEOUT_MS}ms`
        : result.error || stderrText || stdoutText || `probe exit ${result.status ?? -1}`
    }
  } catch (error) {
    probeError = normalizeText(error instanceof Error ? error.message : String(error || ''), 400)
  }
  const available = new Set<MixtapeStemComputeDevice>()
  if (runtimeUsable) available.add('cpu')
  if (cudaAvailable) available.add('cuda')
  if (mpsAvailable) available.add('mps')
  if (xpuAvailable) available.add('xpu')
  if (directmlAvailable) available.add('directml')
  const devices = priority.filter((device) => available.has(device))
  if (runtimeUsable && !devices.includes('cpu')) devices.push('cpu')
  const snapshot: MixtapeStemDeviceProbeSnapshot = {
    checkedAt: params.checkedAt,
    runtimeKey: normalizeText(params.runtimeCandidate.key, 64) || 'runtime',
    runtimeDir: params.runtimeCandidate.runtimeDir,
    pythonPath: params.runtimeCandidate.pythonPath,
    runtimeUsable,
    probeError,
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
  return snapshot
}
const resolveProbeSnapshotDeviceScore = (snapshot: MixtapeStemDeviceProbeSnapshot): number => {
  if (!snapshot.runtimeUsable || snapshot.devices.length === 0) {
    return Number.MAX_SAFE_INTEGER
  }
  const priority = resolveStemDevicePriority()
  const targetDevice = snapshot.devices.find((device) => device !== 'cpu') || 'cpu'
  const score = priority.findIndex((device) => device === targetDevice)
  if (score >= 0) return score
  return Number.MAX_SAFE_INTEGER
}
const resolveProbeSnapshotTieBreakScore = (snapshot: MixtapeStemDeviceProbeSnapshot): number => {
  if (!snapshot.runtimeUsable || snapshot.devices.length === 0) return Number.MAX_SAFE_INTEGER
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
      runtimeUsable: false,
      probeError: '',
      devices: [],
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
  const mayNeedDirectmlCompatibilityFix =
    process.platform === 'win32' &&
    (snapshot.windowsHasAmdAdapter || snapshot.windowsHasIntelAdapter) &&
    !snapshot.windowsHasNvidiaAdapter &&
    !snapshot.cudaAvailable &&
    !snapshot.xpuAvailable &&
    snapshot.anyDirectmlBackendInstalled &&
    !snapshot.directmlAvailable &&
    !snapshot.directmlDemucsCompatible
  if (mayNeedDirectmlCompatibilityFix) {
    const adapterNames = snapshot.windowsAdapterNames.join(',')
    return {
      reasonCode: 'gpu_failed',
      reasonDetail: `directml-demucs-incompatible | adapters=${adapterNames || 'unknown'}`
    }
  }
  return {
    reasonCode: 'gpu_unavailable',
    reasonDetail: `detected-devices=${snapshot.devices.join(',')} | runtime=${snapshot.runtimeKey || 'unknown'}`
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
export {
  getCachedStemDeviceProbeSnapshot,
  invalidateStemDeviceProbeCache,
  probeTorchDeviceCompatibility,
  probeDirectmlDemucsCompatibility,
  probeXpuDemucsCompatibility,
  probeDemucsDevicesForRuntime,
  resolveProbeSnapshotDeviceScore,
  resolveProbeSnapshotTieBreakScore,
  probeDemucsDevices,
  resolveCpuFallbackReason,
  resolveDemucsDeviceArg,
  parseClockTokenToSeconds,
  parseDemucsProgressText
}
