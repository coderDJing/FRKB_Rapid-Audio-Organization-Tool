import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import {
  createConsoleDownloadProgressReporter,
  createRemoteRuntimeAssetInstaller,
  fetchWithRuntimeProxy,
  probeRuntimeModules,
  readJsonFileIfExists
} from './lib/demucs-runtime-support.mjs'

const runtimeProfilesPath = path.resolve('./scripts/demucs-runtime-profiles.json')
const runtimeProfilesRaw = fs.readFileSync(runtimeProfilesPath, 'utf8')
const runtimeProfiles = JSON.parse(runtimeProfilesRaw)
const modelManifestPath = path.resolve('./scripts/demucs-model-manifest.json')
const DEFAULT_DEMUCS_RUNTIME_MANIFEST_URL =
  'https://github.com/coderDjing/FRKB_Rapid-Audio-Organization-Tool/releases/download/demucs-runtime-assets/demucs-runtime-manifest.json'
const BASE_RUNTIME_METADATA_FILE = '.frkb-base-runtime-meta.json'

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
const modelsOnly = hasFlag('--models-only')
const syncRemoteAssets = hasFlag('--sync-remote-assets')
const preferRemoteAssets =
  syncRemoteAssets ||
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

const normalizeResolvedPath = (value) => {
  const text = String(value || '').trim()
  if (!text) return ''
  try {
    return path.resolve(text)
  } catch {
    return ''
  }
}

const isPathInside = (rootDir, targetPath) => {
  const normalizedRoot = normalizeResolvedPath(rootDir)
  const normalizedTarget = normalizeResolvedPath(targetPath)
  if (!normalizedRoot || !normalizedTarget) return false
  const relativePath = path.relative(normalizedRoot, normalizedTarget)
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}

const inspectPythonRuntime = (command, commandArgs = [], options = {}) => {
  const script = [
    'import json',
    'import os',
    'import sys',
    'payload = {',
    '  "executable": os.path.abspath(sys.executable),',
    '  "prefix": os.path.abspath(sys.prefix),',
    '  "base_prefix": os.path.abspath(getattr(sys, "base_prefix", sys.prefix))',
    '}',
    'print(json.dumps(payload))'
  ].join('\n')
  const result = runQuiet(command, [...commandArgs, '-c', script], {
    timeout: 12_000,
    ...options
  })
  if (result.status !== 0) {
    return {
      ok: false,
      payload: null,
      error: toShortText(result.stderr || result.stdout || `inspect exit ${result.status ?? -1}`)
    }
  }
  const output = String(result.stdout || '')
  const lastLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
  if (!lastLine) {
    return {
      ok: false,
      payload: null,
      error: 'inspect output empty'
    }
  }
  try {
    return {
      ok: true,
      payload: JSON.parse(lastLine),
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

const validatePortableWindowsRuntime = (runtimeDir) => {
  if (process.platform !== 'win32') {
    return {
      ok: true,
      payload: null,
      error: ''
    }
  }
  try {
    const aliasNames = fs
      .readdirSync(runtimeDir)
      .filter((name) => /^python[\w.-]*\.exe$/i.test(String(name || '').trim()))
    for (const aliasName of aliasNames) {
      const aliasPath = path.join(runtimeDir, aliasName)
      const stat = fs.lstatSync(aliasPath)
      const lowerAliasName = aliasName.toLowerCase()
      if (lowerAliasName === 'python.exe' || lowerAliasName === 'pythonw.exe') {
        if (stat.isSymbolicLink()) {
          const linkTarget = fs.readlinkSync(aliasPath)
          return {
            ok: false,
            payload: null,
            error: `canonical python symlink present: ${aliasName} -> ${linkTarget}`
          }
        }
        continue
      }
      const fallbackSourcePath = lowerAliasName.startsWith('pythonw')
        ? path.join(runtimeDir, 'pythonw.exe')
        : path.join(runtimeDir, 'python.exe')
      if (!fs.existsSync(fallbackSourcePath)) {
        const linkTarget = fs.readlinkSync(aliasPath)
        return {
          ok: false,
          payload: null,
          error: `python alias symlink present: ${aliasName} -> ${linkTarget}`
        }
      }
      fs.rmSync(aliasPath, { force: true })
      fs.copyFileSync(fallbackSourcePath, aliasPath)
    }
  } catch (error) {
    return {
      ok: false,
      payload: null,
      error: `inspect runtime aliases failed: ${toShortText(
        error instanceof Error ? error.message : String(error || 'unknown')
      )}`
    }
  }
  const pythonPath = resolveRuntimePythonPath(runtimeDir)
  if (!fs.existsSync(pythonPath)) {
    return {
      ok: false,
      payload: null,
      error: `python missing: ${pythonPath}`
    }
  }
  const identity = inspectPythonRuntime(pythonPath, [], {
    env: buildRuntimeEnv(runtimeDir)
  })
  if (!identity.ok) {
    return {
      ok: false,
      payload: null,
      error: identity.error || `inspect failed: ${pythonPath}`
    }
  }
  const relevantPaths = [
    identity.payload?.executable,
    identity.payload?.prefix,
    identity.payload?.base_prefix
  ]
    .map((entry) => normalizeResolvedPath(entry))
    .filter(Boolean)
  if (relevantPaths.length > 0 && relevantPaths.every((entry) => isPathInside(runtimeDir, entry))) {
    return {
      ok: true,
      payload: identity.payload,
      error: ''
    }
  }
  return {
    ok: false,
    payload: identity.payload,
    error: `non-portable runtime: ${relevantPaths.join(' | ')}`
  }
}

const bootstrapPortableWindowsRuntime = (pythonCommand, targetRuntimeDir) => {
  const identity = inspectPythonRuntime(pythonCommand.command, pythonCommand.args)
  if (!identity.ok || !identity.payload) {
    throw new Error(
      `[demucs-runtime-ensure] Unable to inspect bootstrap Python: ${
        identity.error || 'unknown error'
      }`
    )
  }
  const candidateDirs = []
  const addCandidateDir = (value) => {
    const normalized = normalizeResolvedPath(value)
    if (!normalized || candidateDirs.includes(normalized)) return
    candidateDirs.push(normalized)
  }
  addCandidateDir(identity.payload.base_prefix)
  addCandidateDir(identity.payload.prefix)
  addCandidateDir(path.dirname(normalizeResolvedPath(identity.payload.executable)))
  const sourceRuntimeDir = candidateDirs.find((candidateDir) =>
    fs.existsSync(path.join(candidateDir, 'python.exe'))
  )
  if (!sourceRuntimeDir) {
    throw new Error(
      `[demucs-runtime-ensure] Unable to locate portable Windows Python root from ${
        identity.payload.executable || pythonCommand.command
      }`
    )
  }
  fs.rmSync(targetRuntimeDir, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(targetRuntimeDir), { recursive: true })
  fs.cpSync(sourceRuntimeDir, targetRuntimeDir, {
    recursive: true,
    dereference: true
  })
  const pyvenvCfgPath = path.join(targetRuntimeDir, 'pyvenv.cfg')
  if (fs.existsSync(pyvenvCfgPath)) {
    fs.rmSync(pyvenvCfgPath, { force: true })
  }
  const portableCheck = validatePortableWindowsRuntime(targetRuntimeDir)
  if (!portableCheck.ok) {
    throw new Error(
      `[demucs-runtime-ensure] Portable Windows runtime validation failed: ${
        portableCheck.error || 'unknown error'
      }`
    )
  }
  return {
    sourceRuntimeDir,
    payload: portableCheck.payload
  }
}

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

const normalizeStringArray = (value) =>
  Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : []

const arraysEqual = (left, right) => {
  if (left.length !== right.length) return false
  return left.every((item, index) => item === right[index])
}

const resolveSystemPythonCommand = () => {
  const candidates = []
  const candidateKeys = new Set()

  const addCandidate = (command, args = [], source = '') => {
    const normalizedCommand = String(command || '').trim()
    const normalizedArgs = Array.isArray(args)
      ? args.map((item) => String(item || '').trim()).filter(Boolean)
      : []
    if (!normalizedCommand) return
    const key = JSON.stringify([normalizedCommand, normalizedArgs])
    if (candidateKeys.has(key)) return
    candidateKeys.add(key)
    candidates.push({
      command: normalizedCommand,
      args: normalizedArgs,
      source: String(source || '').trim()
    })
  }

  const addEnvPythonCandidate = (rawValue, source) => {
    const normalized = String(rawValue || '').trim()
    if (!normalized) return
    if (fs.existsSync(normalized)) {
      const stat = fs.statSync(normalized)
      if (stat.isDirectory()) {
        const derivedPaths =
          process.platform === 'win32'
            ? [path.join(normalized, 'python.exe'), path.join(normalized, 'Scripts', 'python.exe')]
            : [path.join(normalized, 'bin', 'python3'), path.join(normalized, 'bin', 'python')]
        for (const derivedPath of derivedPaths) {
          if (fs.existsSync(derivedPath)) {
            addCandidate(derivedPath, [], source)
          }
        }
        return
      }
    }
    addCandidate(normalized, [], source)
  }

  addEnvPythonCandidate(process.env.PYTHON, 'env:PYTHON')
  addEnvPythonCandidate(process.env.npm_config_python, 'env:npm_config_python')
  addEnvPythonCandidate(process.env.pythonLocation, 'env:pythonLocation')

  if (process.platform === 'win32') {
    addCandidate('python', [], 'path:python')
    addCandidate('python3', [], 'path:python3')
    addCandidate('py', ['-3'], 'launcher:py -3')
  } else {
    addCandidate('python3', [], 'path:python3')
    addCandidate('python', [], 'path:python')
  }

  for (const candidate of candidates) {
    const result = runQuiet(candidate.command, [...candidate.args, '--version'])
    if (result.status !== 0) continue
    const version = toShortText(result.stdout || result.stderr || '', 80)
    return {
      ...candidate,
      version
    }
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

const tryInstallProfileFromRemoteAsset = createRemoteRuntimeAssetInstaller({
  preferRemoteAssets,
  syncRemoteAssets,
  runtimeAssetManifestUrl,
  platformArg,
  runtimeRoot,
  run,
  normalizeSha256,
  normalizeRelativePath,
  computeFileSha256,
  toShortText
})

const ensureInsideDir = (baseDir, targetPath) => {
  const relativePath = path.relative(baseDir, targetPath)
  return !!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
}

const waitForWriterDrain = async (writer) =>
  await new Promise((resolve, reject) => {
    const onDrain = () => {
      writer.off('error', onError)
      resolve()
    }
    const onError = (error) => {
      writer.off('drain', onDrain)
      reject(error)
    }
    writer.once('drain', onDrain)
    writer.once('error', onError)
  })

const closeWriter = async (writer) =>
  await new Promise((resolve, reject) => {
    const onFinish = () => {
      writer.off('error', onError)
      resolve()
    }
    const onError = (error) => {
      writer.off('finish', onFinish)
      reject(error)
    }
    writer.once('finish', onFinish)
    writer.once('error', onError)
    writer.end()
  })

const downloadToFile = async ({ url, targetPath, timeoutSec, retries }) => {
  const timeoutMs = timeoutSec * 1000
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`
  let lastError = null
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let writer = null
    try {
      const response = await fetchWithRuntimeProxy(url, {
        signal: controller.signal,
        redirect: 'follow'
      })
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`)
      }
      const totalBytes = Number(response.headers.get('content-length') || 0)
      const reportProgress = createConsoleDownloadProgressReporter({
        label: `model file ${path.basename(targetPath)}`,
        totalBytes
      })
      writer = fs.createWriteStream(tempPath)
      let downloadedBytes = 0
      for await (const chunk of Readable.fromWeb(response.body)) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        downloadedBytes += buffer.byteLength
        if (!writer.write(buffer)) {
          await waitForWriterDrain(writer)
        }
        reportProgress({ downloadedBytes })
      }
      await closeWriter(writer)
      reportProgress({ downloadedBytes, done: true })
      if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { force: true })
      }
      fs.renameSync(tempPath, targetPath)
      clearTimeout(timer)
      return
    } catch (error) {
      clearTimeout(timer)
      try {
        writer?.destroy()
      } catch {}
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true })
      lastError = error
      if (attempt < retries) {
        console.warn(
          `[demucs-runtime-ensure] Download retry (${attempt}/${retries}): ${path.basename(targetPath)} -> ${toShortText(error instanceof Error ? error.message : String(error || ''))}`
        )
      }
    }
  }
  const reason = toShortText(
    lastError instanceof Error ? lastError.message : String(lastError || '')
  )
  throw new Error(`[demucs-runtime-ensure] Download failed: ${url} (${reason || 'unknown'})`)
}

const ensureModelYaml = (modelsDir, modelEntry) => {
  const yamlPath = path.resolve(modelsDir, `${modelEntry.name}.yaml`)
  const expectedYaml = String(modelEntry.yaml || '')
  const currentYaml = fs.existsSync(yamlPath) ? fs.readFileSync(yamlPath, 'utf8') : ''
  if (currentYaml === expectedYaml) return
  fs.writeFileSync(yamlPath, expectedYaml, 'utf8')
}

const ensureModelFile = async ({ modelsDir, modelName, modelFile, retries, timeoutSec }) => {
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
    console.warn(`[demucs-runtime-ensure] Unknown models ignored: ${unknownModels.join(', ')}`)
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
  const baseMetadataPath = path.join(baseRuntimeDir, BASE_RUNTIME_METADATA_FILE)
  const baseMetadata = readJsonFileIfExists(baseMetadataPath)

  let needsBootstrap = !fs.existsSync(basePythonPath)
  if (!needsBootstrap && process.platform === 'win32') {
    const portableCheck = validatePortableWindowsRuntime(baseRuntimeDir)
    if (!portableCheck.ok) {
      console.warn(
        `[demucs-runtime-ensure] Rebuilding non-portable Windows base runtime: ${portableCheck.error}`
      )
      fs.rmSync(baseRuntimeDir, { recursive: true, force: true })
      needsBootstrap = true
    }
  }
  if (
    !needsBootstrap &&
    install &&
    !arraysEqual(normalizeStringArray(baseMetadata?.pipInstallArgs), basePipInstallArgs)
  ) {
    console.warn(
      `[demucs-runtime-ensure] Rebuilding base runtime due to dependency change: ${baseRuntimeDir}`
    )
    fs.rmSync(baseRuntimeDir, { recursive: true, force: true })
    needsBootstrap = true
  }

  if (needsBootstrap) {
    const pythonCommand = resolveSystemPythonCommand()
    if (!pythonCommand) {
      throw new Error('[demucs-runtime-ensure] No system Python found for bootstrap')
    }
    fs.mkdirSync(path.dirname(baseRuntimeDir), { recursive: true })
    const bootstrapCommandText = [pythonCommand.command, ...pythonCommand.args].join(' ')
    const bootstrapVersionText = pythonCommand.version ? ` (${pythonCommand.version})` : ''
    const bootstrapSourceText = pythonCommand.source ? ` via ${pythonCommand.source}` : ''
    const venvArgs = [...pythonCommand.args, '-m', 'venv']
    if (process.platform === 'darwin') {
      // macOS universal packaging chokes on venv symlinks that resolve outside the app bundle.
      venvArgs.push('--copies')
    }
    venvArgs.push(baseRuntimeDir)
    console.log(`[demucs-runtime-ensure] Creating base runtime: ${baseRuntimeDir}`)
    console.log(
      `[demucs-runtime-ensure] Bootstrap Python${bootstrapSourceText}: ${bootstrapCommandText}${bootstrapVersionText}`
    )
    if (process.platform === 'win32') {
      const bootstrapResult = bootstrapPortableWindowsRuntime(pythonCommand, baseRuntimeDir)
      console.log(
        `[demucs-runtime-ensure] Copied portable Windows runtime from ${bootstrapResult.sourceRuntimeDir}`
      )
    } else {
      run(pythonCommand.command, venvArgs)
    }
  }

  const resolvedBasePython = resolveRuntimePythonPath(baseRuntimeDir)
  if (!fs.existsSync(resolvedBasePython)) {
    throw new Error(`[demucs-runtime-ensure] Base runtime python missing: ${resolvedBasePython}`)
  }
  if (process.platform === 'win32') {
    const portableCheck = validatePortableWindowsRuntime(baseRuntimeDir)
    if (!portableCheck.ok) {
      throw new Error(
        `[demucs-runtime-ensure] Windows base runtime is not portable: ${portableCheck.error}`
      )
    }
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
    fs.writeFileSync(
      baseMetadataPath,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          platform: platformKey,
          baseRuntimeDir: baseRuntimeDirName,
          pipInstallArgs: basePipInstallArgs
        },
        null,
        2
      )}\n`,
      'utf8'
    )
  }

  ensureModelsDir()

  return {
    baseRuntimeDir,
    basePythonPath: resolvedBasePython,
    basePipInstallArgs
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

  if (modelsOnly) {
    await ensureDemucsModels()
    console.log('[demucs-runtime-ensure] Completed (models only)')
    return
  }

  const baseRuntimeInfo = syncRemoteAssets
    ? {
        basePipInstallArgs: []
      }
    : ensureBaseRuntime(platformArg, platformConfig)

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
    const metadata = readJsonFileIfExists(metadataPath)

    if (syncRemoteAssets) {
      const synced = await tryInstallProfileFromRemoteAsset(profileName, runtimeDir)
      if (!synced) {
        throw new Error(`[demucs-runtime-ensure] Runtime asset sync failed (${profileName})`)
      }
      continue
    }

    if (!fs.existsSync(pythonPath)) {
      const restored = await tryInstallProfileFromRemoteAsset(profileName, runtimeDir)
      if (restored) continue
      missingProfiles.push(profileName)
      continue
    }

    if (install && !fs.existsSync(metadataPath)) {
      const restored = await tryInstallProfileFromRemoteAsset(profileName, runtimeDir)
      if (restored) continue
      addUniqueItem(rebuildProfiles, profileName)
      continue
    }

    if (
      install &&
      metadata &&
      (!arraysEqual(normalizeStringArray(metadata?.pipInstallArgs), pipInstallArgs) ||
        !arraysEqual(
          normalizeStringArray(metadata?.basePipInstallArgs),
          baseRuntimeInfo.basePipInstallArgs
        ))
    ) {
      const restored = await tryInstallProfileFromRemoteAsset(profileName, runtimeDir)
      if (restored) continue
      addUniqueItem(rebuildProfiles, profileName)
      console.warn(
        `[demucs-runtime-ensure] Runtime metadata changed (${profileName}), will rebuild`
      )
      continue
    }

    if (!install) continue
    const probe = probeRuntimeModules({
      pythonPath,
      runtimeDir,
      buildRuntimeEnv,
      runQuiet,
      toShortText
    })
    if (!probe.ok || !probe.payload) {
      const restored = await tryInstallProfileFromRemoteAsset(profileName, runtimeDir)
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
      const restored = await tryInstallProfileFromRemoteAsset(profileName, runtimeDir)
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
