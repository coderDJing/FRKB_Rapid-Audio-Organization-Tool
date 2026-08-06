import fs from 'node:fs'
import { log } from '../log'
import { resetMixtapeStemSessionState } from '../mixtapeStemDb'
import { getLibraryStemCacheRootAbs } from './libraryStemAssetStorage'

export async function clearLibraryStemSessionCacheOnStartup(): Promise<void> {
  resetMixtapeStemSessionState()

  const cacheRoot = getLibraryStemCacheRootAbs()
  if (!cacheRoot) return
  try {
    await fs.promises.rm(cacheRoot, { recursive: true, force: true })
  } catch (error) {
    log.error('[library-stem] clear session cache on startup failed', { cacheRoot, error })
  }
}
