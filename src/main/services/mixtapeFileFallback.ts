import fs from 'node:fs/promises'
import { log } from '../log'
import { replaceMixtapeFilePath } from '../mixtapeDb'
import {
  resolveMissingMixtapeFilePath,
  type MixtapeMissingResolveSource
} from '../recycleBinService'

type MixtapeFallbackResult = {
  filePath: string
  recovered: boolean
  source?: MixtapeMissingResolveSource
}

const normalizePathForCompare = (value: string): string => {
  const normalized = String(value || '').trim()
  if (!normalized) return ''
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const pathExists = async (filePath: string): Promise<boolean> => {
  try {
    const stat = await fs.stat(filePath)
    return stat.isFile()
  } catch {
    return false
  }
}

export const resolveMixtapeFilePathWithFallback = async (
  filePath: string,
  context: 'waveform' | 'raw-waveform' | 'hires-waveform'
): Promise<MixtapeFallbackResult | null> => {
  const normalized = typeof filePath === 'string' ? filePath.trim() : ''
  if (!normalized) return null

  if (await pathExists(normalized)) {
    return {
      filePath: normalized,
      recovered: false
    }
  }

  const resolved = await resolveMissingMixtapeFilePath(normalized)
  if (!resolved || typeof resolved.resolvedPath !== 'string') return null
  const recoveredPath = resolved.resolvedPath.trim()
  if (!recoveredPath) return null
  if (!(await pathExists(recoveredPath))) return null

  const replaceResult = replaceMixtapeFilePath(normalized, recoveredPath)
  if (replaceResult.updated > 0) {
    log.info('[mixtape] file path recovered via fallback', {
      context,
      fromPath: normalized,
      toPath: recoveredPath,
      source: resolved.source,
      updated: replaceResult.updated
    })
  }

  if (normalizePathForCompare(normalized) === normalizePathForCompare(recoveredPath)) {
    return {
      filePath: recoveredPath,
      recovered: false
    }
  }

  return {
    filePath: recoveredPath,
    recovered: true,
    source: resolved.source
  }
}
