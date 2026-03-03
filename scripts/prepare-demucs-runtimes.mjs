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

const runtimeRootArg = getArgValue('--runtime-root', 'vendor/demucs')
const platformArg = getArgValue('--platform', platformDefault)
const profileArg = getArgValue('--profiles', '')
const pipExtraArg = getArgValue('--pip-extra', '')
const force = hasFlag('--force')
const install = hasFlag('--install')
const pipExtraArgs = pipExtraArg
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)

const runtimeRoot = path.resolve(runtimeRootArg)
const platformConfig = runtimeProfiles?.[platformArg]

if (!platformConfig || typeof platformConfig !== 'object') {
  console.error(`[demucs-runtime] Unsupported platform key: ${platformArg}`)
  process.exit(1)
}

const baseRuntimeDir = path.resolve(runtimeRoot, platformArg, String(platformConfig.baseRuntimeDir || 'runtime'))
if (!fs.existsSync(baseRuntimeDir)) {
  console.error(`[demucs-runtime] Base runtime not found: ${baseRuntimeDir}`)
  process.exit(1)
}

const profileConfigEntries = Object.entries(platformConfig.profiles || {})
if (profileConfigEntries.length === 0) {
  console.error(`[demucs-runtime] No profiles configured for platform: ${platformArg}`)
  process.exit(1)
}

const requestedProfiles = profileArg
  ? profileArg
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  : profileConfigEntries.map(([profileName]) => profileName)

const selectedProfiles = requestedProfiles
  .map((profileName) => [profileName, platformConfig.profiles?.[profileName]])
  .filter(([, profileConfig]) => !!profileConfig)

if (selectedProfiles.length === 0) {
  console.error(
    `[demucs-runtime] No valid profiles selected. Available: ${profileConfigEntries
      .map(([name]) => name)
      .join(', ')}`
  )
  process.exit(1)
}

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

const runProbe = (pythonPath, runtimeKey) => {
  const script = [
    'import json',
    'payload = {"runtime_key": "", "torch_version": "", "cuda": False, "mps": False, "xpu": False, "directml_installed": False}',
    `payload["runtime_key"] = ${JSON.stringify(runtimeKey)}`,
    'try:',
    '  import torch',
    '  payload["torch_version"] = str(getattr(torch, "__version__", ""))',
    '  payload["cuda"] = bool(getattr(torch, "cuda", None) and torch.cuda.is_available())',
    '  mps_backend = getattr(getattr(torch, "backends", None), "mps", None)',
    '  payload["mps"] = bool(mps_backend and mps_backend.is_available())',
    '  xpu_backend = getattr(torch, "xpu", None)',
    '  payload["xpu"] = bool(xpu_backend and xpu_backend.is_available())',
    'except Exception as exc:',
    '  payload["torch_error"] = str(exc)',
    'try:',
    '  import torch_directml',
    '  payload["directml_installed"] = True',
    'except Exception:',
    '  payload["directml_installed"] = False',
    'print(json.dumps(payload))'
  ].join('\n')
  const result = spawnSync(pythonPath, ['-c', script], {
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.status !== 0) {
    throw new Error(`[demucs-runtime] Probe failed for ${runtimeKey}: ${result.stderr || result.stdout}`)
  }
  const output = String(result.stdout || '')
  const lastLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
  if (!lastLine) {
    throw new Error(`[demucs-runtime] Probe output empty for ${runtimeKey}`)
  }
  return JSON.parse(lastLine)
}

const runCompatibilityProbe = (pythonPath, scriptLines) => {
  const result = spawnSync(pythonPath, ['-c', scriptLines.join('\n')], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 12_000
  })
  return result.status === 0
}

const writeJson = (filePath, data) => {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

for (const [profileName, profileConfig] of selectedProfiles) {
  const targetDirName = String(profileConfig.targetDir || `runtime-${profileName}`)
  const targetRuntimeDir = path.resolve(runtimeRoot, platformArg, targetDirName)
  const pipInstallArgs = [
    ...(Array.isArray(profileConfig.pipInstall)
      ? profileConfig.pipInstall.map((item) => String(item).trim()).filter(Boolean)
      : []),
    ...pipExtraArgs
  ]
    .map((item) => String(item).trim())
    .filter(Boolean)

  if (fs.existsSync(targetRuntimeDir)) {
    if (!force) {
      console.log(`[demucs-runtime] Skip existing runtime (${profileName}): ${targetRuntimeDir}`)
    } else {
      fs.rmSync(targetRuntimeDir, { recursive: true, force: true })
      console.log(`[demucs-runtime] Removed existing runtime (${profileName})`)
    }
  }

  if (!fs.existsSync(targetRuntimeDir)) {
    fs.cpSync(baseRuntimeDir, targetRuntimeDir, { recursive: true })
    console.log(`[demucs-runtime] Copied base runtime -> ${targetDirName}`)
  }

  const pythonPath = resolveRuntimePythonPath(targetRuntimeDir)
  if (!fs.existsSync(pythonPath)) {
    throw new Error(`[demucs-runtime] Python not found for ${profileName}: ${pythonPath}`)
  }

  if (install && pipInstallArgs.length > 0) {
    console.log(`[demucs-runtime] Installing pip deps for ${profileName}: ${pipInstallArgs.join(' ')}`)
    run(pythonPath, ['-m', 'pip', 'install', '--upgrade', ...pipInstallArgs], {
      cwd: targetRuntimeDir
    })
  } else if (pipInstallArgs.length > 0) {
    console.log(
      `[demucs-runtime] ${profileName} has pip deps configured but --install not set, skipped install`
    )
  }

  const probe = runProbe(pythonPath, profileName)
  if (probe?.directml_installed) {
    probe.directml_demucs_compatible = runCompatibilityProbe(pythonPath, [
      'import torch',
      'import torch_directml',
      'x = torch.randn(2048, device="privateuseone:0")',
      '_ = torch.fft.rfft(x)',
      'print("ok")'
    ])
  } else {
    probe.directml_demucs_compatible = false
  }
  if (probe?.xpu) {
    probe.xpu_demucs_compatible = runCompatibilityProbe(pythonPath, [
      'import torch',
      'x = torch.randn(2048, device="xpu")',
      '_ = torch.fft.rfft(x)',
      'print("ok")'
    ])
  } else {
    probe.xpu_demucs_compatible = false
  }
  const metadata = {
    runtimeKey: profileName,
    platform: platformArg,
    generatedAt: new Date().toISOString(),
    installExecuted: install,
    pipInstallArgs,
    probe
  }
  writeJson(path.join(targetRuntimeDir, '.frkb-runtime-meta.json'), metadata)
  console.log(
    `[demucs-runtime] Ready ${profileName} -> cuda=${probe.cuda} mps=${probe.mps} xpu=${probe.xpu} directml=${probe.directml_installed} directml-demucs=${probe.directml_demucs_compatible}`
  )
}

console.log('[demucs-runtime] Completed')
