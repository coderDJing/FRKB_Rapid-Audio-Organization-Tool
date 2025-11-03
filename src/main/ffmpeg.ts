import { app } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import child_process = require('child_process')

export function resolveBundledFfmpegPath(): string {
  const isPackaged = app.isPackaged
  const platform = process.platform // 'win32' | 'darwin'
  const arch = process.arch // 'x64' | 'arm64'
  const base = isPackaged ? process.resourcesPath : path.resolve(__dirname, '../../vendor')
  const exe = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const ffmpegRoot = path.join(base, 'ffmpeg')

  if (platform === 'darwin') {
    const candidateOrder = [
      path.join(ffmpegRoot, 'darwin', exe),
      path.join(ffmpegRoot, 'darwin-universal', exe),
      path.join(ffmpegRoot, 'darwin-arm64', exe),
      path.join(ffmpegRoot, 'darwin-x64', exe)
    ]
    for (const candidate of candidateOrder) {
      if (fs.pathExistsSync(candidate)) {
        return candidate
      }
    }
  }

  const dir = platform === 'win32' ? 'win32-x64' : arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  return path.join(ffmpegRoot, dir, exe)
}

export async function ensureExecutableOnMac(targetPath: string) {
  if (process.platform !== 'darwin') return
  try {
    await fs.chmod(targetPath, 0o755)
  } catch {}
  try {
    // 尝试清除隔离属性；如果失败（例如权限限制），忽略，后续由 UI 指引
    child_process.spawnSync('xattr', ['-dr', 'com.apple.quarantine', targetPath])
  } catch {}
}
