import fs from 'node:fs/promises'
import * as LibraryCacheDb from '../libraryCacheDb'
import { normalizeAddedAtMs } from '../../shared/songAddedAt'
import { applyLiteDefaults, buildLiteSongInfo } from './songInfoLite'

export async function stampPlaylistSongsAddedAt(params: {
  listRoot: string | null | undefined
  filePaths: string[]
  addedAtMs?: number
}): Promise<void> {
  const listRoot = String(params.listRoot || '').trim()
  const addedAtMs = normalizeAddedAtMs(params.addedAtMs) ?? Date.now()
  const uniquePaths = Array.from(
    new Set(params.filePaths.map((item) => String(item || '').trim()).filter(Boolean))
  )
  if (!listRoot || uniquePaths.length === 0) return

  for (const filePath of uniquePaths) {
    try {
      const stat = await fs.stat(filePath)
      const existing = await LibraryCacheDb.loadSongCacheEntry(listRoot, filePath)
      const nextInfo = existing?.info
        ? applyLiteDefaults({ ...existing.info }, filePath)
        : buildLiteSongInfo(filePath)
      nextInfo.filePath = filePath
      nextInfo.addedAtMs = addedAtMs
      await LibraryCacheDb.upsertSongCacheEntry(listRoot, filePath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        info: nextInfo
      })
    } catch {
      // 单文件盖章失败不阻断搬家 / 导入
    }
  }
}
