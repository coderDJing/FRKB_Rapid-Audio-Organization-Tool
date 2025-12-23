import fs = require('fs-extra')
import path = require('path')
import {
  calculateAudioHashesWithProgress,
  deleteSelectionPathIndexEntries,
  gcSelectionPathIndex,
  getSelectionPathIndexEntries,
  touchSelectionPathIndexEntries,
  upsertSelectionPathIndexEntries
} from 'rust_package'

export type SelectionSongIdResolveItem = {
  filePath: string
  songId: string
  fileHash: string
}

export type SelectionSongIdResolveReportItem =
  | { filePath: string; ok: true; songId: string; fileHash: string }
  | { filePath: string; ok: false; error: string }

type CacheEntry = {
  songId: string
  fileHash: string
  size: number
  mtimeMs: number
}

const cache = new Map<string, CacheEntry>()

const normalizeKey = (p: string) => path.normalize(p).replace(/\//g, '\\').toLowerCase()

export async function resolveSelectionSongIds(
  inputFilePaths: string[],
  options?: {
    dbDir?: string
  }
): Promise<{
  items: SelectionSongIdResolveItem[]
  report: SelectionSongIdResolveReportItem[]
}> {
  const raw = Array.isArray(inputFilePaths) ? inputFilePaths : []
  const unique = Array.from(
    new Set(
      raw
        .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        .map((p) => path.normalize(p))
    )
  )

  const statsMap = new Map<string, { size: number; mtimeMs: number }>()
  const pending: string[] = []
  const report: SelectionSongIdResolveReportItem[] = []
  const resolved: SelectionSongIdResolveItem[] = []
  const pendingKeyByPath = new Map<string, string>()
  const missingPaths: string[] = []

  for (const filePath of unique) {
    try {
      const st = await fs.stat(filePath)
      if (!st.isFile()) {
        report.push({ filePath, ok: false, error: 'NOT_FILE' })
        missingPaths.push(filePath)
        continue
      }
      const size = Number(st.size || 0)
      const mtimeMs = Number(st.mtimeMs || 0)
      statsMap.set(filePath, { size, mtimeMs })

      const key = normalizeKey(filePath)
      const cached = cache.get(key)
      if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
        resolved.push({ filePath, songId: cached.songId, fileHash: cached.fileHash })
        report.push({ filePath, ok: true, songId: cached.songId, fileHash: cached.fileHash })
      } else {
        pending.push(filePath)
        pendingKeyByPath.set(filePath, key)
      }
    } catch (error: any) {
      report.push({ filePath, ok: false, error: String(error?.message || error) })
      if (String(error?.code || '').toUpperCase() === 'ENOENT') {
        missingPaths.push(filePath)
      }
    }
  }

  // 持久化缓存：filePath + size/mtime => songId（PCM SHA256）
  const dbDir =
    typeof options?.dbDir === 'string' && options.dbDir.trim() ? options.dbDir.trim() : ''
  if (dbDir && missingPaths.length > 0) {
    try {
      deleteSelectionPathIndexEntries(
        dbDir,
        Array.from(new Set(missingPaths.map((p) => normalizeKey(p)).filter(Boolean)))
      )
    } catch {}
  }
  if (dbDir && pending.length > 0) {
    try {
      const keys = Array.from(
        new Set(pending.map((p) => pendingKeyByPath.get(p)).filter(Boolean))
      ) as string[]
      if (keys.length > 0) {
        const entries: any[] = getSelectionPathIndexEntries(dbDir, keys) as any
        const byKey = new Map<string, any>()
        for (const it of entries || []) {
          const k = typeof (it as any)?.pathKey === 'string' ? String((it as any).pathKey) : ''
          if (!k) continue
          byKey.set(k, it)
        }

        const stillPending: string[] = []
        const touchedKeys: string[] = []

        for (const filePath of pending) {
          const key = pendingKeyByPath.get(filePath)
          if (!key) {
            stillPending.push(filePath)
            continue
          }
          const entry = byKey.get(key)
          if (!entry) {
            stillPending.push(filePath)
            continue
          }

          const st = statsMap.get(filePath)
          if (!st) {
            stillPending.push(filePath)
            continue
          }

          const size = Number(entry?.size || 0)
          const mtimeMs = Number(entry?.mtimeMs || 0)
          const songId = typeof entry?.songId === 'string' ? entry.songId : ''
          const fileHash = typeof entry?.fileHash === 'string' ? entry.fileHash : songId

          if (!songId || size !== st.size || mtimeMs !== st.mtimeMs) {
            stillPending.push(filePath)
            continue
          }

          resolved.push({ filePath, songId, fileHash })
          report.push({ filePath, ok: true, songId, fileHash })
          cache.set(key, { songId, fileHash, size: st.size, mtimeMs: st.mtimeMs })
          touchedKeys.push(key)
        }

        // 更新 lastSeenAt（用于 GC）
        if (touchedKeys.length > 0) {
          try {
            touchSelectionPathIndexEntries(dbDir, touchedKeys)
          } catch {}
        }

        pending.length = 0
        pending.push(...stillPending)
      }
    } catch {
      // 持久化缓存不可用时静默降级为“重新计算 songId”
    }
  }

  if (pending.length > 0) {
    const results = await calculateAudioHashesWithProgress(pending)
    const byPath = new Map<string, { sha: string; error?: string }>()
    for (const r of results) {
      const fp = typeof (r as any)?.filePath === 'string' ? (r as any).filePath : ''
      const sha = typeof (r as any)?.sha256Hash === 'string' ? (r as any).sha256Hash : 'error'
      const err = (r as any)?.error
      if (fp) byPath.set(path.normalize(fp), { sha, error: err })
    }

    const computedUpserts: Array<{
      pathKey: string
      filePath: string
      size: number
      mtimeMs: number
      songId: string
      fileHash: string
    }> = []

    for (const filePath of pending) {
      const hit = byPath.get(path.normalize(filePath))
      if (!hit || !hit.sha || hit.sha === 'error') {
        report.push({
          filePath,
          ok: false,
          error: String(hit?.error || 'HASH_FAILED')
        })
        continue
      }
      const songId = hit.sha
      const fileHash = songId
      resolved.push({ filePath, songId, fileHash })
      report.push({ filePath, ok: true, songId, fileHash })
      const st = statsMap.get(filePath)
      if (st) {
        const key = normalizeKey(filePath)
        cache.set(key, {
          songId,
          fileHash,
          size: st.size,
          mtimeMs: st.mtimeMs
        })
        if (dbDir) {
          computedUpserts.push({
            pathKey: key,
            filePath,
            size: st.size,
            mtimeMs: st.mtimeMs,
            songId,
            fileHash
          })
        }
      }
    }

    // 将本次新计算的映射落盘，避免下次重启/换歌单再次解码算哈希
    if (dbDir) {
      try {
        if (computedUpserts.length > 0) {
          upsertSelectionPathIndexEntries(dbDir, computedUpserts as any)
          // GC：带防抖（由 db 内 lastGcAt 控制），避免索引无限增长
          try {
            gcSelectionPathIndex(dbDir, {
              ttlDays: 30,
              maxRows: 200_000,
              deleteLimit: 5_000,
              minIntervalMs: 24 * 60 * 60 * 1000
            } as any)
          } catch {}
        }
      } catch {}
    }
  }

  return { items: resolved, report }
}

export async function migrateSelectionSongIdCacheByMoves(
  moves: Array<{ fromPath: string; toPath: string }>,
  options?: { dbDir?: string }
): Promise<{ migrated: number; deletedOld: number }> {
  const dbDir =
    typeof options?.dbDir === 'string' && options.dbDir.trim() ? options.dbDir.trim() : ''
  if (!dbDir || !Array.isArray(moves) || moves.length === 0) return { migrated: 0, deletedOld: 0 }

  const pairs = moves
    .map((m) => ({
      fromPath: typeof m?.fromPath === 'string' ? m.fromPath : '',
      toPath: typeof m?.toPath === 'string' ? m.toPath : ''
    }))
    .filter((m) => m.fromPath && m.toPath)

  if (pairs.length === 0) return { migrated: 0, deletedOld: 0 }

  const fromKeyByPath = new Map<string, string>()
  const toKeyByPath = new Map<string, string>()
  const fromKeys: string[] = []
  for (const p of pairs) {
    const fromKey = normalizeKey(p.fromPath)
    const toKey = normalizeKey(p.toPath)
    fromKeyByPath.set(p.fromPath, fromKey)
    toKeyByPath.set(p.toPath, toKey)
    fromKeys.push(fromKey)
  }

  // 先从持久化索引里拿旧路径的 songId，避免重新解码算哈希
  let entryByFromKey = new Map<string, any>()
  try {
    const entries: any[] = getSelectionPathIndexEntries(dbDir, Array.from(new Set(fromKeys))) as any
    for (const it of entries || []) {
      const k = typeof (it as any)?.pathKey === 'string' ? String((it as any).pathKey) : ''
      if (!k) continue
      entryByFromKey.set(k, it)
    }
  } catch {
    entryByFromKey = new Map()
  }

  const upserts: any[] = []
  const deleteKeys: string[] = []

  for (const p of pairs) {
    const fromKey = fromKeyByPath.get(p.fromPath) || ''
    const toKey = toKeyByPath.get(p.toPath) || ''
    if (!fromKey || !toKey) continue

    const fromEntry = entryByFromKey.get(fromKey)
    const fromCached = cache.get(fromKey)

    const songId =
      typeof fromEntry?.songId === 'string'
        ? fromEntry.songId
        : typeof fromCached?.songId === 'string'
          ? fromCached.songId
          : ''
    const fileHash =
      typeof fromEntry?.fileHash === 'string'
        ? fromEntry.fileHash
        : typeof fromCached?.fileHash === 'string'
          ? fromCached.fileHash
          : songId

    if (!songId) continue

    let st: { size: number; mtimeMs: number } | null = null
    try {
      const s = await fs.stat(p.toPath)
      if (s.isFile()) {
        st = { size: Number(s.size || 0), mtimeMs: Number(s.mtimeMs || 0) }
      }
    } catch {}
    if (!st) continue

    upserts.push({
      pathKey: toKey,
      filePath: p.toPath,
      size: st.size,
      mtimeMs: st.mtimeMs,
      songId,
      fileHash
    })
    deleteKeys.push(fromKey)

    // 同步更新进程内缓存
    cache.set(toKey, { songId, fileHash, size: st.size, mtimeMs: st.mtimeMs })
    cache.delete(fromKey)
  }

  if (upserts.length === 0) return { migrated: 0, deletedOld: 0 }

  let migrated = 0
  let deletedOld = 0
  try {
    migrated = Number(upsertSelectionPathIndexEntries(dbDir, upserts as any) || 0)
  } catch {}
  try {
    deletedOld = Number(
      deleteSelectionPathIndexEntries(dbDir, Array.from(new Set(deleteKeys))) || 0
    )
  } catch {}

  return { migrated, deletedOld }
}
