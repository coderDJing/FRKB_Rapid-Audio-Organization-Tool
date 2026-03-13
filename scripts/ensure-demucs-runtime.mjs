import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'

const runtimeProfilesPath = path.resolve('./scripts/demucs-runtime-profiles.json')
const runtimeProfilesRaw = fs.readFileSync(runtimeProfilesPath, 'utf8')
const runtimeProfiles = JSON.parse(runtimeProfilesRaw)
const modelManifestPath = path.resolve('./scripts/demucs-model-manifest.json')
const DEFAULT_DEMUCS_RUNTIME_MANIFEST_URL =
  'https://github.com/coderDjing/FRKB_Rapid-Audio-Organization-Tool/releases/download/demucs-runtime-assets/demucs-runtime-manifest.json'

const platformDefault = (() => {
  if (process.platform === 'win32') return 'win32-x64'
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
})()

const args = process.argv.slice(2)

const getArgValue = (flag, fallback = '') => {
  const directPrefix = `${flag}=`
  const direct = args.find((arg) => arg.startsWith(directPrefix))
  if (direct) return direct.slice(directPrefix.length).trim()
  const index = args.findIndex((arg) => arg === flag)
  if (index >= 0) {
    const next = args[index + 1]
    return typeof next === 'string' ? next.trim() : ''
  }
  return fallback
}

const hasFlag = (flag) => args.includes(flag)

const parseCsv = (value) =>
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

const toShortText = (value, maxLen = 400) => {
  const text = String(value || '').trim()
  if (!text) return ''
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen)
}

const runtimeRootArg = getArgValue('--runtime-root', 'vendor/demucs')
const platformArg = getArgValue('--platform', platformDefault)
const profileArg = getArgValue('--profiles', '')
const modelsArg = getArgValue('--models', '')
const modelRetriesArg = Number(getArgValue('--model-retries', '3'))
const modelTimeoutSecArg = Number(getArgValue('--model-timeout-sec', '600'))
const install = !hasFlag('--no-install')
const strict = hasFlag('--strict') || hasFlag('--ci')
const force = hasFlag('--force')
const preferRemoteAssets =
  !strict ||
  hasFlag('--prefer-remote-assets') ||
  process.env.FRKB_DEMUCS_RUNTIME_PREFER_REMOTE === '1' ||
  process.env.FRKB_DEMUCS_RUNTIME_PREFER_REMOTE === 'true'
const skip =
  process.env.FRKB_SKIP_DEMUCS_RUNTIME_ENSURE === '1' ||
  process.env.FRKB_SKIP_DEMUCS_RUNTIME_ENSURE === 'true'

const runtimeRoot = path.resolve(runtimeRootArg)
const runtimeAssetManifestUrl =
  getArgValue('--runtime-manifest-url', '').trim() ||
  String(process.env.FRKB_DEMUCS_RUNTIME_MANIFEST_URL || '').trim() ||
  DEFAULT_DEMUCS_RUNTIME_MANIFEST_URL

const resolveRuntimePythonPath = (runtimeDir) => {
  if (process.platform === 'win32') {
    const rootPython = path.join(runtimeDir, 'python.exe')
    if (fs.existsSync(rootPython)) return rootPython
    const scriptsPython = path.join(runtimeDir, 'Scripts', 'python.exe')
    if (fs.existsSync(scriptsPython)) return scriptsPython
    return rootPython
  }
  const binPython3 = path.join(runtimeDir, 'bin', 'python3')
  if (fs.existsSync(binPython3)) return binPython3
  const binPython = path.join(runtimeDir, 'bin', 'python')
  if (fs.existsSync(binPython)) return binPython
  return binPython3
}

const buildRuntimeEnv = (runtimeDir) => {
  const env = {
    ...process.env
  }
  const pathEntries =
    process.platform === 'win32'
      ? [path.join(runtimeDir, 'Scripts'), path.join(runtimeDir, 'Library', 'bin')]
      : [path.join(runtimeDir, 'bin')]
  env.PATH = [...pathEntries, process.env.PATH || ''].filter(Boolean).join(path.delimiter)
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

const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    windowsHide: true,
    ...options
  })
  if (result.status === 0) return
  throw new Error(`${command} ${commandArgs.join(' ')} -> exit ${result.status ?? -1}`)
}

const runQuiet = (command, commandArgs, options = {}) =>
  spawnSync(command, commandArgs, {
    encoding: 'utf8',
    windowsHide: true,
    ...options
  })

const probeCommand = (command, commandArgs) => {
  try {
    const result = runQuiet(command, commandArgs)
    return result.status === 0
  } catch {
    return false
  }
}

const addUniqueItem = (target, value) => {
  const normalized = String(value || '').trim()
  if (!normalized) return
  if (target.includes(normalized)) return
  target.push(normalized)
}

const probeRuntimeModules = (pythonPath, runtimeDir) => {
  const env = buildRuntimeEnv(runtimeDir)
  const result = runQuiet(
    pythonPath,
    [
      '-c',
      [
        'import json',
        'payload = {"demucs": False, "torch": False, "torchaudio": False, "onnxruntime": False, "torch_directml": False, "onnxruntime_directml_provider": False, "torch_version": "", "xpu_backend": False, "xpu_available": False}',
        'try:',
        '  import demucs',
        '  payload["demucs"] = True',
        'except Exception as exc:',
        '  payload["demucs_error"] = str(exc)',
        'try:',
        '  import torch',
        '  payload["torch"] = True',
        '  payload["torch_version"] = str(getattr(torch, "__version__", ""))',
        '  xpu_api = getattr(torch, "xpu", None)',
        '  payload["xpu_backend"] = bool(xpu_api) and ("+cpu" not in payload["torch_version"].lower())',
        '  try:',
        '    payload["xpu_available"] = bool(payload["xpu_backend"] and xpu_api and xpu_api.is_available())',
        '  except Exception as exc:',
        '    payload["xpu_available_error"] = str(exc)',
        'except Exception as exc:',
        '  payload["torch_error"] = str(exc)',
        'try:',
        '  import torchaudio',
        '  payload["torchaudio"] = True',
        'except Exception as exc:',
        '  payload["torchaudio_error"] = str(exc)',
        'try:',
        '  import onnxruntime as ort',
        '  payload["onnxruntime"] = True',
        '  providers = list(ort.get_available_providers())',
        '  payload["onnxruntime_directml_provider"] = "DmlExecutionProvider" in providers',
        'except Exception as exc:',
        '  payload["onnxruntime_error"] = str(exc)',
        'try:',
        '  import torch_directml',
        '  payload["torch_directml"] = True',
        'except Exception as exc:',
        '  payload["torch_directml_error"] = str(exc)',
        'print(json.dumps(payload))'
      ].join('\n')
    ],
    {
      timeout: 20_000,
      env
    }
  )
  if (result.status !== 0) {
    return {
      ok: false,
      payload: null,
      error: toShortText(result.stderr || result.stdout || `probe exit ${result.status ?? -1}`)
    }
  }
  const stdout = String(result.stdout || '')
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const lastLine = lines.at(-1) || ''
  if (!lastLine) {
    return {
      ok: false,
      payload: null,
      error: 'probe output empty'
    }
  }
  try {
    const payload = JSON.parse(lastLine)
    return {
      ok: true,
      payload,
      error: ''
    }
  } catch (error) {
    return {
      ok: false,
      payload: null,
      error: toShortText(error instanceof Error ? error.message : String(error || ''))
    }
  }
}

const readRuntimeAssetManifest = async () => {
  if (!preferRemoteAssets) return null
  try {
    const response = await fetch(runtimeAssetManifestUrl, {
      headers: {
        Accept: 'application/json'
      }
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const manifest = await response.json()
    if (!manifest || !Array.isArray(manifest.assets)) {
      throw new Error('manifest assets missing')
    }
    return manifest
  } catch (error) {
    console.warn(
      `[demucs-runtime-ensure] Runtime asset manifest unavailable: ${
        toShortText(error instanceof Error ? error.message : String(error || 'unknown'))
      }`
    )
    return null
  }
}

const resolveRuntimeAssetEntry = (manifest, profileName) => {
  if (!manifest || !Array.isArray(manifest.assets)) return null
  return (
    manifest.assets.find(
      (item) =>
        String(item?.platform || '').trim() === platformArg &&
        String(item?.profile || '').trim() === profileName
    ) || null
  )
}

const downloadRuntimeAssetArchive = async (entry, archivePath) => {
  const response = await fetch(String(entry.archiveUrl || ''))
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status}`)
  }
  fs.mkdirSync(path.dirname(archivePath), { recursive: true })
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(archivePath))
}

const extractRuntimeAssetArchive = (archivePath, targetDir) => {
  fs.mkdirSync(targetDir, { recursive: true })
  run('tar.exe', ['-xf', archivePath, '-C', targetDir])
}

const installRuntimeProfileFromAsset = async (entry, profileName, runtimeDir) => {
  const archiveName = String(entry?.archiveName || '').trim()
  const archiveSha256 = normalizeSha256(entry?.archiveSha256)
  const archiveSize = Number(entry?.archiveSize) || 0
  const runtimeKey = String(entry?.runtimeKey || '').trim()
  const pythonRelativePath = normalizeRelativePath(entry?.pythonRelativePath || '')
  if (!archiveName || !archiveSha256 || !runtimeKey || !pythonRelativePath) {
    throw new Error(`asset metadata invalid (${profileName})`)
  }

  const downloadCacheDir = path.resolve(runtimeRoot, '.downloads')
  const archivePath = path.join(downloadCacheDir, archiveName)
  const extractRoot = path.join(downloadCacheDir, `extract-${profileName}-${Date.now()}`)
  const extractedRuntimeDir = path.join(extractRoot, runtimeKey)
  const extractedPythonPath = path.join(extractedRuntimeDir, pythonRelativePath)

  console.log(
    `[demucs-runtime-ensure] Downloading runtime asset (${profileName}) from GitHub release`
  )
  await downloadRuntimeAssetArchive(entry, archivePath)
  const stat = fs.statSync(archivePath)
  if (archiveSize > 0 && stat.size !== archiveSize) {
    throw new Error(
      `runtime asset size mismatch (${profileName}): expected=${archiveSize} actual=${stat.size}`
    )
  }
  const actualSha256 = await computeFileSha256(archivePath)
  if (actualSha256 !== archiveSha256) {
    throw new Error(
      `runtime asset sha256 mismatch (${profileName}): expected=${archiveSha256} actual=${actualSha256}`
    )
  }

  fs.rmSync(extractRoot, { recursive: true, force: true })
  extractRuntimeAssetArchive(archivePath, extractRoot)
  if (!fs.existsSync(extractedPythonPath)) {
    throw new Error(`runtime asset python missing (${profileName}): ${pythonRelativePath}`)
  }

  fs.rmSync(runtimeDir, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(runtimeDir), { recursive: true })
  fs.renameSync(extractedRuntimeDir, runtimeDir)
  fs.rmSync(extractRoot, { recursive: true, force: true })
  console.log(`[demucs-runtime-ensure] Installed runtime asset (${profileName}) -> ${runtimeDir}`)
  return true
}

const tryInstallProfileFromRemoteAsset = async (manifest, profileName, runtimeDir) => {
  if (!preferRemoteAssets) return false
  const entry = resolveRuntimeAssetEntry(manifest, profileName)
  if (!entry) return false
  try {
    return await installRuntimeProfileFromAsset(entry, profileName, runtimeDir)
  } catch (error) {
    console.warn(
      `[demucs-runtime-ensure] Runtime asset install failed (${profileName}), fallback to local build: ${
        toShortText(error instanceof Error ? error.message : String(error || 'unknown'))
      }`
    )
    return false
  }
}

const resolveSystemPythonCommand = () => {
  const candidates = []
  const envPython = String(process.env.PYTHON || '').trim()
  if (envPython) {
    candidates.push({
      command: envPython,
      args: []
    })
  }
  if (process.platform === 'win32') {
    candidates.push({
      command: 'py',
      args: ['-3']
    })
  }
  candidates.push(
    {
      command: 'python3',
      args: []
    },
    {
      command: 'python',
      args: []
    }
  )

  for (const candidate of candidates) {
    const result = runQuiet(candidate.command, [...candidate.args, '--version'])
    if (result.status !== 0) continue
    return candidate
  }
  return null
}

const normalizeList = (input) =>
  Array.isArray(input) ? input.map((item) => String(item).trim()).filter(Boolean) : []

const normalizeModelName = (value) => {
  const modelName = String(value || '').trim()
  if (!modelName) return ''
  return /^[a-zA-Z0-9_-]+$/.test(modelName) ? modelName : ''
}

const normalizeFileName = (value) => {
  const fileName = String(value || '').trim()
  if (!fileName) return ''
  return /^[a-zA-Z0-9._-]+$/.test(fileName) ? fileName : ''
}

const normalizeRelativePath = (value) => {
  const relativePath = String(value || '')
    .trim()
    .replace(/\\/g, '/')
  if (!relativePath) return ''
  if (relativePath.startsWith('/')) return ''
  if (relativePath.includes('..')) return ''
  if (!/^[a-zA-Z0-9._/-]+$/.test(relativePath)) return ''
  return relativePath
}

const normalizeUrl = (value) => {
  const url = String(value || '').trim()
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) return ''
  return url
}

const normalizeSha256 = (value) => {
  const hash = String(value || '')
    .trim()
    .toLowerCase()
  return /^[0-9a-f]{64}$/.test(hash) ? hash : ''
}

const ensureModelsDir = () => {
  const modelsDir = path.resolve(runtimeRoot, 'models')
  fs.mkdirSync(modelsDir, { recursive: true })
}

const parseModelManifest = () => {
  const raw = fs.readFileSync(modelManifestPath, 'utf8')
  const parsed = JSON.parse(raw)
  const modelEntries = Array.isArray(parsed?.models) ? parsed.models : []
  return modelEntries
    .map((entry) => {
      const modelName = normalizeModelName(entry?.name)
      const yaml = typeof entry?.yaml === 'string' ? entry.yaml : ''
      const files = Array.isArray(entry?.files)
        ? entry.files
            .map((file) => ({
              name: normalizeFileName(file?.name),
              url: normalizeUrl(file?.url),
              sha256: normalizeSha256(file?.sha256)
            }))
            .filter((file) => !!file.name && !!file.url)
        : []
      return {
        name: modelName,
        yaml,
        files
      }
    })
    .filter((entry) => !!entry.name && !!entry.yaml)
}

const resolveRequestedModels = (manifestEntries) => {
  const requestedModels = parseCsv(modelsArg)
    .map((item) => normalizeModelName(item))
    .filter(Boolean)
  if (requestedModels.length === 0) {
    return {
      selectedModels: manifestEntries,
      unknownModels: []
    }
  }
  const availableModelSet = new Set(manifestEntries.map((entry) => entry.name))
  const selectedModelSet = new Set(requestedModels)
  return {
    selectedModels: manifestEntries.filter((entry) => selectedModelSet.has(entry.name)),
    unknownModels: requestedModels.filter((item) => !availableModelSet.has(item))
  }
}

const parsePositiveInteger = (value, fallback) => {
  if (!Number.isFinite(value)) return fallback
  const rounded = Math.trunc(value)
  if (rounded <= 0) return fallback
  return rounded
}

const computeFileSha256 = async (filePath) => {
  const hash = createHash('sha256')
  const stream = fs.createReadStream(filePath)
  return await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

const ensureInsideDir = (baseDir, targetPath) => {
  const relativePath = path.relative(baseDir, targetPath)
  return !!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
}

const downloadToFile = async ({ url, targetPath, timeoutSec, retries }) => {
  const timeoutMs = timeoutSec * 1000
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`
  let lastError = null
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow'
      })
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`)
      }
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tempPath))
      fs.renameSync(tempPath, targetPath)
      clearTimeout(timer)
      return
    } catch (error) {
      clearTimeout(timer)
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true })
      lastError = error
      if (attempt < retries) {
        console.warn(
          `[demucs-runtime-ensure] Download retry (${attempt}/${retries}): ${path.basename(targetPath)} -> ${toShortText(error instanceof Error ? error.message : String(error || ''))}`
        )
      }
    }
  }
  const reason = toShortText(lastError instanceof Error ? lastError.message : String(lastError || ''))
  throw new Error(`[demucs-runtime-ensure] Download failed: ${url} (${reason || 'unknown'})`)
}

const ensureModelYaml = (modelsDir, modelEntry) => {
  const yamlPath = path.resolve(modelsDir, `${modelEntry.name}.yaml`)
  const expectedYaml = String(modelEntry.yaml || '')
  const currentYaml = fs.existsSync(yamlPath) ? fs.readFileSync(yamlPath, 'utf8') : ''
  if (currentYaml === expectedYaml) return
  fs.writeFileSync(yamlPath, expectedYaml, 'utf8')
}

const ensureModelFile = async ({
  modelsDir,
  modelName,
  modelFile,
  retries,
  timeoutSec
}) => {
  const relativePath = normalizeRelativePath(modelFile.name)
  if (!relativePath) {
    throw new Error(
      `[demucs-runtime-ensure] Invalid model file path: ${modelFile.name || '<empty>'}`
    )
  }

  const targetPath = path.resolve(modelsDir, relativePath)
  if (!ensureInsideDir(modelsDir, targetPath)) {
    throw new Error(`[demucs-runtime-ensure] Illegal model file path: ${modelFile.name}`)
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true })

  let needsDownload = !fs.existsSync(targetPath)
  if (!needsDownload && modelFile.sha256) {
    const existingHash = await computeFileSha256(targetPath)
    if (existingHash !== modelFile.sha256) {
      console.warn(
        `[demucs-runtime-ensure] Hash mismatch, re-downloading: ${modelName}/${relativePath}`
      )
      needsDownload = true
    }
  }

  if (needsDownload) {
    console.log(`[demucs-runtime-ensure] Fetching model file: ${modelName}/${relativePath}`)
    await downloadToFile({
      url: modelFile.url,
      targetPath,
      timeoutSec,
      retries
    })
  }

  if (modelFile.sha256) {
    const downloadedHash = await computeFileSha256(targetPath)
    if (downloadedHash !== modelFile.sha256) {
      throw new Error(
        `[demucs-runtime-ensure] SHA256 mismatch after download: ${modelName}/${relativePath}`
      )
    }
  }
}

const ensureDemucsModels = async () => {
  const modelEntries = parseModelManifest()
  if (modelEntries.length === 0) {
    console.log('[demucs-runtime-ensure] No models declared, skip')
    return
  }

  const { selectedModels, unknownModels } = resolveRequestedModels(modelEntries)
  if (unknownModels.length > 0) {
    console.warn(
      `[demucs-runtime-ensure] Unknown models ignored: ${unknownModels.join(', ')}`
    )
  }
  if (selectedModels.length === 0) {
    console.log('[demucs-runtime-ensure] No matching models selected, skip')
    return
  }

  const retries = parsePositiveInteger(modelRetriesArg, 3)
  const timeoutSec = parsePositiveInteger(modelTimeoutSecArg, 600)
  const modelsDir = path.resolve(runtimeRoot, 'models')
  fs.mkdirSync(modelsDir, { recursive: true })

  for (const modelEntry of selectedModels) {
    ensureModelYaml(modelsDir, modelEntry)
    for (const modelFile of modelEntry.files) {
      await ensureModelFile({
        modelsDir,
        modelName: modelEntry.name,
        modelFile,
        retries,
        timeoutSec
      })
    }
  }
}

const probeWindowsGpuAdapters = () => {
  if (process.platform !== 'win32') {
    return {
      names: [],
      hasNvidia: false,
      hasIntel: false,
      hasAmd: false
    }
  }
  const script =
    'Get-CimInstance Win32_VideoController | ForEach-Object { ($_.Name | Out-String).Trim() }'
  const result = runQuiet('powershell', ['-NoProfile', '-Command', script], {
    timeout: 8_000
  })
  if (result.status !== 0) {
    return {
      names: [],
      hasNvidia: false,
      hasIntel: false,
      hasAmd: false
    }
  }
  const names = String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const effectiveNames = names.filter((name) => {
    const lowered = name.toLowerCase()
    if (lowered.includes('microsoft basic render')) return false
    if (lowered.includes('microsoft remote display')) return false
    return true
  })
  const joined = effectiveNames.join(' ').toLowerCase()
  return {
    names: effectiveNames,
    hasNvidia: joined.includes('nvidia') || joined.includes('geforce') || joined.includes('quadro'),
    hasIntel: joined.includes('intel') || joined.includes('arc'),
    hasAmd:
      joined.includes('amd') ||
      joined.includes('radeon') ||
      joined.includes('advanced micro devices')
  }
}

const resolveAutoProfiles = (platformKey, platformConfig) => {
  const profileSet = new Set(['cpu'])
  if (platformKey === 'win32-x64') {
    const adapters = probeWindowsGpuAdapters()
    if (adapters.hasNvidia) profileSet.add('cuda')
    if (adapters.hasIntel) profileSet.add('xpu')
    if (adapters.hasAmd) profileSet.add('directml')
  } else if (platformKey === 'darwin-arm64') {
    profileSet.add('mps')
  } else if (platformKey.startsWith('linux')) {
    if (probeCommand('nvidia-smi', ['-L'])) profileSet.add('cuda')
    if (probeCommand('rocminfo', []) || probeCommand('rocm-smi', ['--showproductname'])) {
      profileSet.add('rocm')
    }
  }
  return Array.from(profileSet).filter((item) => !!platformConfig?.profiles?.[item])
}

const ensureBaseRuntime = (platformKey, platformConfig) => {
  const baseRuntimeDirName = String(platformConfig?.baseRuntimeDir || 'runtime')
  const baseRuntimeDir = path.resolve(runtimeRoot, platformKey, baseRuntimeDirName)
  const basePipInstallArgs = normalizeList(platformConfig?.basePipInstall)
  const basePythonPath = resolveRuntimePythonPath(baseRuntimeDir)
  const baseEnv = buildRuntimeEnv(baseRuntimeDir)

  if (!fs.existsSync(basePythonPath)) {
    const pythonCommand = resolveSystemPythonCommand()
    if (!pythonCommand) {
      throw new Error('[demucs-runtime-ensure] No system Python found for bootstrap')
    }
    fs.mkdirSync(path.dirname(baseRuntimeDir), { recursive: true })
    console.log(`[demucs-runtime-ensure] Creating base runtime: ${baseRuntimeDir}`)
    run(pythonCommand.command, [...pythonCommand.args, '-m', 'venv', baseRuntimeDir])
  }

  const resolvedBasePython = resolveRuntimePythonPath(baseRuntimeDir)
  if (!fs.existsSync(resolvedBasePython)) {
    throw new Error(`[demucs-runtime-ensure] Base runtime python missing: ${resolvedBasePython}`)
  }

  if (install) {
    const baseProbe = runQuiet(
      resolvedBasePython,
      ['-c', 'import demucs, torch, torchaudio, onnxruntime'],
      { env: baseEnv }
    )
    if (baseProbe.status !== 0 && basePipInstallArgs.length > 0) {
      console.log(
        `[demucs-runtime-ensure] Installing base runtime deps: ${basePipInstallArgs.join(' ')}`
      )
      run(resolvedBasePython, ['-m', 'pip', 'install', '--upgrade', ...basePipInstallArgs], {
        env: baseEnv
      })
    }
  }

  ensureModelsDir()

  return {
    baseRuntimeDir,
    basePythonPath: resolvedBasePython
  }
}

const buildPrepareCommand = (params) => {
  const commandArgs = [
    path.resolve('./scripts/prepare-demucs-runtimes.mjs'),
    '--runtime-root',
    runtimeRoot,
    '--platform',
    platformArg,
    '--profiles',
    params.profiles.join(',')
  ]
  if (install) commandArgs.push('--install')
  if (params.force) commandArgs.push('--force')
  return commandArgs
}

const runPrepare = (profiles, options = {}) => {
  const uniqueProfiles = Array.from(
    new Set(profiles.map((item) => String(item).trim()).filter(Boolean))
  )
  if (uniqueProfiles.length === 0) return
  const commandArgs = buildPrepareCommand({
    profiles: uniqueProfiles,
    force: !!options.force
  })
  run(process.execPath, commandArgs)
}

const main = async () => {
  if (skip) {
    console.log('[demucs-runtime-ensure] Skip requested via FRKB_SKIP_DEMUCS_RUNTIME_ENSURE')
    return
  }

  const platformConfig = runtimeProfiles?.[platformArg]
  if (!platformConfig || typeof platformConfig !== 'object') {
    throw new Error(`[demucs-runtime-ensure] Unsupported platform key: ${platformArg}`)
  }

  ensureBaseRuntime(platformArg, platformConfig)

  const explicitProfiles = parseCsv(profileArg)
  const selectedProfiles =
    explicitProfiles.length > 0
      ? explicitProfiles.filter((profileName) => !!platformConfig.profiles?.[profileName])
      : resolveAutoProfiles(platformArg, platformConfig)
  const runtimeAssetManifest = await readRuntimeAssetManifest()

  if (selectedProfiles.length === 0) {
    console.log('[demucs-runtime-ensure] No matching profiles selected, skip')
    return
  }

  const rebuildProfiles = []
  const missingProfiles = []
  const brokenProfiles = []

  for (const profileName of selectedProfiles) {
    const profileConfig = platformConfig.profiles?.[profileName]
    if (!profileConfig) continue
    const runtimeDir = path.resolve(
      runtimeRoot,
      platformArg,
      String(profileConfig.targetDir || `runtime-${profileName}`)
    )
    const pythonPath = resolveRuntimePythonPath(runtimeDir)
    const metadataPath = path.join(runtimeDir, '.frkb-runtime-meta.json')
    const pipInstallArgs = normalizeList(profileConfig.pipInstall)

    if (!fs.existsSync(pythonPath)) {
      const restored = await tryInstallProfileFromRemoteAsset(
        runtimeAssetManifest,
        profileName,
        runtimeDir
      )
      if (restored) continue
      missingProfiles.push(profileName)
      continue
    }

    if (install && pipInstallArgs.length > 0 && !fs.existsSync(metadataPath)) {
      const restored = await tryInstallProfileFromRemoteAsset(
        runtimeAssetManifest,
        profileName,
        runtimeDir
      )
      if (restored) continue
      addUniqueItem(rebuildProfiles, profileName)
      continue
    }

    if (!install) continue
    const probe = probeRuntimeModules(pythonPath, runtimeDir)
    if (!probe.ok || !probe.payload) {
      const restored = await tryInstallProfileFromRemoteAsset(
        runtimeAssetManifest,
        profileName,
        runtimeDir
      )
      if (restored) continue
      addUniqueItem(brokenProfiles, profileName)
      addUniqueItem(rebuildProfiles, profileName)
      console.warn(
        `[demucs-runtime-ensure] Runtime probe failed (${profileName}), will rebuild: ${
          probe.error || 'unknown'
        }`
      )
      continue
    }
    const payload = probe.payload
    const baseReady = !!payload.demucs && !!payload.torch && !!payload.torchaudio
    const requiresDirectml = profileName === 'directml'
    const requiresXpu = profileName === 'xpu'
    const directmlReady = !requiresDirectml ? true : !!payload.torch_directml
    const xpuReady = !requiresXpu ? true : !!payload.xpu_backend
    if (!baseReady || !directmlReady || !xpuReady) {
      const restored = await tryInstallProfileFromRemoteAsset(
        runtimeAssetManifest,
        profileName,
        runtimeDir
      )
      if (restored) continue
      addUniqueItem(brokenProfiles, profileName)
      addUniqueItem(rebuildProfiles, profileName)
      console.warn(
        `[demucs-runtime-ensure] Runtime deps incomplete (${profileName}), will rebuild: demucs=${payload.demucs} torch=${payload.torch} torchaudio=${payload.torchaudio} torch_version=${payload.torch_version || ''} xpu_backend=${payload.xpu_backend} torch_directml=${payload.torch_directml}`
      )
    }
  }

  console.log(
    `[demucs-runtime-ensure] Selected profiles: ${selectedProfiles.join(', ')} (missing=${missingProfiles.length}, rebuild=${rebuildProfiles.length}, broken=${brokenProfiles.length})`
  )

  if (rebuildProfiles.length > 0) {
    runPrepare(rebuildProfiles, { force: true })
  }
  if (missingProfiles.length > 0) {
    runPrepare(missingProfiles, { force })
  }

  await ensureDemucsModels()

  console.log('[demucs-runtime-ensure] Completed')
}

void (async () => {
  try {
    await main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || '')
    if (strict) {
      console.error(`[demucs-runtime-ensure] Failed: ${message}`)
      process.exit(1)
    }
    console.warn(`[demucs-runtime-ensure] Warning: ${message}`)
    process.exit(0)
  }
})()
