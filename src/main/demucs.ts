import { app } from 'electron'
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

export function resolveBundledDemucsPythonPath(): string {
  const runtimeDir = resolveBundledDemucsRuntimeDir()
  if (process.platform === 'win32') {
    return path.join(runtimeDir, 'python.exe')
  }
  return path.join(runtimeDir, 'bin', 'python3')
}

export function resolveBundledDemucsModelsPath(): string {
  return path.join(resolveBundledDemucsRootPath(), 'models')
}
