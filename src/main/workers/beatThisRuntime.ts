import fs from 'node:fs'
import path from 'node:path'
import childProcess from 'node:child_process'

export type BeatThisPythonCommand = {
  command: string
  args: string[]
  source: 'env-python' | 'local-runtime' | 'demucs-runtime' | 'dev-launcher'
  runtimeKey?: string
  runtimeDir?: string
  extraSiteDirs: string[]
  extraDllDirs: string[]
}

export type BeatThisComputeDevice = 'directml' | 'cuda' | 'xpu' | 'mps' | 'cpu'

type BeatThisRuntimeProbeSnapshot = {
  candidate: BeatThisPythonCommand
  runtimeUsable: boolean
  importOk: boolean
  devices: BeatThisComputeDevice[]
  deviceArgs: Partial<Record<BeatThisComputeDevice, string>>
  probeError: string
}

export type BeatThisResolvedRuntime = {
  candidate: BeatThisPythonCommand
  selectedDevice: BeatThisComputeDevice | 'manual'
  selectedDeviceArg: string
}

const ENV_BEAT_THIS_PYTHON = 'FRKB_BEAT_THIS_PYTHON'
const ENV_BEAT_THIS_DEVICE = 'FRKB_BEAT_THIS_DEVICE'
const ENV_BEAT_THIS_CHECKPOINT = 'FRKB_BEAT_THIS_CHECKPOINT'
const ENV_BEAT_THIS_EXTRA_SITE_DIRS = 'FRKB_BEAT_THIS_EXTRA_SITE_DIRS'
const ENV_BEAT_THIS_EXTRA_DLL_DIRS = 'FRKB_BEAT_THIS_EXTRA_DLL_DIRS'
const ENV_DEMUCS_ROOT = 'FRKB_DEMUCS_ROOT'
const ENV_IGNORE_BUNDLED_DEMUCS_RUNTIME = 'FRKB_IGNORE_BUNDLED_DEMUCS_RUNTIME'
const ENV_USER_DATA_DIR = 'FRKB_USER_DATA_DIR'
const LOCAL_RUNTIME_DIR = 'grid-analysis-lab/beat-this-runtime'
const DEFAULT_BEAT_THIS_CHECKPOINT_RELATIVE_PATH = 'beat-this-checkpoints/final0.ckpt'
const BEAT_THIS_PROBE_TIMEOUT_MS = 30_000
const BEAT_THIS_COMPATIBILITY_TIMEOUT_MS = 90_000

let cachedProjectRoot = ''
let cachedResolvedRuntime: BeatThisResolvedRuntime | null | undefined
const beatThisRuntimeProbeCache = new Map<string, BeatThisRuntimeProbeSnapshot>()
const beatThisCompatibilityProbeCache = new Map<string, { ok: boolean; error: string }>()

export const normalizeBeatThisFsPath = (value: string) => {
  const normalized = String(value || '').trim()
  return normalized ? path.normalize(normalized) : ''
}

export const resolveBeatThisProjectRoot = () => {
  if (cachedProjectRoot) return cachedProjectRoot

  const candidates = [
    process.cwd(),
    path.resolve(__dirname, '../..'),
    path.resolve(__dirname, '../../..'),
    path.resolve(__dirname, '../../../..')
  ]

  for (const candidate of candidates) {
    let current = path.resolve(candidate)
    for (let depth = 0; depth < 8; depth += 1) {
      const packageJsonPath = path.join(current, 'package.json')
      if (fs.existsSync(packageJsonPath)) {
        cachedProjectRoot = current
        return current
      }
      const parent = path.dirname(current)
      if (!parent || parent === current) break
      current = parent
    }
  }

  cachedProjectRoot = path.resolve(process.cwd())
  return cachedProjectRoot
}

const appendUniquePaths = (target: string[], values: Array<string | undefined>) => {
  for (const value of values) {
    const normalized = normalizeBeatThisFsPath(value || '')
    if (!normalized) continue
    if (target.includes(normalized)) continue
    target.push(normalized)
  }
}

const resolveDemucsPlatformDir = () => {
  if (process.platform === 'win32') return 'win32-x64'
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
}

const resolveConfiguredDemucsRoot = () => {
  const configuredRoot = normalizeBeatThisFsPath(process.env[ENV_DEMUCS_ROOT] || '')
  if (!configuredRoot) return ''
  if (path.isAbsolute(configuredRoot)) {
    return configuredRoot
  }
  return normalizeBeatThisFsPath(path.resolve(process.cwd(), configuredRoot))
}

const shouldIgnoreBundledDemucsRuntime = () => {
  const raw = String(process.env[ENV_IGNORE_BUNDLED_DEMUCS_RUNTIME] || '')
    .trim()
    .toLowerCase()
  return raw === '1' || raw === 'true'
}

const resolveInstalledDemucsPlatformRoot = () => {
  const userDataDir = normalizeBeatThisFsPath(process.env[ENV_USER_DATA_DIR] || '')
  if (!userDataDir) return ''
  return path.join(userDataDir, 'demucs-runtimes', resolveDemucsPlatformDir())
}

const resolveBundledDemucsRootCandidates = () => {
  const candidates: string[] = []
  const seen = new Set<string>()
  const addCandidate = (candidatePath: string) => {
    const normalizedPath = normalizeBeatThisFsPath(candidatePath)
    if (!normalizedPath || seen.has(normalizedPath)) return
    seen.add(normalizedPath)
    candidates.push(normalizedPath)
  }

  const resourcesPath = normalizeBeatThisFsPath(process.resourcesPath || '')
  if (resourcesPath) {
    addCandidate(path.join(resourcesPath, 'demucs'))
  }
  addCandidate(path.join(resolveBeatThisProjectRoot(), 'vendor', 'demucs'))
  return candidates
}

const resolveDemucsPlatformRoots = () => {
  const configuredRoot = resolveConfiguredDemucsRoot()
  if (configuredRoot) {
    return [path.join(configuredRoot, resolveDemucsPlatformDir())]
  }

  const candidates: string[] = []
  const seen = new Set<string>()
  const addCandidate = (candidatePath: string) => {
    const normalizedPath = normalizeBeatThisFsPath(candidatePath)
    if (!normalizedPath || seen.has(normalizedPath)) return
    seen.add(normalizedPath)
    candidates.push(normalizedPath)
  }

  addCandidate(resolveInstalledDemucsPlatformRoot())
  if (shouldIgnoreBundledDemucsRuntime()) {
    return candidates
  }
  for (const bundledRoot of resolveBundledDemucsRootCandidates()) {
    addCandidate(path.join(bundledRoot, resolveDemucsPlatformDir()))
  }
  return candidates
}

const resolveRuntimeDirNameCandidates = () => {
  if (process.platform === 'win32') {
    return ['runtime-directml', 'runtime-cuda', 'runtime-xpu', 'runtime-cpu', 'runtime']
  }
  if (process.platform === 'darwin') {
    return ['runtime-mps', 'runtime-cpu', 'runtime']
  }
  return ['runtime-cuda', 'runtime-rocm', 'runtime-cpu', 'runtime']
}

const resolveRuntimePythonCandidatesFromDir = (runtimeDir: string) => {
  const normalizedRuntimeDir = normalizeBeatThisFsPath(runtimeDir)
  if (!normalizedRuntimeDir) return []
  if (process.platform === 'win32') {
    return [
      path.join(normalizedRuntimeDir, 'Scripts', 'python.exe'),
      path.join(normalizedRuntimeDir, 'python.exe')
    ]
  }
  return [
    path.join(normalizedRuntimeDir, 'bin', 'python3'),
    path.join(normalizedRuntimeDir, 'bin', 'python')
  ]
}

const resolveRuntimeDirFromPythonPath = (pythonPath: string) => {
  const normalizedPythonPath = normalizeBeatThisFsPath(pythonPath)
  if (!normalizedPythonPath) return ''
  const parentDir = path.dirname(normalizedPythonPath)
  if (path.basename(parentDir).toLowerCase() === 'scripts') {
    return normalizeBeatThisFsPath(path.dirname(parentDir))
  }
  return normalizeBeatThisFsPath(parentDir)
}

const resolveRuntimeSitePackagesDir = (runtimeDir: string) => {
  const normalizedRuntimeDir = normalizeBeatThisFsPath(runtimeDir)
  if (!normalizedRuntimeDir) return ''
  if (process.platform === 'win32') {
    return path.join(normalizedRuntimeDir, 'Lib', 'site-packages')
  }
  return ''
}

const resolveRuntimeLibraryBinDir = (runtimeDir: string) => {
  const normalizedRuntimeDir = normalizeBeatThisFsPath(runtimeDir)
  if (!normalizedRuntimeDir) return ''
  if (process.platform === 'win32') {
    return path.join(normalizedRuntimeDir, 'Library', 'bin')
  }
  return ''
}

const normalizeBeatThisRelativePath = (value: unknown) =>
  String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')

const resolveRuntimeMetaFile = (runtimeDir: string) => {
  const normalizedRuntimeDir = normalizeBeatThisFsPath(runtimeDir)
  if (!normalizedRuntimeDir) return null
  const runtimeMetaPath = path.join(normalizedRuntimeDir, '.frkb-runtime-meta.json')
  if (!fs.existsSync(runtimeMetaPath)) return null
  try {
    const raw = fs.readFileSync(runtimeMetaPath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

const resolveRuntimeBeatThisCheckpointPath = (runtimeDir: string) => {
  const normalizedRuntimeDir = normalizeBeatThisFsPath(runtimeDir)
  if (!normalizedRuntimeDir) return ''
  const envCheckpoint = normalizeBeatThisFsPath(process.env[ENV_BEAT_THIS_CHECKPOINT] || '')
  if (envCheckpoint && fs.existsSync(envCheckpoint)) {
    return envCheckpoint
  }
  const runtimeMeta = resolveRuntimeMetaFile(normalizedRuntimeDir)
  const relativeCandidates = [
    normalizeBeatThisRelativePath(runtimeMeta?.beatThisCheckpointRelativePath),
    DEFAULT_BEAT_THIS_CHECKPOINT_RELATIVE_PATH
  ]
  for (const relativePath of relativeCandidates) {
    if (!relativePath) continue
    const absolutePath = path.join(normalizedRuntimeDir, ...relativePath.split('/'))
    if (fs.existsSync(absolutePath)) {
      return normalizeBeatThisFsPath(absolutePath)
    }
  }
  return ''
}

const runtimeHasBeatThisPackage = (runtimeDir: string) => {
  const sitePackagesDir = resolveRuntimeSitePackagesDir(runtimeDir)
  if (!sitePackagesDir) return false
  return fs.existsSync(path.join(sitePackagesDir, 'beat_this'))
}

const resolveBeatThisSupportRuntimeDir = () => {
  const candidates: string[] = [path.join(resolveBeatThisProjectRoot(), LOCAL_RUNTIME_DIR)]
  for (const platformRoot of resolveDemucsPlatformRoots()) {
    for (const runtimeKey of resolveRuntimeDirNameCandidates()) {
      candidates.push(path.join(platformRoot, runtimeKey))
    }
  }
  for (const candidate of candidates) {
    if (!runtimeHasBeatThisPackage(candidate)) continue
    return normalizeBeatThisFsPath(candidate)
  }
  return ''
}

const withBeatThisSupportPaths = (
  candidate: Omit<BeatThisPythonCommand, 'extraSiteDirs' | 'extraDllDirs'>
): BeatThisPythonCommand => {
  const extraSiteDirs: string[] = []
  const extraDllDirs: string[] = []
  appendUniquePaths(extraDllDirs, [resolveRuntimeLibraryBinDir(candidate.runtimeDir || '')])

  const supportRuntimeDir = resolveBeatThisSupportRuntimeDir()
  if (supportRuntimeDir) {
    const currentRuntimeDir = normalizeBeatThisFsPath(candidate.runtimeDir || '')
    if (!currentRuntimeDir || currentRuntimeDir !== supportRuntimeDir) {
      appendUniquePaths(extraSiteDirs, [resolveRuntimeSitePackagesDir(supportRuntimeDir)])
      appendUniquePaths(extraDllDirs, [resolveRuntimeLibraryBinDir(supportRuntimeDir)])
    }
  }

  return {
    ...candidate,
    extraSiteDirs,
    extraDllDirs
  }
}

const resolveBundledRuntimeCandidates = () => {
  const candidates: BeatThisPythonCommand[] = []
  const seen = new Set<string>()
  for (const platformRoot of resolveDemucsPlatformRoots()) {
    for (const runtimeKey of resolveRuntimeDirNameCandidates()) {
      const runtimeDir = path.join(platformRoot, runtimeKey)
      const normalizedRuntimeDir = normalizeBeatThisFsPath(runtimeDir)
      if (!normalizedRuntimeDir || seen.has(normalizedRuntimeDir)) continue
      seen.add(normalizedRuntimeDir)
      for (const pythonPath of resolveRuntimePythonCandidatesFromDir(runtimeDir)) {
        if (!pythonPath || !fs.existsSync(pythonPath)) continue
        candidates.push(
          withBeatThisSupportPaths({
            command: pythonPath,
            args: [],
            source: 'demucs-runtime',
            runtimeKey,
            runtimeDir
          })
        )
        break
      }
    }
  }
  return candidates
}

const resolvePythonCommandCandidates = (): BeatThisPythonCommand[] => {
  const candidates: BeatThisPythonCommand[] = []
  const seen = new Set<string>()
  const pushCandidate = (candidate: BeatThisPythonCommand) => {
    const cacheKey = [candidate.command, ...candidate.args].join('\u0001')
    if (!cacheKey || seen.has(cacheKey)) return
    seen.add(cacheKey)
    candidates.push(candidate)
  }

  const envPython = normalizeBeatThisFsPath(process.env[ENV_BEAT_THIS_PYTHON] || '')
  if (envPython && fs.existsSync(envPython)) {
    pushCandidate(
      withBeatThisSupportPaths({
        command: envPython,
        args: [],
        source: 'env-python',
        runtimeKey: path.basename(resolveRuntimeDirFromPythonPath(envPython)),
        runtimeDir: resolveRuntimeDirFromPythonPath(envPython)
      })
    )
  }

  const localRuntimeDir = path.join(resolveBeatThisProjectRoot(), LOCAL_RUNTIME_DIR)
  for (const pythonPath of resolveRuntimePythonCandidatesFromDir(localRuntimeDir)) {
    if (!pythonPath || !fs.existsSync(pythonPath)) continue
    pushCandidate(
      withBeatThisSupportPaths({
        command: pythonPath,
        args: [],
        source: 'local-runtime',
        runtimeKey: 'beat-this-runtime',
        runtimeDir: localRuntimeDir
      })
    )
    break
  }

  for (const candidate of resolveBundledRuntimeCandidates()) {
    pushCandidate(candidate)
  }

  const devCandidates: BeatThisPythonCommand[] =
    process.platform === 'win32'
      ? [
          {
            command: 'py',
            args: ['-3.11'],
            source: 'dev-launcher',
            extraSiteDirs: [],
            extraDllDirs: []
          },
          {
            command: 'py',
            args: ['-3'],
            source: 'dev-launcher',
            extraSiteDirs: [],
            extraDllDirs: []
          }
        ]
      : [
          {
            command: 'python3',
            args: [],
            source: 'dev-launcher',
            extraSiteDirs: [],
            extraDllDirs: []
          }
        ]

  for (const candidate of devCandidates) {
    pushCandidate(candidate)
  }

  return candidates
}

const joinEnvPathList = (values: string[]) =>
  values
    .map((value) => normalizeBeatThisFsPath(value))
    .filter(Boolean)
    .join(path.delimiter)

export const buildBeatThisChildEnv = (candidate: BeatThisPythonCommand): NodeJS.ProcessEnv => {
  const checkpointPath = resolveRuntimeBeatThisCheckpointPath(candidate.runtimeDir || '')
  return {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    [ENV_BEAT_THIS_EXTRA_SITE_DIRS]: joinEnvPathList(candidate.extraSiteDirs || []),
    [ENV_BEAT_THIS_EXTRA_DLL_DIRS]: joinEnvPathList(candidate.extraDllDirs || []),
    ...(checkpointPath ? { [ENV_BEAT_THIS_CHECKPOINT]: checkpointPath } : {})
  }
}

const buildBeatThisBootstrapCode = () =>
  [
    'import os',
    'import sys',
    '_frkb_dll_handles = []',
    'def _frkb_split_paths(raw_value):',
    '    raw_value = str(raw_value or "").strip()',
    '    if not raw_value:',
    '        return []',
    '    return [part for part in raw_value.split(os.pathsep) if part]',
    `for _dll_dir in _frkb_split_paths(os.environ.get(${JSON.stringify(ENV_BEAT_THIS_EXTRA_DLL_DIRS)}, "")):`,
    '    try:',
    '        if os.path.isdir(_dll_dir) and hasattr(os, "add_dll_directory"):',
    '            _frkb_dll_handles.append(os.add_dll_directory(_dll_dir))',
    '    except Exception:',
    '        pass',
    `for _site_dir in _frkb_split_paths(os.environ.get(${JSON.stringify(ENV_BEAT_THIS_EXTRA_SITE_DIRS)}, "")):`,
    '    if os.path.isdir(_site_dir) and _site_dir not in sys.path:',
    '        sys.path.append(_site_dir)'
  ].join('\n')

const runBeatThisJsonProbe = (
  candidate: BeatThisPythonCommand,
  code: string,
  timeoutMs: number
):
  | {
      ok: true
      parsed: Record<string, unknown>
    }
  | {
      ok: false
      error: string
    } => {
  const result = childProcess.spawnSync(candidate.command, [...candidate.args, '-c', code], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: buildBeatThisChildEnv(candidate)
  })

  if (result.error) {
    return {
      ok: false,
      error: result.error.message
    }
  }
  if (result.status !== 0) {
    return {
      ok: false,
      error:
        String(result.stderr || '').trim() ||
        String(result.stdout || '').trim() ||
        `probe exit ${String(result.status ?? '')}`
    }
  }

  const stdoutLines = String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const lastLine = stdoutLines.at(-1) || ''
  if (!lastLine) {
    return {
      ok: false,
      error: 'probe stdout empty'
    }
  }

  try {
    return {
      ok: true,
      parsed: JSON.parse(lastLine) as Record<string, unknown>
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error || 'invalid json')
    }
  }
}

const resolveBeatThisPreferredDevices = (): BeatThisComputeDevice[] => {
  if (process.platform === 'win32') {
    return ['directml', 'cuda', 'xpu', 'cpu']
  }
  if (process.platform === 'darwin') {
    return ['mps', 'cuda', 'cpu']
  }
  return ['cuda', 'xpu', 'mps', 'cpu']
}

const probeBeatThisRuntimeCandidate = (
  candidate: BeatThisPythonCommand
): BeatThisRuntimeProbeSnapshot => {
  const cacheKey = JSON.stringify({
    command: candidate.command,
    args: candidate.args,
    extraSiteDirs: candidate.extraSiteDirs,
    extraDllDirs: candidate.extraDllDirs
  })
  const cached = beatThisRuntimeProbeCache.get(cacheKey)
  if (cached) return cached

  const probeCode = [
    buildBeatThisBootstrapCode(),
    'import json',
    'payload = {',
    '  "beat_this": False,',
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
    '  import beat_this',
    '  import torch',
    '  payload["beat_this"] = True',
    '  torch_version = str(getattr(torch, "__version__", ""))',
    '  payload["torch_version"] = torch_version',
    '  cuda_api = getattr(torch, "cuda", None)',
    '  payload["cuda"] = bool(cuda_api and cuda_api.is_available())',
    '  mps_backend = getattr(getattr(torch, "backends", None), "mps", None)',
    '  payload["mps"] = bool(mps_backend and mps_backend.is_available())',
    '  xpu_api = getattr(torch, "xpu", None)',
    '  payload["xpu_backend_installed"] = bool(xpu_api)',
    '  payload["xpu"] = bool(xpu_api and xpu_api.is_available())',
    'except Exception as exc:',
    '  payload["error"] = str(exc)',
    'try:',
    '  import torch_directml',
    '  payload["directml_backend_installed"] = True',
    '  directml_device = torch_directml.device()',
    '  payload["directml"] = bool(directml_device)',
    '  payload["directml_device"] = str(directml_device) if directml_device else ""',
    'except Exception as exc:',
    '  payload["directml_import_error"] = str(exc)',
    'print(json.dumps(payload))'
  ].join('\n')

  const probeResult = runBeatThisJsonProbe(candidate, probeCode, BEAT_THIS_PROBE_TIMEOUT_MS)
  if (!probeResult.ok) {
    const snapshot: BeatThisRuntimeProbeSnapshot = {
      candidate,
      runtimeUsable: false,
      importOk: false,
      devices: [],
      deviceArgs: {},
      probeError: probeResult.error
    }
    beatThisRuntimeProbeCache.set(cacheKey, snapshot)
    return snapshot
  }

  const parsed = probeResult.parsed
  const importOk = Boolean(parsed.beat_this)
  const directmlDevice = String(parsed.directml_device || '').trim()
  const availableDevices = resolveBeatThisPreferredDevices().filter((device) => {
    if (device === 'cpu') return importOk
    if (device === 'directml') return Boolean(parsed.directml)
    if (device === 'cuda') return Boolean(parsed.cuda)
    if (device === 'xpu') return Boolean(parsed.xpu)
    if (device === 'mps') return Boolean(parsed.mps)
    return false
  })

  const snapshot: BeatThisRuntimeProbeSnapshot = {
    candidate,
    runtimeUsable: importOk,
    importOk,
    devices: availableDevices,
    deviceArgs: {
      directml: directmlDevice || 'privateuseone:0',
      cuda: 'cuda',
      xpu: 'xpu',
      mps: 'mps',
      cpu: 'cpu'
    },
    probeError:
      String(parsed.error || '').trim() || String(parsed.directml_import_error || '').trim() || ''
  }
  beatThisRuntimeProbeCache.set(cacheKey, snapshot)
  return snapshot
}

const probeBeatThisDeviceCompatibility = (candidate: BeatThisPythonCommand, deviceArg: string) => {
  const cacheKey = JSON.stringify({
    command: candidate.command,
    args: candidate.args,
    extraSiteDirs: candidate.extraSiteDirs,
    extraDllDirs: candidate.extraDllDirs,
    deviceArg
  })
  const cached = beatThisCompatibilityProbeCache.get(cacheKey)
  if (cached) return cached

  const compatibilityCode = [
    buildBeatThisBootstrapCode(),
    'import json',
    'import numpy as np',
    'import torch',
    'from beat_this.inference import Audio2Beats, split_predict_aggregate',
    'from beat_this.preprocessing import LogMelSpect',
    `device = ${JSON.stringify(deviceArg)}`,
    'predictor = Audio2Beats(checkpoint_path=None, device=device, dbn=False)',
    "signal = np.zeros(22050, dtype='float32')",
    "if str(device).strip().lower() == 'cpu':",
    '    beats, downbeats = predictor(signal, 22050)',
    'else:',
    "    cpu_spect = LogMelSpect(device='cpu')",
    "    signal_tensor = torch.tensor(signal, dtype=torch.float32, device='cpu')",
    '    spect = cpu_spect(signal_tensor).detach().to(device)',
    '    with torch.no_grad():',
    '        model_prediction = split_predict_aggregate(',
    '            spect=spect,',
    '            chunk_size=1500,',
    '            border_size=6,',
    '            overlap_mode="keep_first",',
    '            model=predictor.model,',
    '        )',
    '        beat_logits = model_prediction["beat"].float()',
    '        downbeat_logits = model_prediction["downbeat"].float()',
    '    beats, downbeats = predictor.frames2beats(beat_logits, downbeat_logits)',
    'print(json.dumps({"ok": True, "beatCount": len(beats), "downbeatCount": len(downbeats)}))'
  ].join('\n')

  const probeResult = runBeatThisJsonProbe(
    candidate,
    compatibilityCode,
    BEAT_THIS_COMPATIBILITY_TIMEOUT_MS
  )
  const resolved = probeResult.ok
    ? { ok: true, error: '' }
    : { ok: false, error: probeResult.error }
  beatThisCompatibilityProbeCache.set(cacheKey, resolved)
  return resolved
}

const parseRequestedBeatThisDevice = (value: string) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  if (!normalized || normalized === 'auto') return null
  if (normalized === 'cpu') return { selectedDevice: 'cpu' as const, deviceArg: 'cpu' }
  if (normalized === 'directml') return { selectedDevice: 'directml' as const, deviceArg: '' }
  if (normalized.startsWith('privateuseone')) {
    return { selectedDevice: 'directml' as const, deviceArg: normalized }
  }
  if (normalized === 'cuda' || normalized.startsWith('cuda:')) {
    return { selectedDevice: 'cuda' as const, deviceArg: normalized }
  }
  if (normalized === 'xpu' || normalized.startsWith('xpu:')) {
    return { selectedDevice: 'xpu' as const, deviceArg: normalized }
  }
  if (normalized === 'mps') return { selectedDevice: 'mps' as const, deviceArg: normalized }
  return { selectedDevice: 'manual' as const, deviceArg: normalized }
}

export const resolveBeatThisRuntime = (): BeatThisResolvedRuntime | null => {
  if (cachedResolvedRuntime !== undefined) return cachedResolvedRuntime

  const candidates = resolvePythonCommandCandidates()
  if (candidates.length === 0) {
    return null
  }

  const requestedDevice = parseRequestedBeatThisDevice(process.env[ENV_BEAT_THIS_DEVICE] || '')
  const runtimeProbes = candidates.map((candidate) => probeBeatThisRuntimeCandidate(candidate))

  const tryResolveDevice = (
    selectedDevice: BeatThisComputeDevice,
    deviceArgOverride = ''
  ): BeatThisResolvedRuntime | null => {
    for (const probe of runtimeProbes) {
      if (!probe.runtimeUsable) continue
      if (selectedDevice !== 'cpu' && !probe.devices.includes(selectedDevice)) continue
      const deviceArg = deviceArgOverride || probe.deviceArgs[selectedDevice] || selectedDevice
      if (selectedDevice !== 'cpu') {
        const compatibility = probeBeatThisDeviceCompatibility(probe.candidate, deviceArg)
        if (!compatibility.ok) continue
      }
      return {
        candidate: probe.candidate,
        selectedDevice,
        selectedDeviceArg: deviceArg
      }
    }
    return null
  }

  if (requestedDevice) {
    if (requestedDevice.selectedDevice === 'manual') {
      const importableProbe = runtimeProbes.find((probe) => probe.runtimeUsable)
      if (!importableProbe) {
        throw new Error(`Beat This! runtime not available for device ${requestedDevice.deviceArg}`)
      }
      cachedResolvedRuntime = {
        candidate: importableProbe.candidate,
        selectedDevice: 'manual',
        selectedDeviceArg: requestedDevice.deviceArg
      }
      return cachedResolvedRuntime
    }

    const forcedRuntime = tryResolveDevice(
      requestedDevice.selectedDevice,
      requestedDevice.deviceArg
    )
    if (!forcedRuntime) {
      throw new Error(
        `Beat This! device unavailable or incompatible: ${requestedDevice.deviceArg || requestedDevice.selectedDevice}`
      )
    }
    cachedResolvedRuntime = forcedRuntime
    return forcedRuntime
  }

  for (const preferredDevice of resolveBeatThisPreferredDevices()) {
    const resolved = tryResolveDevice(preferredDevice)
    if (resolved) {
      cachedResolvedRuntime = resolved
      return resolved
    }
  }

  const importableProbe = runtimeProbes.find((probe) => probe.importOk)
  if (importableProbe) {
    cachedResolvedRuntime = {
      candidate: importableProbe.candidate,
      selectedDevice: 'cpu',
      selectedDeviceArg: 'cpu'
    }
    return cachedResolvedRuntime
  }

  return null
}

export const isBeatThisRuntimeAvailableLocally = (): boolean => {
  try {
    return resolveBeatThisRuntime() !== null
  } catch {
    return false
  }
}

export const getBeatThisRuntimeAvailabilitySnapshot = (): boolean | null => {
  if (cachedResolvedRuntime === undefined) return null
  return cachedResolvedRuntime !== null
}

export const resetBeatThisRuntimeResolution = () => {
  cachedResolvedRuntime = undefined
  beatThisRuntimeProbeCache.clear()
  beatThisCompatibilityProbeCache.clear()
}
