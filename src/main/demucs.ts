import { app } from 'electron'
import fs from 'node:fs'
import path = require('path')

const resolveDemucsPlatformDir = () => {
  if (process.platform === 'win32') return 'win32-x64'
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
}

export function resolveBundledDemucsRootPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'demucs')
  }
  return path.resolve(__dirname, '../../vendor/demucs')
}

export function resolveBundledDemucsRuntimeDir(): string {
  return path.join(resolveBundledDemucsRootPath(), resolveDemucsPlatformDir(), 'runtime')
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
  return path.join(resolveBundledDemucsRootPath(), 'models')
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

export function resolveBundledDemucsRuntimeCandidates(): BundledDemucsRuntimeCandidate[] {
  const platformRoot = path.join(resolveBundledDemucsRootPath(), resolveDemucsPlatformDir())
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
