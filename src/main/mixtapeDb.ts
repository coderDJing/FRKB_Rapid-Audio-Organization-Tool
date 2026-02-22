import { v4 as uuidV4 } from 'uuid'
import { getLibraryDb } from './libraryDb'
import { log } from './log'

const TABLE = 'mixtape_items'

export type MixtapeItemRecord = {
  id: string
  playlistUuid: string
  filePath: string
  mixOrder: number
  originPlaylistUuid?: string | null
  originPathSnapshot?: string | null
  infoJson?: string | null
  createdAtMs: number
}

export type MixtapeAppendItem = {
  filePath: string
  originPlaylistUuid?: string | null
  originPathSnapshot?: string | null
  info?: Record<string, any> | null
}

export type MixtapeFilePathUpdate = {
  id: string
  filePath: string
}

function normalizeUniqueStrings(values: unknown[]): string[] {
  if (!Array.isArray(values)) return []
  return Array.from(
    new Set(
      values
        .filter((value) => typeof value === 'string')
        .map((value) => String(value).trim())
        .filter(Boolean)
    )
  )
}

function toRecord(row: any): MixtapeItemRecord | null {
  if (!row || !row.id || !row.playlist_uuid || !row.file_path) return null
  return {
    id: String(row.id),
    playlistUuid: String(row.playlist_uuid),
    filePath: String(row.file_path),
    mixOrder: Number(row.mix_order) || 0,
    originPlaylistUuid: row.origin_playlist_uuid ? String(row.origin_playlist_uuid) : null,
    originPathSnapshot: row.origin_path_snapshot ? String(row.origin_path_snapshot) : null,
    infoJson: row.info_json ? String(row.info_json) : null,
    createdAtMs: Number(row.created_at_ms) || 0
  }
}

function resolveFilePathWhereClause(): string {
  return process.platform === 'win32' ? 'LOWER(file_path) = LOWER(?)' : 'file_path = ?'
}

function normalizeMixtapeOrder(db: any, playlistUuid: string) {
  const rows = db
    .prepare(
      `SELECT id FROM ${TABLE} WHERE playlist_uuid = ? ORDER BY mix_order ASC, created_at_ms ASC, id ASC`
    )
    .all(playlistUuid)
  if (!rows || rows.length === 0) return
  const update = db.prepare(`UPDATE ${TABLE} SET mix_order = ? WHERE id = ?`)
  const tx = db.transaction(() => {
    rows.forEach((row: any, idx: number) => {
      update.run(idx + 1, row.id)
    })
  })
  tx()
}

export function listMixtapeItems(playlistUuid: string): MixtapeItemRecord[] {
  if (!playlistUuid) return []
  const db = getLibraryDb()
  if (!db) return []
  try {
    const rows = db
      .prepare(
        `SELECT id, playlist_uuid, file_path, mix_order, origin_playlist_uuid, origin_path_snapshot, info_json, created_at_ms
         FROM ${TABLE}
         WHERE playlist_uuid = ?
         ORDER BY mix_order ASC, created_at_ms ASC, id ASC`
      )
      .all(playlistUuid)
    return rows.map(toRecord).filter(Boolean) as MixtapeItemRecord[]
  } catch (error) {
    log.error('[sqlite] mixtape list failed', error)
    return []
  }
}

export function appendMixtapeItems(
  playlistUuid: string,
  items: MixtapeAppendItem[]
): { inserted: number } {
  const normalizedItems = Array.isArray(items)
    ? items.filter((item) => item && typeof item.filePath === 'string' && item.filePath.length > 0)
    : []
  if (!playlistUuid || normalizedItems.length === 0) return { inserted: 0 }
  const db = getLibraryDb()
  if (!db) return { inserted: 0 }
  try {
    const maxRow = db
      .prepare(`SELECT MAX(mix_order) AS max_order FROM ${TABLE} WHERE playlist_uuid = ?`)
      .get(playlistUuid)
    let currentOrder = Number(maxRow?.max_order || 0)
    const insert = db.prepare(
      `INSERT INTO ${TABLE} (id, playlist_uuid, file_path, mix_order, origin_playlist_uuid, origin_path_snapshot, info_json, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const now = Date.now()
    const tx = db.transaction(() => {
      for (const item of normalizedItems) {
        currentOrder += 1
        const infoJson = item.info ? JSON.stringify(item.info) : null
        insert.run(
          uuidV4(),
          playlistUuid,
          item.filePath,
          currentOrder,
          item.originPlaylistUuid || null,
          item.originPathSnapshot || null,
          infoJson,
          now
        )
      }
    })
    tx()
    return { inserted: normalizedItems.length }
  } catch (error) {
    log.error('[sqlite] mixtape append failed', error)
    return { inserted: 0 }
  }
}

export function removeMixtapeItemsByFilePath(
  playlistUuid: string,
  filePaths: string[]
): { removed: number } {
  const normalizedPaths = normalizeUniqueStrings(filePaths)
  if (!playlistUuid || normalizedPaths.length === 0) return { removed: 0 }
  const db = getLibraryDb()
  if (!db) return { removed: 0 }
  try {
    const del = db.prepare(`DELETE FROM ${TABLE} WHERE playlist_uuid = ? AND file_path = ?`)
    let removed = 0
    const tx = db.transaction(() => {
      for (const filePath of normalizedPaths) {
        const info = del.run(playlistUuid, filePath)
        removed += Number(info?.changes || 0)
      }
    })
    tx()
    normalizeMixtapeOrder(db, playlistUuid)
    return { removed }
  } catch (error) {
    log.error('[sqlite] mixtape remove failed', error)
    return { removed: 0 }
  }
}

export function removeMixtapeItemsById(
  playlistUuid: string,
  itemIds: string[]
): { removed: number } {
  const normalizedIds = normalizeUniqueStrings(itemIds)
  if (!playlistUuid || normalizedIds.length === 0) return { removed: 0 }
  const db = getLibraryDb()
  if (!db) return { removed: 0 }
  try {
    const del = db.prepare(`DELETE FROM ${TABLE} WHERE playlist_uuid = ? AND id = ?`)
    let removed = 0
    const tx = db.transaction(() => {
      for (const id of normalizedIds) {
        const info = del.run(playlistUuid, id)
        removed += Number(info?.changes || 0)
      }
    })
    tx()
    normalizeMixtapeOrder(db, playlistUuid)
    return { removed }
  } catch (error) {
    log.error('[sqlite] mixtape remove by id failed', error)
    return { removed: 0 }
  }
}

export function reorderMixtapeItems(
  playlistUuid: string,
  orderedIds: string[]
): { updated: number } {
  const normalizedIds = Array.isArray(orderedIds)
    ? orderedIds
        .filter((id) => typeof id === 'string')
        .map((id) => String(id).trim())
        .filter(Boolean)
    : []
  if (!playlistUuid || normalizedIds.length === 0) return { updated: 0 }
  const db = getLibraryDb()
  if (!db) return { updated: 0 }
  try {
    const rows = db
      .prepare(
        `SELECT id FROM ${TABLE} WHERE playlist_uuid = ? ORDER BY mix_order ASC, created_at_ms ASC, id ASC`
      )
      .all(playlistUuid)
    const existingIds: string[] = rows.map((row: { id: string | number }) => String(row.id))
    const orderedSet = new Set(normalizedIds)
    const finalIds = [
      ...normalizedIds.filter((id) => existingIds.includes(id)),
      ...existingIds.filter((id) => !orderedSet.has(id))
    ]
    const update = db.prepare(`UPDATE ${TABLE} SET mix_order = ? WHERE id = ?`)
    const tx = db.transaction(() => {
      finalIds.forEach((id, idx) => {
        update.run(idx + 1, id)
      })
    })
    tx()
    return { updated: finalIds.length }
  } catch (error) {
    log.error('[sqlite] mixtape reorder failed', error)
    return { updated: 0 }
  }
}

export function listMixtapeFilePathsByPlaylist(playlistUuid: string): string[] {
  if (!playlistUuid) return []
  const db = getLibraryDb()
  if (!db) return []
  try {
    const rows = db
      .prepare(`SELECT file_path FROM ${TABLE} WHERE playlist_uuid = ?`)
      .all(playlistUuid)
    return normalizeUniqueStrings(rows.map((row: { file_path: string }) => row.file_path))
  } catch (error) {
    log.error('[sqlite] mixtape list file paths failed', error)
    return []
  }
}

export function listMixtapeFilePathsByItemIds(playlistUuid: string, itemIds: string[]): string[] {
  const normalizedIds = normalizeUniqueStrings(itemIds)
  if (!playlistUuid || normalizedIds.length === 0) return []
  const db = getLibraryDb()
  if (!db) return []
  try {
    const placeholders = normalizedIds.map(() => '?').join(',')
    const rows = db
      .prepare(`SELECT file_path FROM ${TABLE} WHERE playlist_uuid = ? AND id IN (${placeholders})`)
      .all(playlistUuid, ...normalizedIds)
    return normalizeUniqueStrings(rows.map((row: { file_path: string }) => row.file_path))
  } catch (error) {
    log.error('[sqlite] mixtape list file paths by id failed', error)
    return []
  }
}

export function listMixtapeFilePathsInUse(filePaths: string[]): string[] {
  const normalizedPaths = normalizeUniqueStrings(filePaths)
  if (normalizedPaths.length === 0) return []
  const db = getLibraryDb()
  if (!db) return []
  try {
    const placeholders = normalizedPaths.map(() => '?').join(',')
    const rows = db
      .prepare(`SELECT DISTINCT file_path FROM ${TABLE} WHERE file_path IN (${placeholders})`)
      .all(...normalizedPaths)
    return normalizeUniqueStrings(rows.map((row: { file_path: string }) => row.file_path))
  } catch (error) {
    log.error('[sqlite] mixtape list file paths in use failed', error)
    return []
  }
}

export function listMixtapeItemsByFilePath(filePath: string): MixtapeItemRecord[] {
  const normalizedPath = typeof filePath === 'string' ? filePath.trim() : ''
  if (!normalizedPath) return []
  const db = getLibraryDb()
  if (!db) return []
  try {
    const whereClause = resolveFilePathWhereClause()
    const rows = db
      .prepare(
        `SELECT id, playlist_uuid, file_path, mix_order, origin_playlist_uuid, origin_path_snapshot, info_json, created_at_ms
         FROM ${TABLE}
         WHERE ${whereClause}
         ORDER BY mix_order ASC, created_at_ms ASC, id ASC`
      )
      .all(normalizedPath)
    return rows.map(toRecord).filter(Boolean) as MixtapeItemRecord[]
  } catch (error) {
    log.error('[sqlite] mixtape list by file path failed', error)
    return []
  }
}

export function replaceMixtapeFilePath(
  oldFilePath: string,
  newFilePath: string
): { updated: number; playlistUuids: string[]; itemIds: string[] } {
  const sourcePath = typeof oldFilePath === 'string' ? oldFilePath.trim() : ''
  const targetPath = typeof newFilePath === 'string' ? newFilePath.trim() : ''
  if (!sourcePath || !targetPath || sourcePath === targetPath) {
    return { updated: 0, playlistUuids: [], itemIds: [] }
  }
  const db = getLibraryDb()
  if (!db) return { updated: 0, playlistUuids: [], itemIds: [] }
  try {
    const whereClause = resolveFilePathWhereClause()
    const rows = db
      .prepare(`SELECT id, playlist_uuid FROM ${TABLE} WHERE ${whereClause}`)
      .all(sourcePath) as Array<{ id: string; playlist_uuid: string }>
    if (!rows.length) {
      return { updated: 0, playlistUuids: [], itemIds: [] }
    }
    const update = db.prepare(`UPDATE ${TABLE} SET file_path = ? WHERE id = ?`)
    const tx = db.transaction(() => {
      for (const row of rows) {
        update.run(targetPath, row.id)
      }
    })
    tx()
    return {
      updated: rows.length,
      playlistUuids: Array.from(new Set(rows.map((row) => String(row.playlist_uuid)))),
      itemIds: rows.map((row) => String(row.id))
    }
  } catch (error) {
    log.error('[sqlite] mixtape file path replace failed', error)
    return { updated: 0, playlistUuids: [], itemIds: [] }
  }
}

export function updateMixtapeItemFilePathsById(entries: MixtapeFilePathUpdate[]): {
  updated: number
  playlistUuids: string[]
} {
  const normalizedEntries = Array.isArray(entries)
    ? entries
        .filter((item) => item && typeof item.id === 'string' && typeof item.filePath === 'string')
        .map((item) => ({
          id: String(item.id).trim(),
          filePath: String(item.filePath).trim()
        }))
        .filter((item) => item.id && item.filePath)
    : []
  if (!normalizedEntries.length) return { updated: 0, playlistUuids: [] }
  const db = getLibraryDb()
  if (!db) return { updated: 0, playlistUuids: [] }
  try {
    const rows = db
      .prepare(
        `SELECT id, playlist_uuid FROM ${TABLE} WHERE id IN (${normalizedEntries.map(() => '?').join(',')})`
      )
      .all(...normalizedEntries.map((item) => item.id)) as Array<{
      id: string
      playlist_uuid: string
    }>
    if (!rows.length) return { updated: 0, playlistUuids: [] }
    const existingIds = new Set(rows.map((row) => String(row.id)))
    const playlistUuids = Array.from(new Set(rows.map((row) => String(row.playlist_uuid))))
    const update = db.prepare(`UPDATE ${TABLE} SET file_path = ? WHERE id = ?`)
    let updated = 0
    const tx = db.transaction(() => {
      for (const item of normalizedEntries) {
        if (!existingIds.has(item.id)) continue
        const info = update.run(item.filePath, item.id)
        updated += Number(info?.changes || 0)
      }
    })
    tx()
    return { updated, playlistUuids }
  } catch (error) {
    log.error('[sqlite] mixtape update file paths by id failed', error)
    return { updated: 0, playlistUuids: [] }
  }
}

export function upsertMixtapeItemBpmByFilePath(
  entries: Array<{ filePath: string; bpm: number; firstBeatMs?: number }>
): { updated: number } {
  if (!Array.isArray(entries) || entries.length === 0) return { updated: 0 }
  const db = getLibraryDb()
  if (!db) return { updated: 0 }

  const analysisMap = new Map<string, { bpm: number; firstBeatMs: number }>()
  for (const item of entries) {
    const filePath = typeof item?.filePath === 'string' ? item.filePath.trim() : ''
    const bpm = Number(item?.bpm)
    if (!filePath || !Number.isFinite(bpm) || bpm <= 0) continue
    const firstBeatMs = Number(item?.firstBeatMs)
    const normalizedFirstBeatMs =
      Number.isFinite(firstBeatMs) && firstBeatMs >= 0 ? Number(firstBeatMs.toFixed(3)) : 0
    analysisMap.set(filePath, {
      bpm: Number(bpm.toFixed(6)),
      firstBeatMs: normalizedFirstBeatMs
    })
  }
  const filePaths = Array.from(analysisMap.keys())
  if (filePaths.length === 0) return { updated: 0 }

  try {
    let updated = 0
    const updateStmt = db.prepare(`UPDATE ${TABLE} SET info_json = ? WHERE id = ?`)
    const tx = db.transaction(() => {
      const CHUNK_SIZE = 300
      for (let offset = 0; offset < filePaths.length; offset += CHUNK_SIZE) {
        const chunk = filePaths.slice(offset, offset + CHUNK_SIZE)
        if (chunk.length === 0) continue
        const placeholders = chunk.map(() => '?').join(',')
        const rows = db
          .prepare(
            `SELECT id, file_path, info_json FROM ${TABLE} WHERE file_path IN (${placeholders})`
          )
          .all(...chunk) as Array<{ id: string; file_path: string; info_json?: string | null }>
        for (const row of rows) {
          const filePath = typeof row?.file_path === 'string' ? row.file_path.trim() : ''
          const nextAnalysis = analysisMap.get(filePath)
          if (!nextAnalysis) continue
          let info: Record<string, any> = {}
          if (row?.info_json) {
            try {
              const parsed = JSON.parse(String(row.info_json))
              if (parsed && typeof parsed === 'object') {
                info = parsed
              }
            } catch {}
          }
          const currentBpm = Number(info.bpm)
          const currentFirstBeatMs = Number(info.firstBeatMs)
          const normalizedCurrentBpm = Number.isFinite(currentBpm)
            ? Number(currentBpm.toFixed(6))
            : NaN
          const normalizedCurrentFirstBeatMs =
            Number.isFinite(currentFirstBeatMs) && currentFirstBeatMs >= 0
              ? Number(currentFirstBeatMs.toFixed(3))
              : 0
          if (
            normalizedCurrentBpm === nextAnalysis.bpm &&
            normalizedCurrentFirstBeatMs === nextAnalysis.firstBeatMs
          ) {
            continue
          }
          info.bpm = nextAnalysis.bpm
          info.firstBeatMs = nextAnalysis.firstBeatMs
          updateStmt.run(JSON.stringify(info), row.id)
          updated += 1
        }
      }
    })
    tx()
    return { updated }
  } catch (error) {
    log.error('[sqlite] mixtape bpm upsert failed', error)
    return { updated: 0 }
  }
}

export function upsertMixtapeItemGridByFilePath(
  entries: Array<{ filePath: string; barBeatOffset?: number; firstBeatMs?: number; bpm?: number }>
): { updated: number } {
  if (!Array.isArray(entries) || entries.length === 0) return { updated: 0 }
  const db = getLibraryDb()
  if (!db) return { updated: 0 }

  const normalizeBarBeatOffset = (value: number) => {
    const rounded = Math.round(Number(value) || 0)
    return ((rounded % 32) + 32) % 32
  }

  const normalizeFirstBeatMs = (value: number) => {
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric < 0) return 0
    return numeric
  }

  const normalizeBpm = (value: number) => {
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric <= 0) return 0
    return Number(numeric.toFixed(6))
  }

  const offsetMap = new Map<string, { barBeatOffset: number; firstBeatMs?: number; bpm?: number }>()
  for (const item of entries) {
    const filePath = typeof item?.filePath === 'string' ? item.filePath.trim() : ''
    if (!filePath) continue
    const normalizedOffset = normalizeBarBeatOffset(item?.barBeatOffset ?? 0)
    const hasFirstBeatMs = Number.isFinite(Number(item?.firstBeatMs))
    const normalizedBpm = normalizeBpm(Number(item?.bpm))
    const hasBpm = normalizedBpm > 0
    offsetMap.set(filePath, {
      barBeatOffset: normalizedOffset,
      firstBeatMs: hasFirstBeatMs ? normalizeFirstBeatMs(Number(item?.firstBeatMs)) : undefined,
      bpm: hasBpm ? normalizedBpm : undefined
    })
  }
  const filePaths = Array.from(offsetMap.keys())
  if (filePaths.length === 0) return { updated: 0 }

  try {
    let updated = 0
    const updateStmt = db.prepare(`UPDATE ${TABLE} SET info_json = ? WHERE id = ?`)
    const tx = db.transaction(() => {
      const CHUNK_SIZE = 300
      for (let offset = 0; offset < filePaths.length; offset += CHUNK_SIZE) {
        const chunk = filePaths.slice(offset, offset + CHUNK_SIZE)
        if (chunk.length === 0) continue
        const placeholders = chunk.map(() => '?').join(',')
        const rows = db
          .prepare(
            `SELECT id, file_path, info_json FROM ${TABLE} WHERE file_path IN (${placeholders})`
          )
          .all(...chunk) as Array<{ id: string; file_path: string; info_json?: string | null }>
        for (const row of rows) {
          const filePath = typeof row?.file_path === 'string' ? row.file_path.trim() : ''
          const nextGrid = offsetMap.get(filePath)
          if (!nextGrid) continue
          let info: Record<string, any> = {}
          if (row?.info_json) {
            try {
              const parsed = JSON.parse(String(row.info_json))
              if (parsed && typeof parsed === 'object') {
                info = parsed
              }
            } catch {}
          }
          const nextOffset = normalizeBarBeatOffset(nextGrid.barBeatOffset)
          const currentOffset = normalizeBarBeatOffset(Number(info.barBeatOffset) || 0)
          const currentFirstBeatMs = normalizeFirstBeatMs(Number(info.firstBeatMs) || 0)
          const currentBpm = normalizeBpm(Number(info.bpm) || 0)
          const hasNextFirstBeatMs = Number.isFinite(Number(nextGrid.firstBeatMs))
          const nextFirstBeatMs = hasNextFirstBeatMs
            ? normalizeFirstBeatMs(Number(nextGrid.firstBeatMs))
            : currentFirstBeatMs
          const hasNextBpm = Number.isFinite(Number(nextGrid.bpm)) && Number(nextGrid.bpm) > 0
          const nextBpm = hasNextBpm ? normalizeBpm(Number(nextGrid.bpm)) : currentBpm
          const offsetChanged = currentOffset !== nextOffset
          const firstBeatChanged =
            hasNextFirstBeatMs && Math.abs(currentFirstBeatMs - nextFirstBeatMs) > 0.0001
          const bpmChanged = hasNextBpm && Math.abs(currentBpm - nextBpm) > 0.0001
          if (!offsetChanged && !firstBeatChanged && !bpmChanged) continue
          info.barBeatOffset = nextOffset
          if (hasNextFirstBeatMs) {
            info.firstBeatMs = nextFirstBeatMs
          }
          if (hasNextBpm) {
            info.bpm = nextBpm
          }
          updateStmt.run(JSON.stringify(info), row.id)
          updated += 1
        }
      }
    })
    tx()
    return { updated }
  } catch (error) {
    log.error('[sqlite] mixtape grid upsert failed', error)
    return { updated: 0 }
  }
}

export function upsertMixtapeItemGainEnvelopeById(
  entries: Array<{ itemId: string; gainEnvelope: Array<{ sec: number; gain: number }> }>
): { updated: number } {
  if (!Array.isArray(entries) || entries.length === 0) return { updated: 0 }
  const db = getLibraryDb()
  if (!db) return { updated: 0 }

  const normalizeEnvelope = (raw: unknown) => {
    const points = Array.isArray(raw)
      ? raw
          .map((item) => {
            const sec = Number((item as any)?.sec)
            const gain = Number((item as any)?.gain)
            if (!Number.isFinite(sec) || sec < 0) return null
            if (!Number.isFinite(gain) || gain <= 0) return null
            return {
              sec: Number(sec.toFixed(4)),
              gain: Number(gain.toFixed(6))
            }
          })
          .filter(Boolean)
      : []
    if (!points.length) return [] as Array<{ sec: number; gain: number }>
    const sorted = (points as Array<{ sec: number; gain: number }>).sort((a, b) => a.sec - b.sec)
    const unique: Array<{ sec: number; gain: number }> = []
    for (const point of sorted) {
      const last = unique[unique.length - 1]
      if (!last || Math.abs(last.sec - point.sec) > 0.0001) {
        unique.push(point)
      } else {
        last.gain = point.gain
      }
    }
    return unique
  }

  const envelopeById = new Map<string, Array<{ sec: number; gain: number }>>()
  for (const item of entries) {
    const itemId = typeof item?.itemId === 'string' ? item.itemId.trim() : ''
    if (!itemId) continue
    const normalizedEnvelope = normalizeEnvelope(item?.gainEnvelope)
    if (normalizedEnvelope.length < 2) continue
    envelopeById.set(itemId, normalizedEnvelope)
  }
  const itemIds = Array.from(envelopeById.keys())
  if (!itemIds.length) return { updated: 0 }

  try {
    let updated = 0
    const updateStmt = db.prepare(`UPDATE ${TABLE} SET info_json = ? WHERE id = ?`)
    const tx = db.transaction(() => {
      const CHUNK_SIZE = 300
      for (let offset = 0; offset < itemIds.length; offset += CHUNK_SIZE) {
        const chunk = itemIds.slice(offset, offset + CHUNK_SIZE)
        if (chunk.length === 0) continue
        const placeholders = chunk.map(() => '?').join(',')
        const rows = db
          .prepare(`SELECT id, info_json FROM ${TABLE} WHERE id IN (${placeholders})`)
          .all(...chunk) as Array<{ id: string; info_json?: string | null }>
        for (const row of rows) {
          const itemId = typeof row?.id === 'string' ? row.id.trim() : ''
          if (!itemId) continue
          const nextEnvelope = envelopeById.get(itemId)
          if (!nextEnvelope || nextEnvelope.length < 2) continue
          let info: Record<string, any> = {}
          if (row?.info_json) {
            try {
              const parsed = JSON.parse(String(row.info_json))
              if (parsed && typeof parsed === 'object') {
                info = parsed
              }
            } catch {}
          }
          const currentEnvelope = normalizeEnvelope(info.gainEnvelope)
          const currentSignature = JSON.stringify(currentEnvelope)
          const nextSignature = JSON.stringify(nextEnvelope)
          if (currentSignature === nextSignature) continue
          info.gainEnvelope = nextEnvelope
          info.gainEnvelopeUpdatedAt = Date.now()
          updateStmt.run(JSON.stringify(info), itemId)
          updated += 1
        }
      }
    })
    tx()
    return { updated }
  } catch (error) {
    log.error('[sqlite] mixtape gain envelope upsert failed', error)
    return { updated: 0 }
  }
}

export function removeMixtapeItemsByPlaylist(playlistUuid: string): { removed: number } {
  if (!playlistUuid) return { removed: 0 }
  const db = getLibraryDb()
  if (!db) return { removed: 0 }
  try {
    const del = db.prepare(`DELETE FROM ${TABLE} WHERE playlist_uuid = ?`)
    const info = del.run(playlistUuid)
    return { removed: Number(info?.changes || 0) }
  } catch (error) {
    log.error('[sqlite] mixtape remove by playlist failed', error)
    return { removed: 0 }
  }
}
