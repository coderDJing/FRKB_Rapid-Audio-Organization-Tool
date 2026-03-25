import { app } from 'electron'
import fs from 'node:fs'
import path = require('path')

const DEMUCS_DEV_ROOT_ENV = 'FRKB_DEMUCS_ROOT'

export const resolveDemucsPlatformDir = () => {
  if (process.platform === 'win32') return 'win32-x64'
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
}

const resolveDefaultBundledDemucsRootPath = (): string => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'demucs')
  }
  return path.resolve(__dirname, '../../vendor/demucs')
}

const resolveDevDemucsRootOverridePath = (): string => {
  if (app.isPackaged) return ''
  const configuredRoot = String(process.env[DEMUCS_DEV_ROOT_ENV] || '').trim()
  if (!configuredRoot) return ''
  return path.isAbsolute(configuredRoot)
    ? path.normalize(configuredRoot)
    : path.resolve(process.cwd(), configuredRoot)
}

const resolveBundledDemucsRootCandidates = (): string[] => {
  const candidates: string[] = []
  const seen = new Set<string>()

  const addCandidate = (candidatePath: string) => {
    const normalizedPath = String(candidatePath || '').trim()
    if (!normalizedPath || seen.has(normalizedPath)) return
    seen.add(normalizedPath)
    candidates.push(normalizedPath)
  }

  addCandidate(resolveDevDemucsRootOverridePath())
  addCandidate(resolveDefaultBundledDemucsRootPath())
  return candidates
}

const resolveExistingBundledDemucsSubPath = (segments: string[]): string => {
  const candidates = resolveBundledDemucsRootCandidates().map((rootPath) =>
    path.join(rootPath, ...segments)
  )
  for (const candidatePath of candidates) {
    if (fs.existsSync(candidatePath)) return candidatePath
  }
  return candidates[0] || path.join(resolveDefaultBundledDemucsRootPath(), ...segments)
}

export function resolveBundledDemucsRootPath(): string {
  return resolveBundledDemucsRootCandidates()[0] || resolveDefaultBundledDemucsRootPath()
}

export function resolveInstalledDemucsRootPath(): string {
  return path.join(app.getPath('userData'), 'demucs-runtimes')
}

export function resolveInstalledDemucsPlatformRootPath(): string {
  return path.join(resolveInstalledDemucsRootPath(), resolveDemucsPlatformDir())
}

export function resolveBundledDemucsRuntimeDir(): string {
  return path.join(resolveBundledDemucsRootPath(), resolveDemucsPlatformDir(), 'runtime')
}

export function resolveBundledDemucsBootstrapDirPath(): string {
  return resolveExistingBundledDemucsSubPath(['bootstrap'])
}

export function resolveBundledDemucsPythonPath(runtimeDir?: string): string {
  const resolvedRuntimeDir = runtimeDir || resolveBundledDemucsRuntimeDir()
  if (process.platform === 'win32') {
    const rootPython = path.join(resolvedRuntimeDir, 'python.exe')
    if (fs.existsSync(rootPython)) return rootPython
    const scriptsPython = path.join(resolvedRuntimeDir, 'Scripts', 'python.exe')
    if (fs.existsSync(scriptsPython)) return scriptsPython
    return rootPython
  }
  const binPython3 = path.join(resolvedRuntimeDir, 'bin', 'python3')
  if (fs.existsSync(binPython3)) return binPython3
  const binPython = path.join(resolvedRuntimeDir, 'bin', 'python')
  if (fs.existsSync(binPython)) return binPython
  return binPython3
}

export function resolveBundledDemucsModelsPath(): string {
  return resolveExistingBundledDemucsSubPath(['models'])
}

export type BundledDemucsRuntimeCandidate = {
  key: string
  runtimeDir: string
  pythonPath: string
}

const resolveRuntimeDirNameCandidates = (): string[] => {
  if (process.platform === 'win32') {
    return ['runtime-cuda', 'runtime-xpu', 'runtime-directml', 'runtime-cpu', 'runtime']
  }
  if (process.platform === 'darwin') {
    return ['runtime-mps', 'runtime-cpu', 'runtime']
  }
  return ['runtime-cuda', 'runtime-rocm', 'runtime-cpu', 'runtime']
}

const resolveRuntimeCandidatesFromPlatformRoot = (
  platformRoot: string
): BundledDemucsRuntimeCandidate[] => {
  const candidates: BundledDemucsRuntimeCandidate[] = []
  const seen = new Set<string>()
  for (const key of resolveRuntimeDirNameCandidates()) {
    const runtimeDir = path.join(platformRoot, key)
    const pythonPath = resolveBundledDemucsPythonPath(runtimeDir)
    if (seen.has(runtimeDir)) continue
    seen.add(runtimeDir)
    if (!fs.existsSync(runtimeDir)) continue
    if (!fs.existsSync(pythonPath)) continue
    candidates.push({
      key,
      runtimeDir,
      pythonPath
    })
  }
  return candidates
}

export function resolveBundledDemucsRuntimeCandidates(): BundledDemucsRuntimeCandidate[] {
  const candidates: BundledDemucsRuntimeCandidate[] = []
  const seen = new Set<string>()
  const platformRoots: string[] = []
  const customRoot = resolveDevDemucsRootOverridePath()
  if (customRoot) {
    platformRoots.push(path.join(customRoot, resolveDemucsPlatformDir()))
  } else {
    platformRoots.push(resolveInstalledDemucsPlatformRootPath())
    platformRoots.push(path.join(resolveDefaultBundledDemucsRootPath(), resolveDemucsPlatformDir()))
  }
  for (const platformRoot of platformRoots) {
    for (const candidate of resolveRuntimeCandidatesFromPlatformRoot(platformRoot)) {
      if (seen.has(candidate.runtimeDir)) continue
      seen.add(candidate.runtimeDir)
      candidates.push(candidate)
    }
  }
  if (candidates.length > 0) return candidates
  const runtimeDir = resolveBundledDemucsRuntimeDir()
  const pythonPath = resolveBundledDemucsPythonPath(runtimeDir)
  return [
    {
      key: 'runtime',
      runtimeDir,
      pythonPath
    }
  ]
}
