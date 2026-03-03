import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const runtimeProfilesPath = path.resolve('./scripts/demucs-runtime-profiles.json')
const runtimeProfilesRaw = fs.readFileSync(runtimeProfilesPath, 'utf8')
const runtimeProfiles = JSON.parse(runtimeProfilesRaw)

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

const runtimeRootArg = getArgValue('--runtime-root', 'vendor/demucs')
const platformArg = getArgValue('--platform', platformDefault)
const profileArg = getArgValue('--profiles', '')
const install = !hasFlag('--no-install')
const strict = hasFlag('--strict') || hasFlag('--ci')
const force = hasFlag('--force')
const skip =
  process.env.FRKB_SKIP_DEMUCS_RUNTIME_ENSURE === '1' || process.env.FRKB_SKIP_DEMUCS_RUNTIME_ENSURE === 'true'

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
  Array.isArray(input)
    ? input
        .map((item) => String(item).trim())
        .filter(Boolean)
    : []

const ensureModelsDir = () => {
  const modelsDir = path.resolve(runtimeRoot, 'models')
  fs.mkdirSync(modelsDir, { recursive: true })
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
    "Get-CimInstance Win32_VideoController | ForEach-Object { ($_.Name | Out-String).Trim() }"
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
    hasAmd: joined.includes('amd') || joined.includes('radeon') || joined.includes('advanced micro devices')
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
    const baseProbe = runQuiet(resolvedBasePython, ['-c', 'import demucs, torch, torchaudio'])
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
  const uniqueProfiles = Array.from(new Set(profiles.map((item) => String(item).trim()).filter(Boolean)))
  if (uniqueProfiles.length === 0) return
  const commandArgs = buildPrepareCommand({
    profiles: uniqueProfiles,
    force: !!options.force
  })
  run(process.execPath, commandArgs)
}

const main = () => {
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
      rebuildProfiles.push(profileName)
    }
  }

  console.log(
    `[demucs-runtime-ensure] Selected profiles: ${selectedProfiles.join(', ')} (missing=${missingProfiles.length}, rebuild=${rebuildProfiles.length})`
  )

  if (rebuildProfiles.length > 0) {
    runPrepare(rebuildProfiles, { force: true })
  }
  if (missingProfiles.length > 0) {
    runPrepare(missingProfiles, { force })
  }

  console.log('[demucs-runtime-ensure] Completed')
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error || '')
  if (strict) {
    console.error(`[demucs-runtime-ensure] Failed: ${message}`)
    process.exit(1)
  }
  console.warn(`[demucs-runtime-ensure] Warning: ${message}`)
  process.exit(0)
}
