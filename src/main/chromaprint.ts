import { app } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import child_process = require('child_process')

const DIR_NAME = 'chromaprint'

export function resolveBundledFpcalcPath(): string {
  const override = process.env.FRKB_FPCALC_PATH
  if (override && fs.pathExistsSync(override)) {
    return override
  }
  const base = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '../../vendor')
  const exe = process.platform === 'win32' ? 'fpcalc.exe' : 'fpcalc'
  const root = path.join(base, DIR_NAME)
  if (process.platform === 'darwin') {
    const candidates = [
      path.join(root, 'darwin', exe),
      path.join(root, 'darwin-universal', exe),
      path.join(root, 'darwin-arm64', exe),
      path.join(root, 'darwin-x64', exe)
    ]
    for (const candidate of candidates) {
      if (fs.pathExistsSync(candidate)) return candidate
    }
    return candidates[0]
  }
  if (process.platform === 'linux') {
    const dir = process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
    return path.join(root, dir, exe)
  }
  return path.join(root, 'win32-x64', exe)
}

export async function ensureFpcalcExecutable(targetPath: string) {
  if (process.platform !== 'darwin') return
  try {
    await fs.chmod(targetPath, 0o755)
  } catch {}
  try {
    child_process.spawnSync('xattr', ['-dr', 'com.apple.quarantine', targetPath])
  } catch {}
}
