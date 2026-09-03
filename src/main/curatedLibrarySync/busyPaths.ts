import path from 'node:path'
import { isKeyAnalysisPathQueued } from '../services/keyAnalysisQueue'
import { isAbsPathInPlaybackForeground } from '../services/playbackForegroundActivity'
import type { HorizontalBrowseDeckKey } from '../../shared/horizontalBrowseTransport'

const horizontalBrowseLoadedPaths = new Map<HorizontalBrowseDeckKey, string>()

const normalizeAbs = (absPath: string): string => {
  const trimmed = String(absPath || '').trim()
  if (!trimmed) return ''
  const resolved = path.resolve(trimmed)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export const rememberHorizontalBrowseLoadedPath = (
  deck: HorizontalBrowseDeckKey,
  filePath: string | undefined
): void => {
  const normalized = String(filePath || '').trim()
  if (!normalized) {
    horizontalBrowseLoadedPaths.delete(deck)
    return
  }
  horizontalBrowseLoadedPaths.set(deck, normalized)
}

export const clearHorizontalBrowseLoadedPaths = (): void => {
  horizontalBrowseLoadedPaths.clear()
}

const isHorizontalBrowseBusyPath = (absPath: string): boolean => {
  const target = normalizeAbs(absPath)
  if (!target) return false
  for (const loaded of horizontalBrowseLoadedPaths.values()) {
    if (normalizeAbs(loaded) === target) return true
  }
  return false
}

export const isPathBusyForRemoteMutation = (absPath: string): boolean => {
  if (!absPath) return false
  if (isKeyAnalysisPathQueued(absPath)) return true
  if (isAbsPathInPlaybackForeground(absPath)) return true
  return isHorizontalBrowseBusyPath(absPath)
}
