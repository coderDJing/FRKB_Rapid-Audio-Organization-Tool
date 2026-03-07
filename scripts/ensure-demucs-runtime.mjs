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
const onnxManifestPath = path.resolve('./scripts/demucs-onnx-manifest.json')
const onnxFastScriptTemplatePath = path.resolve('./scripts/demucs/fast_separate.py')

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
const onnxAssetsArg = getArgValue('--onnx-assets', '')
const modelRetriesArg = Number(getArgValue('--model-retries', '3'))
const modelTimeoutSecArg = Number(getArgValue('--model-timeout-sec', '600'))
const install = !hasFlag('--no-install')
const strict = hasFlag('--strict') || hasFlag('--ci')
const force = hasFlag('--force')
const skipOnnxFast = hasFlag('--skip-onnx-fast') || hasFlag('--no-onnx-fast')
const skip =
  process.env.FRKB_SKIP_DEMUCS_RUNTIME_ENSURE === '1' ||
  process.env.FRKB_SKIP_DEMUCS_RUNTIME_ENSURE === 'true'
const skipOnnxFastEnv =
  process.env.FRKB_SKIP_DEMUCS_ONNX_FAST_ENSURE === '1' ||
  process.env.FRKB_SKIP_DEMUCS_ONNX_FAST_ENSURE === 'true'

const runtimeRoot = path.resolve(runtimeRootArg)

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

const probeRuntimeModules = (pythonPath) => {
  const result = runQuiet(
    pythonPath,
    [
      '-c',
      [
        'import json',
        'payload = {"demucs": False, "torch": False, "torchaudio": False, "onnxruntime": False, "torch_directml": False, "onnxruntime_directml_provider": False}',
        'try:',
        '  import demucs',
        '  payload["demucs"] = True',
        'except Exception as exc:',
        '  payload["demucs_error"] = str(exc)',
        'try:',
        '  import torch',
        '  payload["torch"] = True',
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
      timeout: 20_000
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

const parseOnnxManifest = () => {
  const raw = fs.readFileSync(onnxManifestPath, 'utf8')
  const parsed = JSON.parse(raw)
  const assetEntries = Array.isArray(parsed?.assets) ? parsed.assets : []
  return assetEntries
    .map((entry) => ({
      name: normalizeModelName(entry?.name),
      relativePath: normalizeRelativePath(entry?.relativePath),
      url: normalizeUrl(entry?.url),
      sha256: normalizeSha256(entry?.sha256)
    }))
    .filter((entry) => !!entry.name && !!entry.relativePath && !!entry.url)
}

const ensureModelYaml = (modelsDir, modelName, yaml) => {
  const targetPath = path.join(modelsDir, `${modelName}.yaml`)
  const expected = yaml.endsWith('\n') ? yaml : `${yaml}\n`
  const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : ''
  if (existing === expected) return
  fs.writeFileSync(targetPath, expected, 'utf8')
}

const calcFileSha256 = (targetPath) => {
  const hash = createHash('sha256')
  const stream = fs.createReadStream(targetPath)
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', (error) => reject(error))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

const verifyFileHash = async (targetPath, expectedSha256) => {
  const normalizedExpected = normalizeSha256(expectedSha256)
  if (!normalizedExpected) return true
  const actual = await calcFileSha256(targetPath)
  return actual === normalizedExpected
}

const removeFileIfExists = (targetPath) => {
  try {
    if (fs.existsSync(targetPath)) {
      fs.rmSync(targetPath, { force: true })
    }
  } catch {}
}

const cleanupModelTempFiles = (modelsDir) => {
  let removedCount = 0
  try {
    const entries = fs.readdirSync(modelsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const name = String(entry.name || '')
      if (!name.includes('.tmp-')) continue
      const targetPath = path.join(modelsDir, name)
      removeFileIfExists(targetPath)
      removedCount += 1
    }
  } catch {}
  return removedCount
}

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0))
  })

const downloadToFile = async (url, targetPath, retries) => {
  const maxRetries = Math.max(1, Number.isFinite(retries) ? retries : 3)
  const timeoutMs = Math.max(
    30_000,
    (Number.isFinite(modelTimeoutSecArg) ? modelTimeoutSecArg : 600) * 1000
  )
  let lastError = null
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const tempPath = `${targetPath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const controller = new AbortController()
    const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent': 'frkb-demucs-runtime-ensure/1.0'
        }
      })
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim())
      }
      const body = response.body
      await pipeline(Readable.fromWeb(body), fs.createWriteStream(tempPath))
      const stat = fs.statSync(tempPath)
      if (!stat || stat.size <= 0) {
        throw new Error('Downloaded file is empty')
      }
      fs.renameSync(tempPath, targetPath)
      clearTimeout(timeoutTimer)
      return
    } catch (error) {
      clearTimeout(timeoutTimer)
      lastError = error
      removeFileIfExists(tempPath)
      if (attempt < maxRetries) {
        await sleep(300 * attempt)
      }
    }
  }
  throw lastError || new Error(`Download failed: ${url}`)
}

const ensureDemucsModels = async (options = {}) => {
  const modelsDir = path.resolve(runtimeRoot, 'models')
  fs.mkdirSync(modelsDir, { recursive: true })
  const removedTempCount = cleanupModelTempFiles(modelsDir)
  if (removedTempCount > 0) {
    console.log(`[demucs-runtime-ensure] Removed stale model temp files: ${removedTempCount}`)
  }
  const manifestEntries = parseModelManifest()
  if (manifestEntries.length === 0) {
    throw new Error('[demucs-runtime-ensure] Model manifest is empty')
  }
  const requestedModels = parseCsv(modelsArg)
    .map((item) => normalizeModelName(item))
    .filter(Boolean)
  const defaultModels = ['htdemucs']
  const selectedEntries =
    requestedModels.length > 0
      ? manifestEntries.filter((entry) => requestedModels.includes(entry.name))
      : manifestEntries.filter((entry) => defaultModels.includes(entry.name))
  const effectiveSelectedEntries = selectedEntries.length > 0 ? selectedEntries : manifestEntries
  if (effectiveSelectedEntries.length === 0) {
    const available = manifestEntries.map((entry) => entry.name).join(', ')
    throw new Error(
      `[demucs-runtime-ensure] No valid model selected. Available models: ${available || 'none'}`
    )
  }
  const retries = Math.max(1, Number.isFinite(modelRetriesArg) ? modelRetriesArg : 3)
  let downloadedCount = 0
  let skippedCount = 0
  for (const entry of effectiveSelectedEntries) {
    ensureModelYaml(modelsDir, entry.name, entry.yaml)
    for (const file of entry.files) {
      const targetPath = path.join(modelsDir, file.name)
      const exists = fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0
      if (exists) {
        const hashOk = await verifyFileHash(targetPath, file.sha256)
        if (!hashOk) {
          console.warn(`[demucs-runtime-ensure] Hash mismatch, redownloading: ${file.name}`)
          removeFileIfExists(targetPath)
        } else {
          skippedCount += 1
          continue
        }
      }
      console.log(`[demucs-runtime-ensure] Downloading model file: ${file.name}`)
      await downloadToFile(file.url, targetPath, retries)
      const hashOk = await verifyFileHash(targetPath, file.sha256)
      if (!hashOk) {
        removeFileIfExists(targetPath)
        throw new Error(`[demucs-runtime-ensure] SHA256 mismatch after download: ${file.name}`)
      }
      if (!normalizeSha256(file.sha256)) {
        console.warn(
          `[demucs-runtime-ensure] Missing sha256 in manifest: ${entry.name}/${file.name}`
        )
      }
      downloadedCount += 1
    }
  }
  console.log(
    `[demucs-runtime-ensure] Models ready: ${effectiveSelectedEntries
      .map((entry) => entry.name)
      .join(', ')} (downloaded=${downloadedCount}, existing=${skippedCount})`
  )
}

const ensureOnnxFastAssets = async () => {
  const onnxRootDir = path.resolve(runtimeRoot, 'onnx')
  fs.mkdirSync(onnxRootDir, { recursive: true })
  if (!fs.existsSync(onnxFastScriptTemplatePath)) {
    throw new Error(
      `[demucs-runtime-ensure] ONNX fast script template missing: ${onnxFastScriptTemplatePath}`
    )
  }
  const onnxFastScriptTargetPath = path.resolve(onnxRootDir, 'fast_separate.py')
  const onnxFastScriptContent = fs.readFileSync(onnxFastScriptTemplatePath, 'utf8')
  const existingOnnxFastScriptContent = fs.existsSync(onnxFastScriptTargetPath)
    ? fs.readFileSync(onnxFastScriptTargetPath, 'utf8')
    : ''
  if (existingOnnxFastScriptContent !== onnxFastScriptContent) {
    fs.writeFileSync(onnxFastScriptTargetPath, onnxFastScriptContent, 'utf8')
  }
  const removedTempCount = cleanupModelTempFiles(onnxRootDir)
  if (removedTempCount > 0) {
    console.log(`[demucs-runtime-ensure] Removed stale onnx temp files: ${removedTempCount}`)
  }
  const manifestEntries = parseOnnxManifest()
  if (manifestEntries.length === 0) {
    throw new Error('[demucs-runtime-ensure] ONNX manifest is empty')
  }
  const requestedAssets = parseCsv(onnxAssetsArg)
    .map((item) => normalizeModelName(item))
    .filter(Boolean)
  const selectedEntries =
    requestedAssets.length > 0
      ? manifestEntries.filter((entry) => requestedAssets.includes(entry.name))
      : manifestEntries
  if (selectedEntries.length === 0) {
    const available = manifestEntries.map((entry) => entry.name).join(', ')
    throw new Error(
      `[demucs-runtime-ensure] No valid ONNX asset selected. Available: ${available || 'none'}`
    )
  }

  const retries = Math.max(1, Number.isFinite(modelRetriesArg) ? modelRetriesArg : 3)
  let downloadedCount = 0
  let skippedCount = 0
  for (const entry of selectedEntries) {
    const targetPath = path.resolve(runtimeRoot, entry.relativePath)
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    const exists = fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0
    if (exists) {
      const hashOk = await verifyFileHash(targetPath, entry.sha256)
      if (!hashOk) {
        console.warn(`[demucs-runtime-ensure] ONNX hash mismatch, redownloading: ${entry.name}`)
        removeFileIfExists(targetPath)
      } else {
        skippedCount += 1
        continue
      }
    }
    console.log(`[demucs-runtime-ensure] Downloading ONNX asset: ${entry.name}`)
    await downloadToFile(entry.url, targetPath, retries)
    const hashOk = await verifyFileHash(targetPath, entry.sha256)
    if (!hashOk) {
      removeFileIfExists(targetPath)
      throw new Error(`[demucs-runtime-ensure] ONNX SHA256 mismatch: ${entry.name}`)
    }
    if (!normalizeSha256(entry.sha256)) {
      console.warn(`[demucs-runtime-ensure] Missing ONNX sha256 in manifest: ${entry.name}`)
    }
    downloadedCount += 1
  }
  console.log(
    `[demucs-runtime-ensure] ONNX assets ready: ${selectedEntries
      .map((entry) => entry.name)
      .join(', ')} (downloaded=${downloadedCount}, existing=${skippedCount})`
  )
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
  const joined = names.join(' ').toLowerCase()
  return {
    names,
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
    if (adapters.hasIntel || adapters.hasAmd) profileSet.add('directml')
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
    run(resolvedBasePython, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'])
    const baseProbe = runQuiet(resolvedBasePython, [
      '-c',
      'import demucs, torch, torchaudio, onnxruntime'
    ])
    if (baseProbe.status !== 0 && basePipInstallArgs.length > 0) {
      console.log(
        `[demucs-runtime-ensure] Installing base runtime deps: ${basePipInstallArgs.join(' ')}`
      )
      run(resolvedBasePython, ['-m', 'pip', 'install', '--upgrade', ...basePipInstallArgs])
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
      missingProfiles.push(profileName)
      continue
    }

    if (install && pipInstallArgs.length > 0 && !fs.existsSync(metadataPath)) {
      addUniqueItem(rebuildProfiles, profileName)
      continue
    }

    if (!install) continue
    const probe = probeRuntimeModules(pythonPath)
    if (!probe.ok || !probe.payload) {
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
    const baseReady =
      !!payload.demucs && !!payload.torch && !!payload.torchaudio && !!payload.onnxruntime
    const requiresDirectml = profileName === 'directml'
    const directmlReady = !requiresDirectml
      ? true
      : !!payload.torch_directml && !!payload.onnxruntime_directml_provider
    if (!baseReady || !directmlReady) {
      addUniqueItem(brokenProfiles, profileName)
      addUniqueItem(rebuildProfiles, profileName)
      console.warn(
        `[demucs-runtime-ensure] Runtime deps incomplete (${profileName}), will rebuild: demucs=${!!payload.demucs} torch=${!!payload.torch} torchaudio=${!!payload.torchaudio} onnxruntime=${!!payload.onnxruntime} torch_directml=${!!payload.torch_directml} onnxruntime_dml=${!!payload.onnxruntime_directml_provider}`
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
  if (skipOnnxFast || skipOnnxFastEnv) {
    console.log('[demucs-runtime-ensure] Skip ONNX fast assets requested')
  } else {
    await ensureOnnxFastAssets()
  }

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
