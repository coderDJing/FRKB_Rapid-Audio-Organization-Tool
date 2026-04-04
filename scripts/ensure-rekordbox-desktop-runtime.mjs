import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { bootstrapPortableDarwinPython } from './lib/demucs-standalone-python.mjs'

const args = process.argv.slice(2)

const hasFlag = (flag) => args.includes(flag)
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

const platformKey = (() => {
  if (process.platform === 'win32') return 'win32-x64'
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  return ''
})()

if (!platformKey) {
  console.log('[rekordbox-runtime] Skip unsupported platform')
  process.exit(0)
}

const runtimeRootArg = getArgValue('--runtime-root', 'vendor/rekordbox-desktop-runtime')
const runtimeRoot = path.resolve(runtimeRootArg)
const runtimeDir = path.join(runtimeRoot, platformKey, 'python')
const requirementsPath = path.resolve('./scripts/rekordbox-desktop-runtime-requirements.txt')
const force = hasFlag('--force')

const resolvePythonLauncher = () => {
  if (process.platform === 'win32') {
    return {
      command: 'py',
      args: ['-3.11']
    }
  }
  return {
    command: 'python3',
    args: []
  }
}

const resolveRuntimePython = () => {
  if (process.platform === 'win32') {
    return path.join(runtimeDir, 'Scripts', 'python.exe')
  }
  return path.join(runtimeDir, 'bin', 'python3')
}

const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    windowsHide: false,
    ...options
  })
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} -> exit ${result.status ?? -1}`)
  }
}

const runQuiet = (command, commandArgs, options = {}) =>
  spawnSync(command, commandArgs, {
    encoding: 'utf8',
    windowsHide: true,
    ...options
  })

const ensureDirectory = (targetPath) => {
  fs.mkdirSync(targetPath, { recursive: true })
}

const isRuntimeReady = () => {
  const runtimePython = resolveRuntimePython()
  if (!fs.existsSync(runtimePython)) return false
  const probe = runQuiet(
    runtimePython,
    [
      '-c',
      [
        'import json',
        'import pyrekordbox',
        'import sqlalchemy',
        'import sqlcipher3',
        'print(json.dumps({"ok": True, "version": getattr(pyrekordbox, "__version__", "")}))'
      ].join('\n')
    ],
    {
      env: {
        ...process.env,
        PYTHONNOUSERSITE: '1'
      }
    }
  )
  return probe.status === 0
}

ensureDirectory(runtimeDir)

if (!force && isRuntimeReady()) {
  console.log(`[rekordbox-runtime] Ready: ${runtimeDir}`)
  process.exit(0)
}

console.log(`[rekordbox-runtime] Preparing runtime -> ${runtimeDir}`)
if (process.platform === 'darwin') {
  const bootstrapResult = await bootstrapPortableDarwinPython({
    platformKey,
    runtimeRoot,
    targetRuntimeDir: runtimeDir,
    run
  })
  console.log(
    `[rekordbox-runtime] Installed standalone Darwin runtime from ${bootstrapResult.assetName}`
  )
} else {
  const launcher = resolvePythonLauncher()
  run(launcher.command, [...launcher.args, '-m', 'venv', runtimeDir])
}

const runtimePython = resolveRuntimePython()
run(runtimePython, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'])
run(runtimePython, ['-m', 'pip', 'install', '-r', requirementsPath])

if (!isRuntimeReady()) {
  console.error('[rekordbox-runtime] Runtime probe failed after install')
  process.exit(1)
}

console.log(`[rekordbox-runtime] Ready: ${runtimeDir}`)
