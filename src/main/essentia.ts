import { app } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import os = require('os')
import { ensureExecutableOnMac } from './ffmpeg'

const DIR_NAME = 'essentia'
const TEMP_PREFIX = 'frkb_essentia_'
const TEMP_SUFFIX = '.json'
const DEFAULT_TEMP_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_TEMP_MAX_DELETE = 200

export function resolveBundledEssentiaPath(): string {
  const override = process.env.FRKB_ESSENTIA_PATH
  if (override && fs.pathExistsSync(override)) {
    return override
  }
  const base = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '../../vendor')
  const exe =
    process.platform === 'win32'
      ? 'essentia_streaming_extractor_music.exe'
      : 'essentia_streaming_extractor_music'
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

export async function ensureEssentiaExecutable(targetPath: string) {
  await ensureExecutableOnMac(targetPath)
}

export async function cleanupEssentiaTempFiles(options?: {
  maxAgeMs?: number
  maxDelete?: number
}): Promise<{ scanned: number; deleted: number }> {
  const maxAgeMs =
    typeof options?.maxAgeMs === 'number' && options.maxAgeMs > 0
      ? options.maxAgeMs
      : DEFAULT_TEMP_TTL_MS
  const maxDelete =
    typeof options?.maxDelete === 'number' && options.maxDelete > 0
      ? Math.floor(options.maxDelete)
      : DEFAULT_TEMP_MAX_DELETE
  let entries: string[] = []
  try {
    entries = await fs.readdir(os.tmpdir())
  } catch {
    return { scanned: 0, deleted: 0 }
  }

  const now = Date.now()
  let scanned = 0
  let deleted = 0

  for (const name of entries) {
    if (!name.startsWith(TEMP_PREFIX) || !name.endsWith(TEMP_SUFFIX)) continue
    scanned += 1
    if (deleted >= maxDelete) break
    const fullPath = path.join(os.tmpdir(), name)
    let stat: fs.Stats
    try {
      stat = await fs.stat(fullPath)
    } catch {
      continue
    }
    if (now - stat.mtimeMs <= maxAgeMs) continue
    try {
      await fs.remove(fullPath)
      deleted += 1
    } catch {}
  }

  return { scanned, deleted }
}
