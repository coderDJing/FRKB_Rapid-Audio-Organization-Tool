import { getLibraryDb } from '../libraryDb'
import { log } from '../log'
import {
  resolveAbsoluteListRoot,
  resolveFilePathInput,
  resolveListRootInput
} from './pathResolvers'

const TABLE = 'compact_visual_waveform_cache'

const resolveCacheKeys = (listRoot: string, filePath: string) => {
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return null
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
  if (!resolvedFile) return null
  const legacyListRoot =
    resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey
      ? resolvedRoot.legacyAbs
      : undefined
  return {
    listRootKey,
    fileKey: resolvedFile.key,
    fileKeyRaw: resolvedFile.keyRaw,
    legacyListRoot,
    legacyFilePath: resolvedFile.legacyAbs
  }
}

export async function removeCompactVisualWaveformCacheEntry(
  listRoot: string,
  filePath: string
): Promise<boolean> {
  const db = getLibraryDb()
  const keys = resolveCacheKeys(listRoot, filePath)
  if (!db || !keys) return false
  try {
    const del = db.prepare(`DELETE FROM ${TABLE} WHERE list_root = ? AND file_path = ?`)
    del.run(keys.listRootKey, keys.fileKey)
    if (keys.fileKeyRaw) {
      del.run(keys.listRootKey, keys.fileKeyRaw)
    }
    if (keys.legacyListRoot && keys.legacyFilePath) {
      del.run(keys.legacyListRoot, keys.legacyFilePath)
    }
    return true
  } catch (error) {
    log.error('[sqlite] compact visual waveform cache delete failed', error)
    return false
  }
}
