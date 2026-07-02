import fs from 'node:fs/promises'
import path from 'node:path'
import * as LibraryCacheDb from '../../libraryCacheDb'

export const removeCoverCacheForMissingTrack = async (listRoot: string, filePath: string) => {
  try {
    const removed = await LibraryCacheDb.removeCoverIndexEntry(listRoot, filePath)
    if (removed === undefined || !removed) return
    const remaining = await LibraryCacheDb.countCoverIndexByHash(listRoot, removed.hash)
    if (remaining !== 0) return
    const listRootAbs = LibraryCacheDb.resolveCacheListRootAbs(listRoot) || listRoot
    const coverPath = path.join(
      listRootAbs,
      '.frkb_covers',
      `${removed.hash}${removed.ext || '.jpg'}`
    )
    try {
      await fs.rm(coverPath, { force: true })
    } catch {}
  } catch {}
}
