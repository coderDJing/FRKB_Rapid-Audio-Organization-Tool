import path from 'node:path'
import fs = require('fs-extra')
import * as LibraryCacheDb from '../libraryCacheDb'
import { hasCurrentNoBpmBeatGridResult } from './beatGridAlgorithmVersion'
import { findSongListRoot } from './cacheMaintenance'

export type MixtapeNoBpmGuardInfo = {
  beatThisWindowCount?: unknown
  beatGridAlgorithmVersion?: unknown
  beatGridSource?: unknown
  beatGridStatus?: unknown
}

const readCachedNoBpmResult = async (filePath: string): Promise<boolean> => {
  const listRoot = await findSongListRoot(path.dirname(filePath))
  if (listRoot) {
    const cached = await LibraryCacheDb.loadSongCacheEntry(listRoot, filePath)
    return hasCurrentNoBpmBeatGridResult(cached?.info)
  }

  const externalContext = LibraryCacheDb.resolveExternalAnalysisContext(filePath)
  if (!externalContext) return false

  const stat = await fs.stat(filePath)
  const cached = await LibraryCacheDb.loadExternalAnalysisCacheEntry(externalContext, {
    size: stat.size,
    mtimeMs: stat.mtimeMs
  })
  return hasCurrentNoBpmBeatGridResult(cached?.info)
}

export const createMixtapeNoBpmGuard = () => {
  const cacheByFilePath = new Map<string, boolean>()

  const hasCachedNoBpmResult = async (filePath: string): Promise<boolean> => {
    if (cacheByFilePath.has(filePath)) {
      return cacheByFilePath.get(filePath) === true
    }

    let hasNoBpm = false
    try {
      hasNoBpm = await readCachedNoBpmResult(filePath)
    } catch {
      hasNoBpm = false
    }
    cacheByFilePath.set(filePath, hasNoBpm)
    return hasNoBpm
  }

  return {
    async shouldBlock(filePath: string, info: MixtapeNoBpmGuardInfo | null): Promise<boolean> {
      if (hasCurrentNoBpmBeatGridResult(info)) return true
      return await hasCachedNoBpmResult(filePath)
    }
  }
}
